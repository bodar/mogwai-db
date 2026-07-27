// The shape lattice: which step may follow which, and what shape it yields.
//
// Gremlin's string form is far looser than Gremlin's type discipline. The grammar's
// `chainedTraversal: traversalMethod (DOT traversalMethod)*` admits `count().out()` — syntactically
// fine, semantically nonsense — so generating from `Gremlin.g4` alone would spend its budget on
// noise. The real constraint is `Traversal<S,E>`: a step's legality depends on the SHAPE of the
// stream it is applied to. That is the same fact the compiler encodes as its `Stream` union
// (element/scalar/list/record/…, src/compiler/steps/context/stream.ts) with a per-shape dispatch
// table each (TAIL, SCALAR_TAIL, LIST_TAIL, RECORD_TAIL, …). So: state = shape, transition = step.
//
// WHY THIS TABLE IS HAND-WRITTEN AND NOT REFLECTED OUT OF THOSE DISPATCH MAPS.
// Deriving it from the compiler's own Maps would keep it permanently in sync, and would also make
// it useless: validity would be *defined* as "what the compiler already supports", so a generated
// traversal could never be a valid-but-unsupported one — and those are exactly the findings worth
// having (test/CLAUDE.md's "ceiling"). This table is therefore an INDEPENDENT statement of
// Gremlin's typing, and `table.test.ts` cross-checks it against the dispatch maps so it cannot
// silently rot: a step in a shape's Map that the table doesn't know is a table gap to fill, and a
// transition the compiler declines is a deferral to record, not a generator bug.
//
// VERTEX AND EDGE ARE SEPARATE SHAPES. The compiler carries both as an `ElementStream` with an
// `elem` discriminator, but they are NOT interchangeable in Gremlin's typing: `out()/outE()` need a
// vertex, `outV()/otherV()` need an edge, and their property vocabularies differ. Collapsing them
// into one "element" state is how a first draft of this table generated `g.E().bothE()` — invalid
// Gremlin that the generator then blamed on the compiler. The shared steps (filters, ordering,
// branches, most projections) are built ONCE by `elementSteps` and specialised per kind, so the
// split costs no duplication.
//
// Scope of v1: the read surface reachable from V()/E(), which is where all six fast paths live. No
// writes (the differential seeds its own graph), no sacks, no side effects.

/** A stream shape — the generator's state. */
export type Shape = 'vertex' | 'edge' | 'scalar' | 'list' | 'record' | 'group' | 'path';

/** Where a transition leaves the stream. `'inherit'` means "the shape that was folded into this
 *  list" — `unfold()` is the one step whose output shape is not a function of its input shape
 *  alone, so the walker remembers what `fold()` consumed and restores it (the
 *  `V().fold().unfold().out()` retype in steps/CLAUDE.md). */
export type Target = Shape | 'inherit';

/** One legal transition: a step, what it does to the shape, and (if it takes a child traversal)
 *  the shape its body starts from. */
export interface Transition {
  /** Step name, for cross-checking against the compiler's dispatch maps. */
  readonly name: string;
  readonly to: Target;
  /** Render the step source, given already-rendered child bodies and a literal picker. */
  readonly render: (ctx: RenderCtx) => string;
  /** Input shape of each child body this step needs. Empty/absent = no child traversal. */
  readonly bodies?: readonly Shape[];
  /** A reducer: legal, but the generator stops after it rather than piling steps onto a scalar
   *  aggregate, which produces absurd rather than interesting traversals. */
  readonly terminal?: boolean;
}

export interface RenderCtx {
  /** Already-rendered child bodies, in `bodies` order, each a `__.…` string. */
  readonly bodies: readonly string[];
  /** Pick one of `options` from the generator's own randomness (a recorded, shrinkable draw). */
  readonly pick: <T>(options: readonly T[]) => T;
}

// The reference "modern" graph's own vocabulary — generating over keys/labels that EXIST is what
// makes a generated traversal return rows rather than trivially empty ones (an empty result on both
// sides is a vacuous pass, so the property tests track how many actually produced rows).
export const V_LABELS = ['person', 'software'] as const;
export const E_LABELS = ['knows', 'created'] as const;
export const V_KEYS = ['name', 'age', 'lang'] as const;
export const E_KEYS = ['weight'] as const;
export const NUMBERS = [0, 1, 2, 29, 30, 35] as const;
/** Keys a `select()` over a record might name: the labels `project()` binds, plus real property
 *  keys (a `select` naming an absent key is valid Gremlin — it just drops the traverser). */
