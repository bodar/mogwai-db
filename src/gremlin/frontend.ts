import { CharStream, CommonTokenStream, BaseErrorListener, ParserRuleContext } from 'antlr4ng';
import { GremlinLexer } from '../../parser/GremlinLexer.ts';
import { GremlinParser } from '../../parser/GremlinParser.ts';
import { flatType, fitsSafeInteger, BigDecimal, Duration, type TypeNode, type CanonicalType, type MapEntryType } from './types.ts';

// ---------- parsing ----------
//
// The thin front-end (locked decision #5): the generated ANTLR parse tree in,
// the own IR (`Step[]` — {name, args}) out. Consumes zero compiler/SQL concepts,
// so if the wire format changes only this module moves. The compiler consumes
// `Step[]`; it never touches antlr4ng.

class Errors extends BaseErrorListener {
  errors: string[] = [];
  override syntaxError(_r: any, _s: any, line: number, col: number, msg: string) {
    this.errors.push(`${line}:${col} ${msg}`);
  }
}

export function parseGremlin(query: string) {
  const lexer = new GremlinLexer(CharStream.fromString(query));
  const parser = new GremlinParser(new CommonTokenStream(lexer));
  const errs = new Errors();
  lexer.removeErrorListeners(); parser.removeErrorListeners();
  lexer.addErrorListener(errs); parser.addErrorListener(errs);
  const tree = parser.queryList();
  if (errs.errors.length) throw new Error(`Gremlin parse error: ${errs.errors.join('; ')}`);
  return tree;
}

// ---------- step extraction ----------

// ---------- Arg: a step argument as ONE object, value + type + name together ----------
//
// A step argument is a value, its canonical Gremlin type, and — when the client sent it as a wire
// parameter — its name. These three were once three PARALLEL arrays on `Step` (`args`/`argTypes`/
// `paramNames`), index-locked by hand: every site that filtered or reordered arguments had to
// re-thread all three "in lockstep", and one that forgot (`flattenListArgs`) silently desynced the
// metadata from the value. `Arg` fuses them so the coupling is structural — reorder/filter/flatten
// an `Arg[]` and the type and name ride along for free.
//
// This is TinkerPop 4's `GValue` (`vendor/tinkerpop/gremlin-core/.../step/GValue.java`): a name→value
// pair where `name != null` means the client declared a VARIABLE and `name == null` means a value
// provided literally in the traversal. We carry the canonical `type` alongside (the truth a resolved
// JS value can't spell — a `5L` long vs a `5` int). It is an IR fact ABOUT the argument, not a
// wire-format concept leaking in (root CLAUDE.md #5), exactly as the parallel `argTypes` array was.
export interface Arg {
  /** The resolved value: a scalar, a tagged token (`{scope}`/`{token}`/…), a `Pred`, a `{nested}`
   *  traversal, a JS Map/Set, or a bracketed-list array. A parameter still exposes its resolved
   *  value here — `name` is the only thing that marks it variable, it is not opaque. */
  readonly value: any;
  /** The canonical Gremlin type of `value` as its carrying channel declared it — a parsed literal's
   *  subtype (numeric suffix, string, boolean, datetime, uuid, list, map) or, for a bound-param
   *  reference, the wire DataType the client serialized. `null` when the channel said nothing (the
   *  JSON request path), so the write seam infers from the JS value. Read by bare `asNumber()`/
   *  `asDate()` and by the write seam (to store `vertex_properties`/`edge_properties.vtype`). */
  readonly type: TypeNode | null;
  /** The WIRE PARAMETER NAME (`$x` in the `bindings`/`parameters` map), TinkerPop's `GValue.name`:
   *  non-null ⇒ a user PARAMETER (binds as `?`, spends one of the 100-parameter budget), `null` ⇒ a
   *  parsed literal (a constant the compiler inlines). The one fact the bind-vs-inline seam reads. */
  readonly name: string | null;
  /** For a bracketed collection LITERAL (`[a, b]` / `{a, b}`) ONLY: its members, each as its own
   *  `Arg` (value + captured type + wire-parameter name). `value` still holds the raw JS array/`Set`
   *  so every DATA consumer reads a collection exactly as before; `members` rides ALONGSIDE for the
   *  two lowering seams that individually lower a member — a predicate IN-list (`within([$x])`) and
   *  `inject([…])` — so a `$x` member BINDS and keeps its type, with no parallel `values`/`items`/names
   *  triple. Absent (`undefined`) on every other arg, including a bound list-PARAM (`within($list)`),
   *  whose whole array is ONE oversized param, not N members — that asymmetry is exactly what tells the
   *  two apart. Built only by `collectionArg`, which derives `value`/`type`/`members` together. */
  readonly members?: readonly Arg[];
}

/** Build an `Arg`. `type`/`name` default to null — a synthetic step argument (compiler-minted, no
 *  wire provenance) is a plain value with neither, and no `members` (not a collection literal). */
export const arg = (value: any, type: TypeNode | null = null, name: string | null = null): Arg => ({ value, type, name });

/** Build a collection-LITERAL `Arg` from its member `Arg`s. Derives all three views in ONE place so
 *  they cannot desync: `value` is the raw wire/storage form (a JS array for a list, a JS `Set` for a
 *  set) that every data consumer reads; `type` is the container node whose `items` ARE the members'
 *  types (no separate parallel array); `members` carries each element's value+type+name for the
 *  predicate/inject seams that bind a `$x` member. A collection literal is the only arg with members. */
export const collectionArg = (kind: 'list' | 'set', members: readonly Arg[]): Arg => {
  const values = members.map((m) => m.value);
  return { value: kind === 'set' ? new Set(values) : values, type: { t: kind, items: members.map((m) => m.type) }, name: null, members };
};

/** The plain resolved values of a step's arguments, dropping the type/name metadata — for the
 *  consumers that genuinely want a value array (a varargs spread, `flattenListArgs`). Prefer reading
 *  `step.args[i].value` at a single index; this is for whole-array value use. */
export const argValues = (step: { args: readonly Arg[] }): any[] => step.args.map((a) => a.value);

