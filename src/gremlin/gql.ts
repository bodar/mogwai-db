// ---------- the MATCH-string sub-language: GQL patterns → the match() IR ----------
//
// `g.match("MATCH (a:person)-[:knows]->(b:person)")` embeds a SECOND query language in a string
// argument. `Gremlin.g4` types that argument as an opaque `stringLiteral`, so the pattern inside is
// invisible to the Gremlin front end; upstream ships its own grammar for it
// (`gql-gremlin/src/main/antlr4/GQL.g4`), generated into `parser/gql/` by `mise run generate`. This
// module is the translator between the two: generated parse tree in, `Step[]` out.
//
// It sits exactly where `math.ts` sits, for the same reason — `math("a + b")` is already a
// sub-language mini compiler in the front end. The difference is only that math hand-rolls its
// lexer/parser (exp4j has no upstream grammar) and this one must not, per locked decision #2.
//
// LOCKED DECISION #5 HOLDS WITHOUT AN ARGUMENT: the output is the ordinary `match()` IR the compiler
// already lowers. Nothing downstream learns a GQL concept, and a GQL grammar bump moves only
// `parser/gql/` and this file. What the compiler receives for the example above is:
//
//   V().hasLabel("person").as("a").match(__.as("a").out("knows").hasLabel("person").as("b"))
//
// Design rationale, the measured translation table, and the residuals:
// docs/archive/2026-07-28-match-string-frontend-design.md.
import { CharStream, CommonTokenStream, BaseErrorListener, type ParserRuleContext } from 'antlr4ng';
import { GQLLexer } from '../../parser/gql/GQLLexer.ts';
import { GQLParser } from '../../parser/gql/GQLParser.ts';
import { integerLiteralValue, floatLiteralValue, type Step } from './frontend.ts';
import { type TypeNode } from './types.ts';

// ---------- parse ----------

class Errors extends BaseErrorListener {
  errors: string[] = [];
  override syntaxError(_r: any, _s: any, line: number, col: number, msg: string) {
    this.errors.push(`${line}:${col} ${msg}`);
  }
}

/** Parse one GQL MATCH clause. Throws with the GQL-level position, never a Gremlin one — a user who
 *  wrote a pattern must not read an error about the string literal that carried it. */
function parseGql(text: string) {
  const lexer = new GQLLexer(CharStream.fromString(text));
  const parser = new GQLParser(new CommonTokenStream(lexer));
  const errs = new Errors();
  lexer.removeErrorListeners(); parser.removeErrorListeners();
  lexer.addErrorListener(errs); parser.addErrorListener(errs);
  const tree = parser.matchClause();
  if (errs.errors.length) throw new Error(`MATCH pattern parse error: ${errs.errors.join('; ')}`);
  return tree;
}

// ---------- the pattern graph ----------
//
// A neutral value between parsing and lowering, mirroring the shape of upstream's QueryGraph /
// QueryVertex / QueryEdge. Deliberately NOT upstream's PLANNER: `DefaultGqlPlanner` scores seeds by
// `countVerticesByLabel` and orders edges by label density, which is a cost model for a
// row-at-a-time DFS executor. Join order is SQLite's job here (locked decision #3), so the only
// ordering this module does is the CONNECTIVITY BFS below — orienting each edge so its start is
// already bound, which is the one thing `match()`'s own scheduler cannot do for itself.

/** An inline `{k: v}` property filter entry. `value` is already the JS value a Gremlin literal of
 *  the same text would produce; `absent` is GQL's `{k: null}`, which means the property is MISSING
 *  rather than equal to null (upstream's `PropertyPredicate.test`: passes "if the property is absent
 *  and the expected value is null"). */
interface PropFilter { key: string; value?: any; type?: TypeNode | null; absent?: boolean }

interface PatNode { /** null until the BFS assigns a synthetic one. */ declared: string | null; var: string; label?: string; props: PropFilter[] }
/** `dir` is from `left`'s perspective: 'out' for `-[]->`, 'in' for `<-[]-`, 'both' for `-[]-`. */
interface PatEdge { left: PatNode; right: PatNode; dir: 'out' | 'in' | 'both'; var?: string; label?: string; props: PropFilter[] }

/** A synthetic variable for an anonymous `()` node. The leading SPACE makes collision impossible:
 *  GQL's `IDENTIFIER` is `[a-zA-Z_][a-zA-Z_0-9]*`, so a user cannot type this — the same trick
 *  `match()` itself uses for its internal ` traverser` binding. */
const anonVar = (n: number) => ` anon${n}`;