const RECORD_KEYS = ['a', 'b', ...V_KEYS] as const;

const lit = (s: string) => `'${s}'`;

/**
 * The steps that mean the same thing on a vertex and on an edge — filters, ordering/slicing,
 * branches, loops, and the shape-changing projections. `kind` picks the property vocabulary and the
 * shape these return to (a filter on an edge stream yields an edge stream, not a vertex one), so
 * one definition serves both without either drifting from the other.
 */
function elementSteps(kind: 'vertex' | 'edge'): Transition[] {
  const self: Shape = kind;
  const keys = kind === 'vertex' ? V_KEYS : E_KEYS;
  const labels = kind === 'vertex' ? V_LABELS : E_LABELS;
  return [
    // ---- filters
    { name: 'hasLabel', to: self, render: (c) => `hasLabel(${lit(c.pick(labels))})` },
    { name: 'has', to: self, render: (c) => `has(${lit(c.pick(keys))})` },
    { name: 'hasId', to: self, render: (c) => `hasId(${c.pick([1, 2, 4, 7, 9])})` },
    { name: 'identity', to: self, render: () => 'identity()' },
    { name: 'dedup', to: self, render: () => 'dedup()' },

    // ---- filters with a child body: the predicateInlining surface
    { name: 'where', to: self, bodies: [self], render: (c) => `where(${c.bodies[0]})` },
    { name: 'filter', to: self, bodies: [self], render: (c) => `filter(${c.bodies[0]})` },
    { name: 'not', to: self, bodies: [self], render: (c) => `not(${c.bodies[0]})` },
    { name: 'and', to: self, bodies: [self, self], render: (c) => `and(${c.bodies[0]}, ${c.bodies[1]})` },
    { name: 'or', to: self, bodies: [self, self], render: (c) => `or(${c.bodies[0]}, ${c.bodies[1]})` },

    // ---- branches: one arm triage, four merges (src/compiler/steps/CLAUDE.md)
    { name: 'union', to: self, bodies: [self, self], render: (c) => `union(${c.bodies[0]}, ${c.bodies[1]})` },
    { name: 'coalesce', to: self, bodies: [self, self], render: (c) => `coalesce(${c.bodies[0]}, ${c.bodies[1]})` },
    { name: 'optional', to: self, bodies: [self], render: (c) => `optional(${c.bodies[0]})` }, // singleHopOptional
    { name: 'local', to: self, bodies: [self], render: (c) => `local(${c.bodies[0]})` },

    // ---- ordering / slicing: the positional consumers that make the emission-order encounter live
    { name: 'order', to: self, render: (c) => `order().by(${lit(c.pick(keys))}${c.pick(['', ', asc', ', desc'])})` },
    { name: 'limit', to: self, render: (c) => `limit(${c.pick([1, 2, 3])})` },
    { name: 'skip', to: self, render: (c) => `skip(${c.pick([1, 2])})` },
    { name: 'range', to: self, render: () => 'range(0, 2)' },
    { name: 'tail', to: self, render: (c) => `tail(${c.pick([1, 2])})` },

    // ---- projections
    { name: 'values', to: 'scalar', render: (c) => `values(${lit(c.pick(keys))})` },
    { name: 'id', to: 'scalar', render: () => 'id()' },
    { name: 'label', to: 'scalar', render: () => 'label()' },
    { name: 'count', to: 'scalar', render: () => 'count()', terminal: true }, // bulkRepeatCount
    { name: 'fold', to: 'list', render: () => 'fold()' },
    { name: 'path', to: 'path', render: () => 'path()' },
    { name: 'valueMap', to: 'record', render: () => 'valueMap()' },
    { name: 'elementMap', to: 'record', render: () => 'elementMap()' },
    { name: 'project', to: 'record', bodies: [self, self], render: (c) => `project('a', 'b').by(${c.bodies[0]}).by(${c.bodies[1]})` },
    { name: 'group', to: 'group', render: (c) => `group().by(${lit(c.pick(keys))})` },
    { name: 'groupCount', to: 'group', render: (c) => `groupCount().by(${lit(c.pick(keys))})` },
  ];
}