export interface Step {
  name: string;
  /** The step's arguments, each a value+type+name object (see `Arg`). Was three parallel arrays. */
  args: Arg[];
  ctx: ParserRuleContext;
  /** `repeat(name, body)` has the same body channel as `repeat(body)`; its name
   * remains explicit metadata for the lowering that owns named loop counters. */
  loopName?: string;
}

// ---------- tagged non-value arguments ----------
//
// The grammar has a small family of enum-like arguments that are neither Gremlin
// values nor nested traversals.  Keeping them as one declared union prevents a
// consumer from treating an arbitrary object as a token merely because it happens
// to have a similarly named key.  `Step.args` intentionally remains `any[]`: it is
// the front-end/compiler boundary and values may be supplied by any GLV.  Consumers
// narrow through these guards instead of open-coding `'token' in arg`.
export type TaggedArg =
  | { readonly order: string }
  | { readonly pop: string }
  | { readonly column: string }
  | { readonly token: string }
  | { readonly direction: string }
  | { readonly merge: string }
  /** A bare Cardinality token, or its value-bearing form used inside a map.
   * `Cardinality.set(v)` is TinkerPop's CardinalityValueTraversal: its cardinality
   * overrides a map/default cardinality for this one property. */
  | { readonly cardinality: string; readonly value?: any }
  | { readonly gtype: string }
  | { readonly pick: string }
  | { readonly withOption: string }
  | { readonly dt: string }
  | { readonly operator: string }
  | { readonly scope: string }
  | { readonly nested: any };

type TaggedKey = 'order' | 'pop' | 'column' | 'token' | 'direction' | 'merge' | 'cardinality'
  | 'gtype' | 'pick' | 'withOption' | 'dt' | 'operator' | 'scope' | 'nested';

const tagged = <K extends TaggedKey>(arg: unknown, key: K): arg is Extract<TaggedArg, Record<K, unknown>> =>
  arg !== null && typeof arg === 'object' && key in arg;

export const isOrderArg = (arg: unknown): arg is Extract<TaggedArg, { order: string }> => tagged(arg, 'order');
export const isPopArg = (arg: unknown): arg is Extract<TaggedArg, { pop: string }> => tagged(arg, 'pop');
export const isColumnArg = (arg: unknown): arg is Extract<TaggedArg, { column: string }> => tagged(arg, 'column');
export const isTokenArg = (arg: unknown): arg is Extract<TaggedArg, { token: string }> => tagged(arg, 'token');
export const isDirectionArg = (arg: unknown): arg is Extract<TaggedArg, { direction: string }> => tagged(arg, 'direction');
export const isMergeArg = (arg: unknown): arg is Extract<TaggedArg, { merge: string }> => tagged(arg, 'merge');
export const isCardinalityArg = (arg: unknown): arg is Extract<TaggedArg, { cardinality: string }> => tagged(arg, 'cardinality');
export const isCardinalityValueArg = (arg: unknown): arg is { readonly cardinality: string; readonly value: any } =>
  isCardinalityArg(arg) && 'value' in arg;
export const isGTypeArg = (arg: unknown): arg is Extract<TaggedArg, { gtype: string }> => tagged(arg, 'gtype');
export const isPickArg = (arg: unknown): arg is Extract<TaggedArg, { pick: string }> => tagged(arg, 'pick');
export const isWithOptionArg = (arg: unknown): arg is Extract<TaggedArg, { withOption: string }> => tagged(arg, 'withOption');

/** `IO.*` → the string the JS GLV serializes it to (its `IO` class getters, verbatim). The two
 *  option KEYS are namespaced tokens; the three format names are bare. */
const IO_OPTION_STRINGS: Record<string, string> = {
  reader: '~tinkerpop.io.reader',
  writer: '~tinkerpop.io.writer',
  registry: '~tinkerpop.io.registry',
  graphson: 'graphson',
  gryo: 'gryo',
  graphml: 'graphml',
};
export const isDtArg = (arg: unknown): arg is Extract<TaggedArg, { dt: string }> => tagged(arg, 'dt');
export const isOperatorArg = (arg: unknown): arg is Extract<TaggedArg, { operator: string }> => tagged(arg, 'operator');
export const isScopeArg = (arg: unknown): arg is Extract<TaggedArg, { scope: string }> => tagged(arg, 'scope');

/** A GType token or its string spelling, normalized for consumers that accept both. */
export const gtypeName = (arg: unknown): string | null =>
  isGTypeArg(arg) ? arg.gtype : typeof arg === 'string' ? arg : null;

// Numeric-literal suffix → subtype. A bare integer is the *narrowest* Java integral
// type that can represent it (int → long → BigInteger), matching TinkerPop's
// GenericLiteralVisitor. That range decision is part of the wire contract: calling a
// large literal an int reaches GraphBinary's strict Int serializer long after parsing.
const INT_LIT_SUFFIX: Record<string, CanonicalType> = { b: 'byte', s: 'short', i: 'int', l: 'long', n: 'bigint' };
const FLOAT_LIT_SUFFIX: Record<string, CanonicalType> = { f: 'float', d: 'double', m: 'bigdecimal' };
const INT_RANGES: Record<'byte' | 'short' | 'int' | 'long', readonly [bigint, bigint]> = {
  byte: [-128n, 127n],
  short: [-32768n, 32767n],
  int: [-2147483648n, 2147483647n],
  long: [-9223372036854775808n, 9223372036854775807n],
};

/** Parse Gremlin/Java integral spellings exactly enough to decide their canonical
 * type without first losing precision to JS Number. `Integer.decode` semantics mean
 * a leading zero is octal and `0x` is hexadecimal; signs apply outside the radix. */
function integralLiteral(text: string): bigint {
  let s = text.replace(/_/g, '');
  if (INT_LIT_SUFFIX[s.slice(-1).toLowerCase()]) s = s.slice(0, -1);
  let sign = 1n;
  if (s[0] === '+' || s[0] === '-') { if (s[0] === '-') sign = -1n; s = s.slice(1); }
  if (/^0[xX]/.test(s)) return sign * BigInt(`0x${s.slice(2)}`);
  if (s.length > 1 && s[0] === '0') return sign * BigInt(`0o${s.slice(1)}`);
  return sign * BigInt(s);
}