/** Walk the parse tree into nodes + edges. Two occurrences of the same DECLARED variable are the
 *  same node (their constraints merge); two anonymous `()` are always DISTINCT nodes, matching
 *  upstream's identity-keyed map. */
function patternGraph(tree: any, params: Record<string, any>): { nodes: PatNode[]; edges: PatEdge[] } {
  const nodes: PatNode[] = [];
  const edges: PatEdge[] = [];
  const byName = new Map<string, PatNode>();
  let anon = 0;

  const nodeFor = (filler: any): PatNode => {
    const declared = filler?.elementVariable()?.getText() ?? null;
    const label = filler?.labelSpec()?.labelName()?.getText();
    const props = propFilters(filler?.propertyFilter(), params);
    if (declared !== null) {
      const existing = byName.get(declared);
      if (existing) {
        // Re-mentioning a variable CONSTRAINS it further; `(b:person)` twice is one node with the
        // label stated twice, and `(b)` after `(b:person)` keeps the label.
        if (label && existing.label && existing.label !== label)
          throw new Error(`MATCH variable "${declared}" is given two labels ("${existing.label}" and "${label}")`);
        existing.label ??= label;
        existing.props.push(...props);
        return existing;
      }
      const made: PatNode = { declared, var: declared, label, props };
      byName.set(declared, made); nodes.push(made);
      return made;
    }
    const made: PatNode = { declared: null, var: anonVar(anon++), label, props };
    nodes.push(made);
    return made;
  };

  for (const path of tree.graphPattern().pathPattern()) {
    const nodePatterns = path.nodePattern();
    const edgePatterns = path.edgePattern();
    let left = nodeFor(nodePatterns[0].elementPatternFiller());
    for (let i = 0; i < edgePatterns.length; i++) {
      const right = nodeFor(nodePatterns[i + 1].elementPatternFiller());
      edges.push({ left, right, ...edgeSpec(edgePatterns[i], params) });
      left = right;
    }
  }
  return { nodes, edges };
}

/** One `edgePattern` → its direction (from the LEFT node's perspective) plus variable/label/props. */
function edgeSpec(ep: any, params: Record<string, any>): { dir: PatEdge['dir']; var?: string; label?: string; props: PropFilter[] } {
  const directed = ep.directedEdge?.();
  const reverse = ep.reverseDirectedEdge?.();
  const inner = directed ?? reverse ?? ep.undirectedEdge?.();
  if (!inner) throw new Error('MATCH edge pattern has no recognised form');
  const filler = inner.elementPatternFiller();
  return {
    dir: directed ? 'out' : reverse ? 'in' : 'both',
    var: filler?.elementVariable()?.getText(),
    label: filler?.labelSpec()?.labelName()?.getText(),
    props: propFilters(filler?.propertyFilter(), params),
  };
}

/** `{k: v, …}` → the filter list. A `$name` resolves from the map argument of
 *  `match(str, [k: v])`; an UNBOUND one throws, matching the Gremlin front end's own
 *  `Unbound parameter` rather than upstream's fail-open (which resolves a missing param to null and
 *  so silently matches an ABSENT property instead). */
function propFilters(pf: any, params: Record<string, any>): PropFilter[] {
  if (!pf) return [];
  return pf.propertyPair().map((pair: any): PropFilter => {
    const key = pair.propertyKey().getText();
    const pv = pair.propertyValue();
    const ref = pv.paramRef?.();
    if (ref) {
      const name = ref.IDENTIFIER().getText();
      if (!(name in params)) throw new Error(`MATCH pattern references unbound parameter $${name}`);
      const value = params[name];
      return value === null ? { key, absent: true } : { key, value };
    }
    return { key, ...literalValue(pv.literal()) };
  });
}

/** A GQL `literal` → its JS value + canonical type, reusing the Gremlin front end's own numeric
 *  typing (see integerLiteralValue / floatLiteralValue) so the two grammars cannot disagree about
 *  what `29i` or `1.0` means. */
function literalValue(lit: any): { value?: any; type?: TypeNode | null; absent?: boolean } {
  if (lit.K_NULL?.()) return { absent: true };            // GQL null = the property is ABSENT
  if (lit.STRING_LITERAL?.()) return { value: unquoteGql(lit.getText()), type: 'string' };
  if (lit.K_TRUE?.()) return { value: true, type: 'boolean' };
  if (lit.K_FALSE?.()) return { value: false, type: 'boolean' };
  if (lit.K_NAN?.()) return { value: NaN, type: 'double' };
  if (lit.K_INFINITY?.()) return { value: Infinity, type: 'double' };
  if (lit.SIGNED_INFINITY?.())
    return { value: lit.getText().startsWith('-') ? -Infinity : Infinity, type: 'double' };
  if (lit.FLOAT_LITERAL?.()) { const r = floatLiteralValue(lit.getText()); return { value: r.value, type: r.type }; }
  if (lit.INTEGER_LITERAL?.()) { const r = integerLiteralValue(lit.getText()); return { value: r.value, type: r.type }; }
  throw new Error(`MATCH property value not recognised: ${lit.getText()}`);
}