// ---------- vertex ----------
const VERTEX: Transition[] = [
  ...elementSteps('vertex'),
  // movement OFF a vertex — the family movementCollapse optimizes
  { name: 'out', to: 'vertex', render: (c) => `out(${c.pick(['', ...E_LABELS.map(lit)])})` },
  { name: 'in', to: 'vertex', render: (c) => `in(${c.pick(['', ...E_LABELS.map(lit)])})` },
  { name: 'both', to: 'vertex', render: (c) => `both(${c.pick(['', ...E_LABELS.map(lit)])})` },
  { name: 'outE', to: 'edge', render: (c) => `outE(${c.pick(['', ...E_LABELS.map(lit)])})` },
  { name: 'inE', to: 'edge', render: (c) => `inE(${c.pick(['', ...E_LABELS.map(lit)])})` },
  { name: 'bothE', to: 'edge', render: (c) => `bothE(${c.pick(['', ...E_LABELS.map(lit)])})` },
  // vertex-only value filters
  { name: 'has', to: 'vertex', render: (c) => `has(${lit('name')}, ${lit(c.pick(['marko', 'josh', 'lop', 'ripple']))})` },
  { name: 'has', to: 'vertex', render: (c) => `has(${lit('age')}, P.${c.pick(['gt', 'lt', 'gte', 'lte'])}(${c.pick(NUMBERS)}))` },
  // ftsSubstringPredicate: a >=3-char substring over a stored prop takes the trigram index, a
  // <3-char one always takes LIKE — generate both so the differential covers that boundary.
  { name: 'has', to: 'vertex', render: (c) => `has(${lit('name')}, TextP.${c.pick(['containing', 'startingWith', 'endingWith'])}(${lit(c.pick(['a', 'mar', 'ko', 'lop']))}))` },
  // path-sensitive filters need a vertex walk to be meaningful
  { name: 'simplePath', to: 'vertex', render: () => 'simplePath()' },
  { name: 'cyclicPath', to: 'vertex', render: () => 'cyclicPath()' },
  // repeat() has NO artificial depth cap (CLAUDE.md) — a cyclic body without simplePath() is
  // infinite per the spec, so every generated loop is bounded by times().
  { name: 'repeat', to: 'vertex', bodies: ['vertex'], render: (c) => `repeat(${c.bodies[0]}).times(${c.pick([1, 2])})` },
];

// ---------- edge ----------
const EDGE: Transition[] = [
  ...elementSteps('edge'),
  // movement OFF an edge — only the incident-vertex forms are legal here
  { name: 'outV', to: 'vertex', render: () => 'outV()' },
  { name: 'inV', to: 'vertex', render: () => 'inV()' },
  { name: 'bothV', to: 'vertex', render: () => 'bothV()' },
  { name: 'otherV', to: 'vertex', render: () => 'otherV()' },
  { name: 'has', to: 'edge', render: (c) => `has(${lit('weight')}, P.${c.pick(['gt', 'lt', 'gte', 'lte'])}(${c.pick([0.2, 0.4, 0.5, 1.0])}))` },
];