const intLitType = (text: string): CanonicalType => {
  const explicit = INT_LIT_SUFFIX[text.slice(-1).toLowerCase()];
  const n = integralLiteral(text);
  if (explicit) {
    if (explicit !== 'bigint') {
      const [min, max] = INT_RANGES[explicit as keyof typeof INT_RANGES];
      if (n < min || n > max) throw new Error(`${explicit} literal out of range: ${text}`);
    }
    return explicit;
  }
  if (n >= INT_RANGES.int[0] && n <= INT_RANGES.int[1]) return 'int';
  if (n >= INT_RANGES.long[0] && n <= INT_RANGES.long[1]) return 'long';
  return 'bigint';
};
const floatLitType = (text: string): CanonicalType => FLOAT_LIT_SUFFIX[text.slice(-1).toLowerCase()] ?? 'double';

/** An integral literal's JS value AND canonical type, from its source text.
 *
 *  Exported because Gremlin is not the only grammar that spells these: `GQL.g4`'s MATCH-pattern
 *  literals are specified to follow Gremlin's type system exactly ("no suffix defaults to smallest
 *  fitting type"), so `gql.ts` reads them through this rather than re-deriving the rules. Two
 *  spellings of the same contract is how the two would drift.
 *
 *  long/bigint stay a JS number WHILE they fit ±2^53 exactly (keeps numeric storage class, native
 *  index usage, and existing V()/has()/id consumers that expect number); only the genuinely-big
 *  tail becomes BigInt, which every bind seam normalizes. */
export function integerLiteralValue(text: string): { value: number | bigint; type: CanonicalType } {
  const type = intLitType(text);
  const b = integralLiteral(text);
  if (type === 'long' || type === 'bigint') return { value: fitsSafeInteger(b) ? Number(b) : b, type };
  return { value: Number(b), type };
}

/** A floating literal's JS value AND canonical type. `bigdecimal` (`m` suffix) carries EXACT via a
 *  BigDecimal parsed from the text — parseFloat would collapse it to a lossy f64. Exported for the
 *  same reason as its integral sibling above. */
export function floatLiteralValue(text: string): { value: number | BigDecimal; type: CanonicalType } {
  const type = floatLitType(text);
  if (type === 'bigdecimal') return { value: BigDecimal.fromText(text.replace(/[mM]$/, '')), type };
  return { value: parseFloat(text), type };
}

/** Flatten any bracketed-list arguments back to varargs (depth 1). Collection
 *  literals now parse as one array value (see walkArgs); the varargs-style steps
 *  that spread a Collection id/value in TinkerPop — V/E/hasId (`hasId(1,[2,6])` ≡
 *  `hasId(1,2,6)`, HasIdStep flattens every Collection arg) and, until the list
 *  substrate lands, inject — call this so their existing per-value handling is
 *  unchanged. Non-array args (scalars, predicates, maps) pass through. */
export const flattenListArgs = (args: any[]): any[] =>
  args.flatMap((a) => (Array.isArray(a) ? a : [a]));

export const stepName = (cls: string, prefix: string) =>
  cls.startsWith(prefix) && cls.endsWith('Context')
    ? cls.slice(prefix.length, -'Context'.length).split('_')[0]
    : null;

/** Collect the top-level step chain (does not descend into nested traversal args).
 *  `paramTypes` names the wire DataType of each bound param (from wire.ts) so a
 *  param-resolved arg records the right canonical type on its Arg. */