/** GQL string escapes are a SUPERSET of what the Gremlin front end's `unquote` handles — `GQL.g4`'s
 *  `EscapeSeq` adds octal and `\\uXXXX`. Implemented here rather than by widening the Gremlin one:
 *  the Gremlin lexer's own escape set is a separate question, and quietly changing it would alter
 *  how existing Gremlin string literals parse. */
function unquoteGql(s: string): string {
  return s.slice(1, -1).replace(
    /\\(u[0-9a-fA-F]{4}|[0-7]{1,3}|[btnfr"'\\])/g,
    (_m, esc: string) => {
      if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (/^[0-7]/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
      return { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r' }[esc] ?? esc;
    },
  );
}

// ---------- emit ----------

/** Build one synthesized IR step. Every step borrows the HOST `match` step's parse context, so an
 *  error raised deep in lowering still points at the right source span — the same thing
 *  `strategies.ts`'s `synth` does with a strategy's context. */
const step = (ctx: ParserRuleContext, name: string, args: any[] = [], argTypes?: (TypeNode | null)[]): Step =>
  argTypes ? { name, args, ctx, argTypes } : { name, args, ctx };

/** A node/edge's constraints as steps applied to whatever element is current: the label, then each
 *  property filter. `{k: null}` becomes `not(__.has(k))` — `hasNot(k)` is not implemented (see
 *  outstanding-work), and the two are verified equivalent. */
function constraintSteps(ctx: ParserRuleContext, label: string | undefined, props: readonly PropFilter[]): Step[] {
  const out: Step[] = [];
  if (label) out.push(step(ctx, 'hasLabel', [label], ['string']));
  for (const p of props)
    out.push(p.absent
      ? step(ctx, 'not', [{ nested: [step(ctx, 'has', [p.key], ['string'])] }])
      : step(ctx, 'has', [p.key, p.value], ['string', p.type ?? null]));
  return out;
}

/** The movement for one edge, oriented so it starts at `from`. Without an edge variable this is one
 *  pattern; WITH one it is two, because `match()` binds a single end per pattern and an intra-pattern
 *  `as()` is unsupported — so the edge and its far vertex are separate patterns, which is exactly the
 *  `as(a).outE().as(e), as(e).inV().as(b)` shape `match()` gained on 2026-07-27. */
function edgeBodies(ctx: ParserRuleContext, e: PatEdge, from: PatNode, to: PatNode): Step[][] {
  const dir = e.left === from ? e.dir : flip(e.dir);
  const vertexStep = { out: 'out', in: 'in', both: 'both' }[dir];
  const edgeStep = { out: 'outE', in: 'inE', both: 'bothE' }[dir];
  const farStep = { out: 'inV', in: 'outV', both: 'otherV' }[dir];
  const labelArgs: [any[], (TypeNode | null)[]] = e.label ? [[e.label], ['string']] : [[], []];
  const edgeProps = constraintSteps(ctx, undefined, e.props);
  const nodeConstraints = constraintSteps(ctx, to.label, to.props);

  if (e.var !== undefined) {
    if (dir === 'both')
      throw new Error(`MATCH undirected edge with a variable ("${e.var}") not yet supported (the far endpoint has no entering-vertex context to read)`);
    return [
      [step(ctx, 'as', [from.var], ['string']), step(ctx, edgeStep, ...labelArgs), ...edgeProps, step(ctx, 'as', [e.var], ['string'])],
      [step(ctx, 'as', [e.var], ['string']), step(ctx, farStep), ...nodeConstraints, step(ctx, 'as', [to.var], ['string'])],
    ];
  }
  // No edge variable: one pattern. A property filter on the edge forces the exploded form
  // (`outE().has(…).inV()`), since a bare `out()` has no edge to filter.
  const move = edgeProps.length
    ? [step(ctx, edgeStep, ...labelArgs), ...edgeProps, step(ctx, farStep)]
    : [step(ctx, vertexStep, ...labelArgs)];
  return [[step(ctx, 'as', [from.var], ['string']), ...move, ...nodeConstraints, step(ctx, 'as', [to.var], ['string'])]];
}

const flip = (d: PatEdge['dir']): PatEdge['dir'] => (d === 'out' ? 'in' : d === 'in' ? 'out' : 'both');

/**
 * A GQL MATCH string → the `Step[]` the compiler already lowers.
 *
 * `ctx` is the host `match` step's parse context, stamped on every synthesized step. `terminal` says
 * whether the `match` is the LAST step of its chain — if so a binding-map projection is appended,
 * because `match()` emits the traverser while TinkerPop's match-string step emits one Map per
 * binding.
 *
 * The seed variable is ALWAYS pre-bound in the prefix (`V().<constraints>.as(seed)`), which puts
 * `match()` in its documented ZERO-ROOT regime. That is not an optimization: `match()` finds its
 * root as "a start var never used as an end", and a CYCLIC pattern has no such variable — so the
 * corpus's cyclic scenario only works this way, with no change to root detection.
 */
export function gqlMatchSteps(
  text: string,
  params: Record<string, any>,
  ctx: ParserRuleContext,
  terminal: boolean,
): Step[] {
  const { nodes, edges } = patternGraph(parseGql(text), params);
  if (!nodes.length) throw new Error('MATCH pattern has no node patterns');

  // ONE BFS does three jobs: pick the seed (first in textual order — no cost model, see above),
  // ORIENT each edge so its start is already bound, and detect disconnected components. Orientation
  // is the part `match()`'s own greedy scheduler cannot do: it can reorder patterns freely but
  // cannot reverse one, so `(a)-[:created]->(s), (b)-[:created]->(s)` needs the second edge emitted
  // as `as(s).in('created').as(b)`.
  const seed = nodes[0];
  const visited = new Set<PatNode>([seed]);
  const pending = [...edges];
  const bodies: Step[][] = [];
  for (let progress = true; progress;) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      const e = pending[i];
      const leftIn = visited.has(e.left);
      const rightIn = visited.has(e.right);
      if (!leftIn && !rightIn) continue;
      // A BACK edge (both ends already bound) still emits: its trailing as() re-uses a bound
      // variable, which `match()` turns into a CONSTRAINT rather than a re-bind. That is what makes
      // a cyclic pattern narrow the binding table instead of widening it.
      const from = leftIn ? e.left : e.right;
      const to = leftIn ? e.right : e.left;
      bodies.push(...edgeBodies(ctx, e, from, to));
      visited.add(to);
      pending.splice(i--, 1);
      progress = true;
    }
  }
  if (pending.length) {
    const unreached = [...new Set(pending.flatMap((e) => [e.left, e.right]))].filter((n) => !visited.has(n));
    throw new Error(
      'MATCH pattern contains disconnected components — every path pattern must share at least one '
      + `variable with another. Unconnected: ${unreached.map((n) => `(${n.declared ?? 'anonymous'})`).join(', ')}`);
  }

  // The seed's own constraints ride in the PREFIX rather than in a pattern, so an index can serve
  // them: `V().hasLabel('person').has('name','marko').as('a')`.
  const out: Step[] = [
    step(ctx, 'V'),
    ...constraintSteps(ctx, seed.label, seed.props),
    step(ctx, 'as', [seed.var], ['string']),
  ];
  // A single-node pattern binds everything in that prefix, so there is no pattern to match on —
  // `match()` requires at least one argument, so emit none rather than a vacuous identity body.
  if (bodies.length)
    out.push(step(ctx, 'match', bodies.map((b) => ({ nested: b }))));
  if (terminal) out.push(...terminalProjection(ctx, nodes));
  return out;
}

/** The binding MAP a terminal match-string emits. Dispatched on how many variables the pattern
 *  DECLARES — anonymous nodes are never in the map:
 *    ≥2 → `select(v1, …, vk)`, which already builds a per-traverser record
 *     1 → `project(v).by(select(v))`, because a single-label `select(v)` yields the VALUE, not a
 *         one-key map
 *     0 → nothing to project; fails closed. */
function terminalProjection(ctx: ParserRuleContext, nodes: readonly PatNode[]): Step[] {
  const declared = nodes.filter((n) => n.declared !== null).map((n) => n.var);
  if (declared.length >= 2)
    return [step(ctx, 'select', declared, declared.map(() => 'string' as TypeNode))];
  if (declared.length === 1)
    return [
      step(ctx, 'project', [declared[0]], ['string']),
      { ...step(ctx, 'by', []), name: 'by', args: [{ nested: [step(ctx, 'select', [declared[0]], ['string'])] }] },
    ];
  throw new Error('a terminal MATCH pattern declaring no variables has no binding map to emit (add a variable, or a select())');
}