// ---------- scalar ----------
const SCALAR: Transition[] = [
  { name: 'is', to: 'scalar', render: (c) => `is(P.${c.pick(['gt', 'lt', 'gte', 'lte', 'eq', 'neq'])}(${c.pick(NUMBERS)}))` },
  { name: 'dedup', to: 'scalar', render: () => 'dedup()' },
  { name: 'order', to: 'scalar', render: (c) => `order()${c.pick(['', '.by(asc)', '.by(desc)'])}` },
  { name: 'limit', to: 'scalar', render: (c) => `limit(${c.pick([1, 2, 3])})` },
  { name: 'skip', to: 'scalar', render: (c) => `skip(${c.pick([1, 2])})` },
  { name: 'tail', to: 'scalar', render: (c) => `tail(${c.pick([1, 2])})` },
  { name: 'count', to: 'scalar', render: () => 'count()', terminal: true },
  { name: 'sum', to: 'scalar', render: () => 'sum()', terminal: true },
  { name: 'min', to: 'scalar', render: () => 'min()', terminal: true },
  { name: 'max', to: 'scalar', render: () => 'max()', terminal: true },
  { name: 'mean', to: 'scalar', render: () => 'mean()', terminal: true },
  { name: 'fold', to: 'list', render: () => 'fold()' },
  // scalarPredicateInlining: a boolean combinator over a scalar stream
  { name: 'where', to: 'scalar', bodies: ['scalar'], render: (c) => `where(${c.bodies[0]})` },
  { name: 'filter', to: 'scalar', bodies: ['scalar'], render: (c) => `filter(${c.bodies[0]})` },
  { name: 'not', to: 'scalar', bodies: ['scalar'], render: (c) => `not(${c.bodies[0]})` },
  { name: 'and', to: 'scalar', bodies: ['scalar', 'scalar'], render: (c) => `and(${c.bodies[0]}, ${c.bodies[1]})` },
  { name: 'or', to: 'scalar', bodies: ['scalar', 'scalar'], render: (c) => `or(${c.bodies[0]}, ${c.bodies[1]})` },
];

// ---------- list / record / group / path ----------
// Deliberately thin in v1: enough to be reached and re-typed out of, not full coverage of each.
const LIST: Transition[] = [
  { name: 'count', to: 'scalar', render: () => 'count(local)', terminal: true },
  { name: 'order', to: 'list', render: () => 'order(local)' },
  { name: 'sum', to: 'scalar', render: () => 'sum(local)', terminal: true },
  { name: 'min', to: 'scalar', render: () => 'min(local)', terminal: true },
  { name: 'max', to: 'scalar', render: () => 'max(local)', terminal: true },
  // the documented retype: unfold() restores whatever fold() consumed
  { name: 'unfold', to: 'inherit', render: () => 'unfold()' },
];
const RECORD: Transition[] = [
  { name: 'select', to: 'scalar', render: (c) => `select(${lit(c.pick(RECORD_KEYS))})` },
  { name: 'count', to: 'scalar', render: () => 'count()', terminal: true },
  { name: 'dedup', to: 'record', render: () => 'dedup()' },
  { name: 'limit', to: 'record', render: (c) => `limit(${c.pick([1, 2])})` },
  { name: 'fold', to: 'list', render: () => 'fold()' },
];
const GROUP: Transition[] = [
  { name: 'unfold', to: 'record', render: () => 'unfold()' },
  { name: 'count', to: 'scalar', render: () => 'count()', terminal: true },
  { name: 'select', to: 'scalar', render: (c) => `select(${lit(c.pick(['keys', 'values']))})` },
];
const PATH: Transition[] = [
  { name: 'count', to: 'scalar', render: () => 'count(local)', terminal: true },
  { name: 'limit', to: 'path', render: (c) => `limit(${c.pick([1, 2])})` },
  { name: 'dedup', to: 'path', render: () => 'dedup()' },
  { name: 'unfold', to: 'scalar', render: () => 'unfold()' },
];

/** The lattice: shape → the steps legal on it. This IS the confinement the generator walks. */
export const TRANSITIONS: Readonly<Record<Shape, readonly Transition[]>> = Object.freeze({
  vertex: VERTEX, edge: EDGE, scalar: SCALAR, list: LIST, record: RECORD, group: GROUP, path: PATH,
});

export const SHAPES = Object.keys(TRANSITIONS) as Shape[];

/** Traversal sources, and the shape each one starts in. */
export const SOURCES: readonly { readonly render: (c: RenderCtx) => string; readonly to: Shape }[] = [
  { render: () => 'V()', to: 'vertex' },
  { render: (c) => `V(${c.pick([1, 2, 4, 6])})`, to: 'vertex' },
  { render: () => 'E()', to: 'edge' },
  { render: (c) => `V().hasLabel(${lit(c.pick(V_LABELS))})`, to: 'vertex' },
];

/** Every step name the table can emit, per shape — the input to the cross-check against the
 *  compiler's own dispatch maps (`table.test.ts`). */
export const namesByShape = (): Record<Shape, Set<string>> =>
  Object.fromEntries(SHAPES.map((s) => [s, new Set(TRANSITIONS[s].map((t) => t.name))])) as Record<Shape, Set<string>>;