export function stepChain(tree: any, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Step[] {
  // A nested-traversal arg's payload (`{nested}`) is normally an ANTLR
  // NestedTraversalContext, lowered lazily here. But a TraversalStrategy rewrite
  // (strategies.ts) synthesizes filter bodies that have NO parse tree — it stores an
  // already-lowered `Step[]` as the payload instead. stepChain is the single choke point
  // every nested-body consumer (where/branch/by/child/write) resolves through, so making
  // it idempotent on a Step[] lets a synthetic body flow through the WHOLE compiler
  // identically to a parsed one — the substrate that lets strategy injection recurse into
  // any nested body. A real parse tree is never an array, so the guard is unambiguous.
  if (Array.isArray(tree)) return tree;
  const steps: Step[] = [];
  const visit = (node: any, insideNested: boolean) => {
    const cls = node.constructor.name;
    // withStrategies/withoutStrategies are a source-configuration boundary, not
    // steps — their subtree (which may hold a criterion traversal, e.g.
    // SubgraphStrategy(vertices: __.has(...))) is consumed by extractStrategies. Do
    // NOT harvest steps from it, or the criterion's has()/out() would leak into the
    // main chain as bogus source steps.
    if (cls.startsWith('TraversalSourceSelfMethod')) return;
    const name = stepName(cls, 'TraversalSourceSpawnMethod_') ?? stepName(cls, 'TraversalMethod_');
    if (!insideNested && name) {
      const args = extractArgs(node, params, paramTypes);
      // The grammar deliberately exposes the named repeat overload as
      // repeat(name, body), while every repeat consumer needs one uniform body
      // channel. Canonicalize that overload at the front-end boundary and retain
      // the public loop name as metadata; lowerers can therefore either implement
      // named loop counters or reject them without ever misreading a string as a
      // nested traversal. (A repeat body is a nested traversal, never a parameter.)
      if (name === 'repeat' && typeof args[0]?.value === 'string' && isNested(args[1]?.value)) {
        steps.push({ name, args: [args[1]], ctx: node, loopName: args[0].value });
      } else {
        steps.push({ name, args, ctx: node });
      }
      // nested traversals inside this step's args must not contribute to the top chain
      for (let i = 0; i < node.getChildCount(); i++) visit(node.getChild(i), true);
      return;
    }
    for (let i = 0; i < (node.getChildCount?.() ?? 0); i++) visit(node.getChild(i), insideNested);
  };
  visit(tree, false);
  return steps;
}

/** A nested-traversal argument. Its `nested` payload is an ANTLR NestedTraversalContext or,
 *  for a strategy-synthesized body, an already-lowered Step[] — stepChain resolves either.
 *  The one type-guard every consumer uses to detect a sub-traversal arg. */
export const isNested = (a: unknown): a is Extract<TaggedArg, { nested: any }> => tagged(a, 'nested');

// ---------- traversal-strategy extraction ----------
//
// withStrategies/withoutStrategies are TraversalSourceSelfMethod_* nodes, NOT part
// of the step chain (stepChain only harvests Spawn/TraversalMethod nodes). We pull
// them straight from the tree into a neutral spec the compiler's applyStrategies
// (strategies.ts) turns into injected steps / verification checks. Config values go
// through the same argOf walker as any step arg, so a criterion arrives as `{nested}`
// (ready for a synthetic where()), a list as an array, a scalar as its literal.

export interface StrategySpec { name: string; config: Record<string, any>; ctx: ParserRuleContext; }
export interface StrategyUse { with: StrategySpec[]; without: string[]; }

/** Depth-first collect every descendant (self included) of a given context class. */
function descendants(node: any, cls: string, out: any[] = []): any[] {
  if (node.constructor.name === cls) out.push(node);
  for (let i = 0; i < (node.getChildCount?.() ?? 0); i++) descendants(node.getChild(i), cls, out);
  return out;
}

/** One `TraversalStrategyContext` → {name, config}. ClassType is the bare strategy
 *  name (the optional `new` is a sibling terminal, so getText() is clean). Each
 *  ConfigurationContext is `key : genericArgument`; the value walks via argOf. */
function strategySpec(node: any, params: Record<string, any>): StrategySpec {
  const name = descendants(node, 'ClassTypeContext')[0]?.getText() ?? node.getText();
  const config: Record<string, any> = {};
  for (const cfg of descendants(node, 'ConfigurationContext')) {
    const key = cfg.getChild(0).getText(); // nakedKey | keyword, before the COLON
    const valNode = descendants(cfg, 'GenericArgumentContext')[0];
    if (valNode) config[key] = argOf(valNode, params);
  }
  return { name, config, ctx: node };
}

/** Pull withStrategies (as {name,config} specs) and withoutStrategies (as bare class
 *  names) out of the parse tree. Empty arrays when the traversal names none. */
export function extractStrategies(tree: any, params: Record<string, any>): StrategyUse {
  const use: StrategyUse = { with: [], without: [] };
  for (const w of descendants(tree, 'TraversalSourceSelfMethod_withStrategiesContext'))
    for (const s of descendants(w, 'TraversalStrategyContext')) use.with.push(strategySpec(s, params));
  for (const w of descendants(tree, 'TraversalSourceSelfMethod_withoutStrategiesContext'))
    for (const c of descendants(w, 'ClassTypeContext')) use.without.push(c.getText());
  return use;
}

// ---------- sack extraction ----------
//
// withSack(init[, mergeOperator]) is a TraversalSourceSelfMethod_* node (like
// withStrategies) — not part of the step chain. Pull the initial sack value (and its
// numeric subtype, for framing) plus the optional merge operator straight from the
// tree. split/merge-on-fork semantics are deferred; only the initial value is used
// today (the seed for every traverser's carried sack column).

export interface SackSpec { init: any; initType: string | null; mergeOp?: string; }

/** Pull withSack(init[, Operator.x]) out of the parse tree, or null if none. */
export function extractSack(tree: any, params: Record<string, any>): SackSpec | null {
  const w = descendants(tree, 'TraversalSourceSelfMethod_withSackContext')[0];
  if (!w) return null;
  const gl = descendants(w, 'GenericLiteralContext')[0];
  if (!gl) throw new Error('withSack() requires an initial value');
  const out: Arg[] = [];
  walkArgs(gl, out, params);
  const op = descendants(w, 'TraversalOperatorContext')[0];
  return { init: out[0].value, initType: flatType(out[0].type), mergeOp: op ? enumSuffix(op) : undefined };
}

/** Pull SOURCE-level `g.with(key[, value])` options into a key→value registry.
 *
 *  These are `TraversalSourceSelfMethod_with` nodes — a source-configuration boundary like
 *  withStrategies/withSack, NOT steps — so `stepChain` skips them and they were, until now,
 *  silently DISCARDED: `g.with('multilabel').V()` compiled as a bare `g.V()`. A bare key with no
 *  value registers `true`, which is the `with('multilabel')` / `with('singlelabel')` spelling.
 *
 *  Distinct from the two `with()` forms already handled elsewhere: a `valueMap().with(tokens)`
 *  MODULATOR (ir/strategies.ts) and a `call().with(k,v)` argument (ir/strategies.ts). Those attach
 *  to a step; this attaches to the traversal source. */
export function extractSourceOptions(tree: any, params: Record<string, any>): Map<string, any> {
  const out = new Map<string, any>();
  for (const w of descendants(tree, 'TraversalSourceSelfMethod_withContext')) {
    const args: Arg[] = [];
    for (const n of [...descendants(w, 'StringLiteralContext'), ...descendants(w, 'GenericLiteralContext')])
      walkArgs(n, args, params);
    if (typeof args[0]?.value === 'string') out.set(args[0].value, args.length > 1 ? args[1].value : true);
  }
  return out;
}

/** Pull withSideEffect(key, constValue) declarations into a name→constant registry.
 *  withSideEffect values are compile-time constants (a map/list/scalar literal or a bound
 *  param), so a later select(key) resolves to the constant directly. The reducer form
 *  withSideEffect(key, seed, BiFunction) is NOT a constant and stays out of this map —
 *  `sideEffectReducers` below is the companion fact, and it is a SEPARATE map rather than a
 *  sentinel in this one precisely because a consumer of this registry wants a value it can
 *  substitute, and there is none. */
export function extractSideEffects(tree: any, params: Record<string, any>): Map<string, any> {
  const out = new Map<string, any>();
  for (const w of descendants(tree, 'TraversalSourceSelfMethod_withSideEffectContext')) {
    if (descendants(w, 'TraversalBiFunctionContext').length) continue; // reducer form → sideEffectReducers
    const keyNode = descendants(w, 'StringLiteralContext')[0];
    const valNode = descendants(w, 'GenericLiteralContext')[0];
    if (!keyNode || !valNode) continue;
    const ks: Arg[] = [], vs: Arg[] = [];
    walkArgs(keyNode, ks, params);
    walkArgs(valNode, vs, params);
    if (typeof ks[0]?.value === 'string') out.set(ks[0].value, vs[0].value);
  }
  return out;
}

/**
 * The LABELS declared with the reducer form `withSideEffect(key, seed, Operator.x)`.
 *
 * A FACT THE FRONT END WAS DROPPING, and the drop was silent. `extractSideEffects` skips this form
 * because its value is not a constant to substitute — correct — but skipping it left the compiler
 * unable to tell a seeded, operator-merged collection from a fresh one, and a lowering that cannot
 * SEE a fact cannot decline on it. `compiler.ts` already says where that decline belongs ("the
 * reducer form of `withSideEffect`, which the front-end leaves unregistered, declines inside the
 * lowering like any other unlearned step"); this is what makes that possible, and it is the same
 * move `withSack`'s seed made — the fact travels as a settled value rather than as a route-level gate.
 *
 * A SET rather than a map of seeds: nothing can USE the seed until the operator merge is expressible,
 * and handing over a value no consumer may act on invites exactly the silent half-support this
 * function exists to end. When a merge policy lands, this widens to carry both — one place.
 *
 * The front-end stays a thin translator either way: this reports what the traversal DECLARED, and
 * what to do about it is entirely the compiler's.
 */
export function sideEffectReducers(tree: any, params: Record<string, any>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const w of descendants(tree, 'TraversalSourceSelfMethod_withSideEffectContext')) {
    if (!descendants(w, 'TraversalBiFunctionContext').length) continue;
    const keyNode = descendants(w, 'StringLiteralContext')[0];
    if (!keyNode) continue;
    const ks: Arg[] = [];
    walkArgs(keyNode, ks, params);
    if (typeof ks[0]?.value === 'string') out.add(ks[0].value);
  }
  return out;
}

/** Pull a step context's arguments out as `Arg[]` — each a value + its canonical type + its
 *  wire-parameter name (a top-level `$x` records its name, everything else null). */
function extractArgs(ctx: any, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Arg[] {
  const args: Arg[] = [];
  // skip child 0 (step name token) and parens; walking all children is fine since tokens have no children
  for (let i = 0; i < ctx.getChildCount(); i++) walkArgs(ctx.getChild(i), args, params, paramTypes);
  return args;
}

/** The single argument a subtree contributes — used for map-entry values, which
 *  must not flatten into the surrounding step's arg list (subtype tags irrelevant
 *  for these, so they're discarded), and for a withStrategies configuration value
 *  (a nested criterion → `{nested}`, a list → array, a scalar → the literal), so
 *  strategy config reuses the one arg walker. */
function argOf(node: any, params: Record<string, any>): any {
  const out: Arg[] = [];
  walkArgs(node, out, params);
  return out.length === 1 ? out[0].value : out.map((a) => a.value);
}

/** Walk one AST node, pushing each recognised argument onto `out` as an `Arg` (value + canonical
 *  type + wire-parameter name, all in one object). Unrecognised nodes recurse into children (a literal
 *  buried deeper still surfaces). The value+type+name travel together, so no caller has to thread three
 *  parallel arrays in lockstep any more. */
function walkArgs(node: any, out: Arg[], params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): void {
  const emit = (v: any, t: TypeNode | null = null, name: string | null = null) => { out.push(arg(v, t, name)); };
  const cls = node.constructor.name;
  if (cls === 'StringLiteralContext') { emit(unquote(node.getText()), 'string'); return; }
  // long/bigint carry EXACT via BigInt — parseInt would truncate past 2^53 (the
  // pre-existing precision bug; see do-sqlite-bind-precision). byte/short/int fit a JS
  // number, so they stay parseInt (numeric storage class + native index usage).
  if (cls === 'IntegerLiteralContext') {
    const { value, type } = integerLiteralValue(node.getText());
    emit(value, type); return;
  }
  // bigdecimal (`m` suffix) carries EXACT via a BigDecimal parsed from the literal text —
  // parseFloat would collapse it to a lossy f64. float/double stay parseFloat.
  if (cls === 'FloatLiteralContext') {
    const { value, type } = floatLiteralValue(node.getText());
    emit(value, type); return;
  }
  if (cls === 'BooleanLiteralContext') { emit(node.getText() === 'true', 'boolean'); return; }
  // 'x'c — a quoted single character with a `c` suffix. Strip the suffix, then unquote to
  // the 1-codepoint string. Tagged `char` so the write records vtype=char and framing
  // picks CharSerializer (a Char is storage-ambiguous with a String — vtype disambiguates).
  if (cls === 'CharacterLiteralContext') { emit(unquote(node.getText().replace(/[cC]$/, '')), 'char'); return; }
  // Duration(seconds, nanos [, negatedBool]) — a java.time Duration literal. Build the
  // exact value (seconds carries the sign via total-nanos); normalized + tagged `duration`.
  if (cls === 'DurationLiteralContext') {
    const secs = BigInt(node.integerLiteral(0).getText().replace(/[lnLN]$/, ''));
    const nanos = Number(node.integerLiteral(1).getText().replace(/[lnLN]$/, ''));
    const total = secs * 1_000_000_000n + BigInt(nanos);
    emit(Duration.fromTotalNanos(node.booleanLiteral()?.getText() === 'true' ? -total : total), 'duration'); return;
  }
  // UUID('…') → the string form tagged `uuid` so a property write records it as a
  // UUID (indistinguishable from a plain string by JS value alone). Bare UUID() (a
  // random uuid) has no string child — it falls through (uncommon as a stored value).
  if (cls === 'UuidLiteralContext') {
    const s = node.stringLiteral();
    if (s) { emit(unquote(s.getText()), 'uuid'); return; }
  }
  if (cls === 'NullLiteralContext') { emit(null); return; }
  if (cls === 'VariableContext') {
    const name = node.getText();
    if (!(name in params)) throw new Error(`Unbound parameter '${name}'`);
    // The param's canonical type is the wire DataType the client serialized it as
    // (paramTypes) — the truth a JS value can't carry; null when the channel said
    // nothing (JSON request path), so the write seam infers from the JS value. The NAME rides
    // alongside (the Arg's name): the value is still resolved into `out` for every consumer, but a
    // lowering can now see it was a user PARAMETER and bind it, rather than inline it as a constant.
    emit(params[name], paramTypes[name] ?? null, name); return;
  }
  // A COMPOSED predicate — `P.gt(20).and(P.lt(30))`, `TextP.startingWith('m').or(…)`,
  // `P.gt(5).negate()`. The grammar's three infix alternatives
  // (`traversalPredicate DOT K_AND|K_OR|K_NEGATE …`) carry no `#label`, so ANTLR folds them into
  // `TraversalPredicateContext` itself rather than minting a `TraversalPredicate_<op>Context`. That
  // is why this needs its own case ahead of the prefix test below: without it the generic recursion
  // descended into the two operand children and emitted them as SEPARATE step args, so
  // `has(k, P1.or(P2))` reached the compiler as `has(k, P1, P2)` — and every consumer reads args[1]
  // and ignores args[2], silently dropping the second operand. Must stay BEFORE the
  // `TraversalPredicate_` test: the composed node's own children match that prefix.
  if (cls === 'TraversalPredicateContext') {
    const composed = parseComposedPredicate(node, params);
    if (composed) { emit(composed); return; }
    // A plain (non-infix) predicate: one sub-rule child, handled by the prefix case below once
    // the recursion steps into it.
  }
  if (cls.startsWith('TraversalPredicate_')) {
    emit(parsePredicate(node, params)); return;
  }
  // order()/by() take an Order token (asc|desc|shuffle) that is a grammar rule,
  // not a literal — capture it so the compiler can pick sort direction.
  if (cls === 'TraversalOrderContext') {
    emit({ order: node.getText().split('.').pop().toLowerCase() }); return;
  }
  // Enum tokens carried as tagged objects so consumers can act on them (or
  // reject them cleanly). Previously these grammar rules had no case and the
  // generic recursion dropped them silently — e.g. select(Pop.first, 'a')
  // parsed as select('a') and mis-executed. Capture, then let the step throw
  // "not implemented" for anything past the current supported set.
  if (cls === 'TraversalPopContext') { emit({ pop: enumSuffix(node) }); return; }
  if (cls === 'TraversalColumnContext') { emit({ column: enumSuffix(node) }); return; }
  // T.id/T.label as a step arg or map key. Both the parenthesized (TraversalT)
  // and bare (TraversalTLong/Short) grammar shapes carry the same token.
  if (cls === 'TraversalTContext' || cls === 'TraversalTLongContext' || cls === 'TraversalTShortContext') {
    emit({ token: enumSuffix(node) }); return;
  }
  // Direction.OUT/IN (+ from/to aliases) — mergeE endpoints / addE from()/to().
  if (cls === 'TraversalDirectionContext' || cls === 'TraversalDirectionLongContext' || cls === 'TraversalDirectionShortContext') {
    emit({ direction: enumSuffix(node) }); return;
  }
  // Merge.onCreate/onMatch/outV/inV — mergeV/mergeE option() selector + endpoints.
  if (cls === 'TraversalMergeContext') { emit({ merge: enumSuffix(node) }); return; }
  // Cardinality.list/set/single is either a bare property() cardinality or the
  // value-bearing CardinalityValueTraversal used by property/merge maps. Preserve
  // the latter as one value instead of recursively flattening its payload into the
  // surrounding map/step arguments.
  if (cls === 'TraversalCardinalityContext') {
    const literal = node.genericLiteral?.();
    const cardinality = node.getText().match(/(?:^|\.)(single|set|list)(?:\(|$)/i)?.[1]?.toLowerCase();
    if (!cardinality) throw new Error(`unrecognized Cardinality form: ${node.getText()}`);
    emit(literal ? { cardinality, value: argOf(literal, params) } : { cardinality }); return;
  }
  // A map literal [k: v, …] / [:] — a real JS Map so it matches how a bound map
  // parameter (xx1) arrives after GraphBinary deserialization. Keys are tagged
  // ({token}/{direction}) or strings; values recurse via argOf. Do NOT fall
  // through to the generic recursion, which would flatten and drop pairing.
  if (cls === 'GenericMapLiteralContext') { emit(mapLiteral(node, params), mapLiteralType(node, params)); return; }
  // GType.STRING / bare STRING (P.typeOf(...), asNumber(...)) — a type-name enum,
  // captured as a tagged token so predicateSql can map it to a SQL type test.
  // Without this the generic recursion drops it and typeOf sees no argument.
  if (cls === 'TraversalGTypeContext') { emit({ gtype: enumSuffix(node) }); return; }
  // Pick.none/any/unproductive — choose().option() default/selector tokens. Without
  // this the generic recursion drops them, so option(Pick.none,…) and
  // option(Pick.unproductive,…) both collapse to a key-less option (indistinguishable).
  if (cls === 'TraversalPickContext') { emit({ pick: enumSuffix(node) }); return; }
  // WithOptions.tokens/all/none/ids/labels/keys/values/indexer/list/map — the OptionsStrategy
  // selectors for valueMap()/index()'s with(). Each grammar constant is its own context
  // (WithOptionsConstants_*), so match the shared prefix rather than list ten cases. Captured as
  // {withOption} so absorbValueMapWith can desugar with(WithOptions.tokens) to valueMap(true);
  // without this the generic recursion dropped them and with() saw no argument.
  if (cls.startsWith('WithOptionsConstants_')) { emit({ withOption: enumSuffix(node) }); return; }
  // IO.reader/writer/registry/graphson/gryo/graphml — io()'s with() selectors. Emitted as the
  // CANONICAL STRING rather than a tagged token, because that is what a GLV puts on the wire (the
  // JS client's IO.reader IS '~tinkerpop.io.reader', IO.graphson IS 'graphson'), so a query typed
  // straight at our server and the same query from a client become the SAME chain. Without this the
  // generic recursion dropped them and with() saw no argument at all.
  if (cls.startsWith('IoOptionsConstants_')) { emit(IO_OPTION_STRINGS[enumSuffix(node)] ?? enumSuffix(node)); return; }
  // datetime('iso') / DateTime('iso') / datetime() (now) — a date literal, captured as
  // epoch-millis (the internal datetime representation; the 'date' shape tag frames it
  // back to a JS Date). An offset-bearing ISO string folds into the correct instant.
  if (cls === 'DateLiteralContext') {
    const s = node.stringLiteral();
    emit(s ? parseIsoMs(unquote(s.getText())) : Date.now(), 'datetime'); return;
  }
  // DT.second/minute/hour/day (or the bare unit) — dateAdd()'s unit selector.
  if (cls === 'TraversalDTContext') { emit({ dt: enumSuffix(node) }); return; }
  // Operator.sum/minus/mult/div/min/max/assign (or the bare keyword) — sack()'s
  // merge operator / withSack()'s merge fn. Without this the generic recursion drops
  // it, so sack(Operator.sum) collapses to a key-less sack() (indistinguishable from
  // the bare read form).
  if (cls === 'TraversalOperatorContext') { emit({ operator: enumSuffix(node) }); return; }
  // Scope.local / Scope.global (or the bare local/global) — the per-list vs
  // whole-stream selector on order()/limit()/range()/tail()/sum()/… Without this
  // the token was dropped and a Scope.local step silently compiled as its GLOBAL
  // form (a latent wrong-result bug) — capture it so the tail can reject or honour it.
  if (cls === 'TraversalScopeContext') { emit({ scope: enumSuffix(node) }); return; }
  // A bracketed collection literal [a, b, c] / [] — ONE list value (a JS array),
  // NOT N flattened args. Elements recurse via argOf so nested lists/maps/literals
  // survive. A predicate written with the list form (P.within([...])) unwraps it
  // back to varargs in parsePredicate; a step consuming a real list value (inject,
  // Tier-1 list substrate) reads the array directly.
  if (cls === 'GenericCollectionLiteralContext') {
    out.push(collectionArg('list', literalItems(node.genericLiteral(), params)));
    return;
  }
  // A brace set literal {a, b, c} — `value` a real JS Set, `type` {t:'set'}, members carried. Without
  // this case the generic recursion below flattened it to N varargs (set-ness + boundary lost), so a
  // stored set was indistinguishable from a list. Mirrors the collection-literal case.
  if (cls === 'GenericSetLiteralContext') {
    out.push(collectionArg('set', literalItems(node.genericLiteral(), params)));
    return;
  }
  if (cls === 'NestedTraversalContext') { emit({ nested: node }); return; }
  for (let i = 0; i < (node.getChildCount?.() ?? 0); i++) walkArgs(node.getChild(i), out, params, paramTypes);
}

/** Parse an ISO-8601 date / date-time string to epoch-millis, UTC-normalized. Per
 *  ECMAScript, `Date.parse` treats an offset-less *date-time* string as HOST-LOCAL
 *  time — which would make the same query yield different instants on Bun vs the DO
 *  (workerd, UTC). Append `Z` when there's a time component but no timezone designator
 *  so both runtimes agree (matching SQLite `unixepoch` and TinkerPop's "dates assumed
 *  UTC"). A date-only string is already UTC per spec; an offset/`Z` is kept as-is. */
export function parseIsoMs(s: string): number {
  const iso = /T/.test(s) && !/(Z|[+-]\d\d:?\d\d)$/.test(s) ? `${s}Z` : s;
  return Date.parse(iso);
}

/** The trailing identifier of an enum token node, lowercased: `T.id`→`id`,
 *  `Direction.OUT`→`out`, `Merge.onCreate`→`oncreate`, bare `id`→`id`. */
function enumSuffix(node: any): string {
  return node.getText().split('.').pop().toLowerCase();
}

/** Walk a list/set literal's element nodes into member `Arg`s — each element's value, parsed
 *  TypeNode, and wire-parameter name in ONE object (a nested list/map/set → its own container node; a
 *  typed scalar → its subtype; a `$x` element → its name so a member can bind; a nested traversal /
 *  multi-arg element → a nameless, typeless member). One member per element, in order — the per-element
 *  type is what the collection storage tags each leaf with (full-fidelity elements). */
function literalItems(nodes: any[], params: Record<string, any>): Arg[] {
  return nodes.map((lit) => {
    const out: Arg[] = [];
    walkArgs(lit, out, params);
    // A single-arg element IS its `Arg` (value + type + name — a `$x` element keeps its name); a rare
    // multi-arg element collapses to a nameless array-valued member.
    return out.length === 1 ? out[0]! : arg(out.map((a) => a.value));
  });
}

/** A `[k: v, …]` / `[:]` map literal → a JS Map, keyed by the classified map
 *  key ({token}/{direction} tag or a plain string), values via argOf so nested
 *  traversals/maps survive. Mirrors the shape of a bound map parameter. */
function mapLiteral(node: any, params: Record<string, any>): Map<any, any> {
  const m = new Map<any, any>();
  for (const entry of node.mapEntry()) {
    m.set(mapKeyOf(entry.mapKey()), argOf(entry.genericLiteral(), params));
  }
  return m;
}

/** The recursively-captured TypeNode of a map literal — each entry value's parsed
 *  subtype (UUID→uuid, 5L→long, a nested map → its own {t:'map'} node, a nested
 *  traversal / non-scalar → null). Mirrors the wire's decodeTyped for a bound map, so a
 *  literal `mergeV([gid: UUID(x)])` carries the same type truth a typed client would send.
 *  The value type is read from the same walkArgs pass that produces the value, so nested
 *  maps recurse through the GenericMapLiteral case automatically. */
function mapLiteralType(node: any, params: Record<string, any>): TypeNode {
  const entries: Record<string, MapEntryType | null> = {};
  for (const entry of node.mapEntry()) {
    const out: Arg[] = [];
    walkArgs(entry.genericLiteral(), out, params);
    // A single scalar/map value carries its captured type; a multi-arg or empty walk
    // (unusual) → null (infer at use). A literal map key is a string/identifier (or a
    // T/Direction token → not a stored scalar), so its type is 'string' or null; a typed
    // client's non-string keys arrive typed via the wire's decodeTyped instead.
    const key = mapKeyOf(entry.mapKey());
    entries[String(key)] = {
      key: typeof key === 'string' ? 'string' : null,
      value: out.length === 1 ? (out[0].type ?? null) : null,
    };
  }
  return { t: 'map', entries };
}

/** Classify a map key: T token → {token}, Direction → {direction}, else the
 *  literal/naked string. */
function mapKeyOf(mk: any): any {
  const tok = mk.traversalT?.() ?? mk.traversalTLong?.() ?? mk.traversalTShort?.();
  if (tok) return { token: enumSuffix(tok) };
  const dir = mk.traversalDirection?.() ?? mk.traversalDirectionLong?.() ?? mk.traversalDirectionShort?.();
  if (dir) return { direction: enumSuffix(dir) };
  if (mk.stringLiteral?.()) return unquote(mk.stringLiteral().getText());
  return mk.getText();
}

/** A parsed `P`/`TextP` predicate. Its `operands` are `Arg`s — each an operand's value + canonical
 *  type + wire-parameter name — the same object a step argument is, so a `P.gt($x)` operand knows it is
 *  a parameter exactly as a bare `$x` does. Was two parallel arrays (`values` + `paramNames`). */
export interface Pred { op: string; operands: Arg[]; }

/** Is this argument a parsed predicate? `Step.args` is deliberately `any[]` (the front-end
 *  boundary), so every consumer used to open-code `!a || typeof a !== 'object' || a.op !== …`
 *  before reading `.op`/`.values`. This is the narrowing guard, the same role `isTokenArg` and
 *  friends play for the tagged arguments above — a cast that names `Pred` is also rename-safe
 *  where a bare property read is not. */
export const isPred = (arg: unknown): arg is Pred =>
  !!arg && typeof arg === 'object' && typeof (arg as Pred).op === 'string';

/**
 * The three infix predicate combinators, or null if `node` is a plain predicate.
 *
 * Grammar (Gremlin.g4 `traversalPredicate`):
 *   traversalPredicate DOT K_AND    LPAREN traversalPredicate RPAREN
 *   traversalPredicate DOT K_OR     LPAREN traversalPredicate RPAREN
 *   traversalPredicate DOT K_NEGATE LPAREN RPAREN
 * All three are unlabeled, so they share `TraversalPredicateContext` with the plain form; a plain one
 * has exactly ONE child (its sub-rule), an infix one has several. `negate()` reuses the existing
 * `not` op — `predicateSql` already renders that — so only `and`/`or` are new ops downstream.
 * Recurses, so `a.or(b).or(c)` and arbitrarily nested compositions build a left-leaning tree.
 */
function parseComposedPredicate(node: any, params: Record<string, any>): Pred | null {
  if (node.getChildCount() <= 1) return null;
  const left = node.traversalPredicate?.(0);
  if (!left) return null;
  // The combinator keyword sits between the operands; read it off the child tokens rather than
  // positionally, so a grammar tweak to whitespace/parens handling can't silently shift the index.
  const kw = (() => {
    for (let i = 0; i < node.getChildCount(); i++) {
      const t = node.getChild(i).getText?.();
      if (t === 'and' || t === 'or' || t === 'negate') return t;
    }
    return null;
  })();
  if (!kw) return null;
  const operand = (n: any): Pred => {
    const composed = parseComposedPredicate(n, params);
    return composed ?? parsePredicate(n.getChild(0), params);
  };
  // A composed predicate's operand is itself a Pred — wrapped as an `Arg` (value = the nested Pred)
  // so `operands` is uniformly `Arg[]` and a consumer reads `operands[i].value`.
  if (kw === 'negate') return { op: 'not', operands: [arg(operand(left))] };
  const right = node.traversalPredicate(1);
  if (!right) return null;
  return { op: kw, operands: [arg(operand(left)), arg(operand(right))] };
}

function parsePredicate(node: any, params: Record<string, any>): Pred {
  const m = node.constructor.name.match(/^TraversalPredicate_(\w+)Context$/);
  // FAITHFUL translation, no unwrap. `P.within/without/inside/between` accept both varargs
  // (`P.within('a','b')`) and a single collection (`P.within(['a','b'])` / `P.within($list)`), and a
  // single collection stays ONE operand — `extractArgs` already produced it as a collection `Arg`
  // (`.members` for a literal `[…]`, a raw array `value` + `.name` for a bound list-PARAM). HOW that
  // collection lowers is a per-SPINE decision, not a translation fact: the RelIR predicate spreads a
  // literal to an inline IN-list and crosses a PARAMETER as ONE `jsonb(?)` bind exploded by `json_each`
  // (the parameter stays a bind, its data never enters the statement text); legacy spreads to member
  // operands. Each consumer calls `collectionMembers`; varargs pass straight through.
  return { op: m![1], operands: extractArgs(node, params) };
}

/** A set/range collection operand's members as `Arg`s — its `.members` for a literal `[…]`, or its raw
 *  array `value` mapped to TYPED nameless `Arg`s for a bound list-PARAM (`within($list)`). The per-spine
 *  predicate consumers (RelIR `predicateExpr`, legacy `predicateSql`) call this to SPREAD a
 *  within/without/between/inside collection into member operands; `parsePredicate` stays faithful so the
 *  spread is the consumer's choice, not a front-end lowering. */
export const collectionMembers = (a: Arg): Arg[] =>
  a.members ? [...a.members]
    : (a.value as any[]).map((v, i) =>
        arg(v, a.type != null && typeof a.type === 'object' && 'items' in a.type
          ? ((a.type as { items: readonly (TypeNode | null)[] }).items[i] ?? null) : null));

function unquote(s: string): string {
  const body = s.slice(1, -1);
  return body.replace(/\\(['"\\nrt])/g, (_, c) =>
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c);
}
