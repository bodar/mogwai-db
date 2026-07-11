import { CharStream, CommonTokenStream, BaseErrorListener, ParserRuleContext } from 'antlr4ng';
import { GremlinLexer } from '../parser/GremlinLexer.ts';
import { GremlinParser } from '../parser/GremlinParser.ts';
import type { GraphStore } from './storage.ts';

// lazyrecords typed SQL construction (bind-safe: params derive from the tree).
import { sql as lsql, type Sql } from '@bodar/lazyrecords/sql/template/Sql.ts';
import { text as sqlText } from '@bodar/lazyrecords/sql/template/Text.ts';
import { statement } from '@bodar/lazyrecords/sql/statement/ordinalPlaceholder.ts';
import { jsonExtract } from '@bodar/lazyrecords/sql/sqlite/jsonExtract.ts';
import { cte } from '@bodar/lazyrecords/sql/ansi/CommonTableExpression.ts';
import { withClause } from '@bodar/lazyrecords/sql/ansi/WithClause.ts';
import { valuesClause } from '@bodar/lazyrecords/sql/ansi/ValuesClause.ts';
import { type Expression } from '@bodar/lazyrecords/sql/template/Expression.ts';
import { expression, and, parens, list } from '@bodar/lazyrecords/sql/template/Compound.ts';
import { value } from '@bodar/lazyrecords/sql/template/Value.ts';
import { comparison, type ComparisonOperator } from '@bodar/lazyrecords/sql/ansi/ComparisonExpression.ts';
import { isNotNull } from '@bodar/lazyrecords/sql/ansi/NullExpression.ts';
import { like, notLike } from '@bodar/lazyrecords/sql/ansi/LikeExpression.ts';
import { inExpression, notIn } from '@bodar/lazyrecords/sql/ansi/InExpression.ts';

// ---------- parsing ----------

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

export interface Step { name: string; args: any[]; ctx: ParserRuleContext; }

const stepName = (cls: string, prefix: string) =>
  cls.startsWith(prefix) && cls.endsWith('Context')
    ? cls.slice(prefix.length, -'Context'.length).split('_')[0]
    : null;

/** Collect the top-level step chain (does not descend into nested traversal args). */
export function stepChain(tree: any, params: Record<string, any>): Step[] {
  const steps: Step[] = [];
  const visit = (node: any, insideNested: boolean) => {
    const cls = node.constructor.name;
    const name = stepName(cls, 'TraversalSourceSpawnMethod_') ?? stepName(cls, 'TraversalMethod_');
    if (!insideNested && name) {
      steps.push({ name, args: extractArgs(node, params), ctx: node });
      // nested traversals inside this step's args must not contribute to the top chain
      for (let i = 0; i < node.getChildCount(); i++) visit(node.getChild(i), true);
      return;
    }
    for (let i = 0; i < (node.getChildCount?.() ?? 0); i++) visit(node.getChild(i), insideNested);
  };
  visit(tree, false);
  return steps;
}

/** Pull literal / predicate / variable arguments out of a step context. */
function extractArgs(ctx: any, params: Record<string, any>): any[] {
  const args: any[] = [];
  // skip child 0 (step name token) and parens; walking all children is fine since tokens have no children
  for (let i = 0; i < ctx.getChildCount(); i++) walkArgs(ctx.getChild(i), args, params);
  return args;
}

/** The single argument a subtree contributes — used for map-entry values, which
 *  must not flatten into the surrounding step's arg list. */
function argOf(node: any, params: Record<string, any>): any {
  const out: any[] = [];
  walkArgs(node, out, params);
  return out.length === 1 ? out[0] : out;
}

/** Walk one AST node, pushing each recognised argument onto `out`. Unrecognised
 *  nodes recurse into children (a literal buried deeper still surfaces). */
function walkArgs(node: any, out: any[], params: Record<string, any>): void {
  const cls = node.constructor.name;
  if (cls === 'StringLiteralContext') { out.push(unquote(node.getText())); return; }
  if (cls === 'IntegerLiteralContext') { out.push(parseInt(node.getText().replace(/[lL]$/, ''), 10)); return; }
  if (cls === 'FloatLiteralContext') { out.push(parseFloat(node.getText())); return; }
  if (cls === 'BooleanLiteralContext') { out.push(node.getText() === 'true'); return; }
  if (cls === 'NullLiteralContext') { out.push(null); return; }
  if (cls === 'VariableContext') {
    const name = node.getText();
    if (!(name in params)) throw new Error(`Unbound parameter '${name}'`);
    out.push(params[name]); return;
  }
  if (cls.startsWith('TraversalPredicate_')) {
    out.push(parsePredicate(node, params)); return;
  }
  // order()/by() take an Order token (asc|desc|shuffle) that is a grammar rule,
  // not a literal — capture it so the compiler can pick sort direction.
  if (cls === 'TraversalOrderContext') {
    out.push({ order: node.getText().split('.').pop().toLowerCase() }); return;
  }
  // Enum tokens carried as tagged objects so consumers can act on them (or
  // reject them cleanly). Previously these grammar rules had no case and the
  // generic recursion dropped them silently — e.g. select(Pop.first, 'a')
  // parsed as select('a') and mis-executed. Capture, then let the step throw
  // "not implemented" for anything past the current supported set.
  if (cls === 'TraversalPopContext') { out.push({ pop: enumSuffix(node) }); return; }
  if (cls === 'TraversalColumnContext') { out.push({ column: enumSuffix(node) }); return; }
  // T.id/T.label as a step arg or map key. Both the parenthesized (TraversalT)
  // and bare (TraversalTLong/Short) grammar shapes carry the same token.
  if (cls === 'TraversalTContext' || cls === 'TraversalTLongContext' || cls === 'TraversalTShortContext') {
    out.push({ token: enumSuffix(node) }); return;
  }
  // Direction.OUT/IN (+ from/to aliases) — mergeE endpoints / addE from()/to().
  if (cls === 'TraversalDirectionContext' || cls === 'TraversalDirectionLongContext' || cls === 'TraversalDirectionShortContext') {
    out.push({ direction: enumSuffix(node) }); return;
  }
  // Merge.onCreate/onMatch/outV/inV — mergeV/mergeE option() selector + endpoints.
  if (cls === 'TraversalMergeContext') { out.push({ merge: enumSuffix(node) }); return; }
  // Cardinality.list/set/single — property() cardinality (list/set deferred to W4).
  if (cls === 'TraversalCardinalityContext') { out.push({ cardinality: enumSuffix(node) }); return; }
  // A map literal [k: v, …] / [:] — a real JS Map so it matches how a bound map
  // parameter (xx1) arrives after GraphBinary deserialization. Keys are tagged
  // ({token}/{direction}) or strings; values recurse via argOf. Do NOT fall
  // through to the generic recursion, which would flatten and drop pairing.
  if (cls === 'GenericMapLiteralContext') { out.push(mapLiteral(node, params)); return; }
  if (cls === 'NestedTraversalContext') { out.push({ nested: node }); return; }
  for (let i = 0; i < (node.getChildCount?.() ?? 0); i++) walkArgs(node.getChild(i), out, params);
}

/** The trailing identifier of an enum token node, lowercased: `T.id`→`id`,
 *  `Direction.OUT`→`out`, `Merge.onCreate`→`oncreate`, bare `id`→`id`. */
function enumSuffix(node: any): string {
  return node.getText().split('.').pop().toLowerCase();
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

export interface Pred { op: string; values: any[]; }

function parsePredicate(node: any, params: Record<string, any>): Pred {
  const m = node.constructor.name.match(/^TraversalPredicate_(\w+)Context$/);
  const values = extractArgs(node, params);
  return { op: m![1], values };
}

function unquote(s: string): string {
  const body = s.slice(1, -1);
  return body.replace(/\\(['"\\nrt])/g, (_, c) =>
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c);
}

// ---------- compilation ----------

// select(labels…)/project(keys…): a Map per row. Each entry names its result
// key plus the SQL column prefix carrying its value, and whether that value is
// a whole vertex (prefix_id/_label/_props) or a scalar (prefix_v).
export interface MapEntry { key: string; prefix: string; sub: 'vertex' | 'value'; }

// The element kind an element-shaped column carries, and the columns that frame
// it. `node`→vertexBuffer(v_id,v_label,v_props); `edge`→edgeBuffer(+v_src,v_tgt);
// `property`→propertyBuffer(v_owner,v_pk,v_pv). Prefix lets a group key AND value
// each carry their own element columns (k_* / v_*).
export type ElemShape = 'vertex' | 'edge' | 'property';

// group()/groupCount(): the whole stream collapses into ONE Map (a barrier).
// The key is a scalar (gk), a token (label/id), an element (framed like a value),
// or a composite Map from project() (k0_,k1_,… parts). The value is reduced per
// group: a list of elements, a single element (tail/last), a list of scalars
// (json_group_array), or a scalar aggregate (count/sum).
export type GroupKey =
  | { kind: 'scalar' }                                   // by('name')/by(T.label)/by(__.scalar) → column gk
  | { kind: 'element'; elem: ElemShape }                 // bare by() → the element itself, columns k_*
  | { kind: 'map'; parts: { key: string }[] };           // by(__.project(...)) → columns k0_,k1_,…
export type GroupVal =
  | { kind: 'elementList'; elem: ElemShape }             // default/by(__.fold()) → [elements]
  | { kind: 'elementLast'; elem: ElemShape }             // by(__.tail()) → last element
  | { kind: 'scalarList' }                               // by('age') → json_group_array → parsed list
  | { kind: 'count' }                                    // by(__.count())/groupCount → Long
  | { kind: 'sum' };                                     // by(__.…sum()) → numeric

export type Shape =
  | { kind: 'vertex' }
  | { kind: 'edge' }
  | { kind: 'property' } // properties(): VertexProperty elements (owner/key/value cols)
  | { kind: 'value' }
  | { kind: 'count' }
  | { kind: 'scalar' } // sum(): one numeric; handler picks Long/Double per value (numberBuffer)
  | { kind: 'list'; elem: ElemShape | 'scalar' }   // fold(): the whole stream as one List value
  | { kind: 'valueMap'; keys: string[] | null; tokens: boolean }
  | { kind: 'elementMap'; keys: string[] | null }
  | { kind: 'map'; entries: MapEntry[] }
  | { kind: 'group'; key: GroupKey; val: GroupVal }
  | { kind: 'discard' };

export interface Compiled {
  kind: 'read';
  sql: string;
  binds: any[];
  shape: Shape;
  /** Identifier-safe property keys used in a filter/order position — the
   *  handler ensures a matching expression index exists before running, so hot
   *  properties become index seeks on first filtered use (self-tuning). */
  indexKeys?: string[];
}

export interface WritePlan { kind: 'write'; run: (store: GraphStore) => any[]; }

const P_OPS: Record<string, string> = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

// A property key that is a plain identifier is safe to splice literally into
// the JSON path — and doing so is REQUIRED for SQLite to use an on-demand
// expression index `CREATE INDEX ... (json_extract(props,'$.key'))`: the
// planner only matches a literal path, never the parameterized `'$.' || ?`
// form (which always forces a full scan, defeating the hot-property index
// strategy). Keys that aren't plain identifiers (spaces, dots, unicode) can't
// be an index target anyway, so we keep binding them — correct, just unindexed.
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `json_extract(col, '$.key')` for a property key. Splices safe identifier
 *  keys literally (index-friendly, and `indexKey` names it so the caller can
 *  auto-build the matching expression index); binds anything else. */
function propExtract(col: string, key: unknown): { expr: Expression; indexKey: string | null } {
  if (typeof key !== 'string') throw new Error('property key must be a string');
  // The lazyrecords jsonExtract node owns the literal-vs-bound path splice (its
  // SAFE_KEY matches ours) and reports the spliced key via .indexKey. The column
  // is a bind-free fragment (`n.props`) wrapped as raw text() so it renders
  // unquoted — index-eligible. Any exotic-key bind lives as a Value in the node.
  const node = jsonExtract(sqlText(col), key);
  return { expr: node, indexKey: node.indexKey };
}

/** Boundary: render a finished lazyrecords Sql tree to a read Compiled. Binds fall
 *  out of the tree (statement → {text,args}); no hand-maintained parallel array. */
function compiled(tree: Sql, shape: Shape, indexKeys?: string[]): Compiled {
  const { text, args } = statement(tree);
  return { kind: 'read', sql: text, binds: args, shape, ...(indexKeys ? { indexKeys } : {}) };
}

/** Fragment boundary: render a node Expression to `{sql,binds}` for the (still
 *  string-assembled) CTE prefix. Binds fall out of the tree — no parallel array.
 *  Temporary while the CTE builders (S2) remain string-based; removed once they
 *  go node-native. */
function render(node: Expression): { sql: string; binds: any[] } {
  const { text, args } = statement(lsql(node));
  return { sql: text, binds: args };
}

/** `<col> IN (SELECT id FROM labels WHERE name IN (?,?))` — the canonical
 *  label-name→id filter. Names ride as bound Value tokens (node-built, no splice). */
function labelIn(col: string, names: any[]): { sql: string; binds: any[] } {
  return render(expression(sqlText(`${col} IN (SELECT id FROM labels WHERE name IN`), parens(names.map(value)), sqlText(')')));
}

/** Optional ` AND e.label IN (…)` appended to a movement JOIN's ON. Empty when
 *  no labels. Replaces ~7 hand-rolled `?`-splice + manual bind-push copies. */
function edgeLabelFilter(names: any[]): { sql: string; binds: any[] } {
  if (!names.length) return { sql: '', binds: [] };
  const r = labelIn('e.label', names);
  return { sql: ` AND ${r.sql}`, binds: r.binds };
}

/**
 * A boolean SQL comparison fragment over a pre-built column expression, shared by
 * has()/is()/where(). `expr` is SQL (a json_extract, a column, a subquery);
 * `exprBinds` are its own placeholders, spliced once per occurrence of `expr` in
 * the output (between/inside mention it twice). `pred` is a `Pred` {op,values},
 * a bare literal (→ equality), or `undefined` (existence → IS NOT NULL).
 * TextP (startingWith/endingWith/containing + negations) → LIKE with the pattern
 * assembled and BOUND (never spliced); regex/typeOf throw.
 */
function predicateSql(expr: Expression, pred: any): Expression {
  if (pred === undefined) return expression(expr, isNotNull());
  if (pred === null || typeof pred !== 'object' || !('op' in pred))
    return expression(expr, comparison('=', pred));
  const { op, values } = pred as Pred;
  if (op in P_OPS) return expression(expr, comparison(P_OPS[op] as ComparisonOperator, values[0]));
  if (op === 'within') return expression(expr, inExpression(values));
  if (op === 'without') return expression(expr, notIn(values));
  // between = [lo, hi) inclusive low; inside = (lo, hi) exclusive low. `expr`
  // appears in both bounds — as a shared subtree, so its binds fall out twice in
  // order automatically (no manual double-splice).
  if (op === 'between' || op === 'inside')
    return and(expression(expr, comparison(op === 'inside' ? '>' : '>=', values[0])),
               expression(expr, comparison('<', values[1])));
  const lp = likePattern(op, values[0]);
  if (lp) return expression(expr, lp.neg ? notLike(lp.pat, '\\') : like(lp.pat, '\\'));
  throw new Error(`unsupported predicate: P.${op}`);
}

/** TextP → a LIKE pattern (metachars in the user value escaped). null if not a
 *  supported TextP op (regex/typeOf fall through to the caller's throw). */
function likePattern(op: string, value: unknown): { pat: string; neg: boolean } | null {
  const neg = op.startsWith('not');
  const base = neg ? op[3].toLowerCase() + op.slice(4) : op; // notStartingWith → startingWith
  const v = String(value).replace(/[\\%_]/g, (c) => '\\' + c);
  if (base === 'startingWith') return { pat: `${v}%`, neg };
  if (base === 'endingWith') return { pat: `%${v}`, neg };
  if (base === 'containing') return { pat: `%${v}%`, neg };
  return null;
}

/** range(low, high) → SQL [offset, limit]. high < 0 means "no upper bound". */
function rangeToOffsetLimit(args: any[]): { offset: number; limit: number } {
  const [lo, hi] = args.map(Number);
  if (hi >= 0 && lo > hi) throw new Error(`Not a legal range: [${lo}, ${hi}]`);
  return { offset: lo, limit: hi < 0 ? -1 : hi - lo };
}

/**
 * Fail closed on traversal-strategy application. `withStrategies`/`withoutStrategies`
 * parse and chain fine (so they count toward the L1 "we understand the language"
 * corpus metric), but the compiler does not yet APPLY them. A PartitionStrategy or
 * SubgraphStrategy — which a client relies on to FILTER reads/writes for logical
 * isolation — would otherwise be silently dropped and return unfiltered data with
 * no error. Reject at execution until the compiler honours them, rather than leak.
 */
function rejectUnsupportedStrategies(tree: any): void {
  const scan = (node: any) => {
    const m = stepName(node.constructor.name, 'TraversalSourceSelfMethod_');
    if (m === 'withStrategies' || m === 'withoutStrategies')
      throw new Error(`${m}(...) is not supported: traversal strategies (e.g. PartitionStrategy, SubgraphStrategy) are not yet applied by the compiler, so accepting them would silently ignore the filtering they imply and leak unfiltered data. Rejected to fail closed.`);
    for (let i = 0; i < (node.getChildCount?.() ?? 0); i++) scan(node.getChild(i));
  };
  scan(tree);
}

export function compile(gremlin: string, params: Record<string, any>): Compiled | WritePlan {
  const tree = parseGremlin(gremlin);
  rejectUnsupportedStrategies(tree);
  const steps = stepChain(tree, params);
  if (steps.length === 0) throw new Error('empty traversal');

  // v4 iterate() appends discard(): execute, return nothing
  let discard = false;
  const last = steps[steps.length - 1];
  if (last.name === 'discard' || last.name === 'none') { steps.pop(); discard = true; }

  let plan: Compiled | WritePlan;
  if (steps.some((s) => s.name === 'addE')) plan = compileAddE(steps, params);
  else if (steps[0].name === 'addV') plan = compileAddV(steps);
  else if (steps.some((s) => s.name === 'mergeV')) plan = compileMergeV(steps, params);
  else if (steps.some((s) => s.name === 'mergeE')) plan = compileMergeE(steps, params);
  else if (steps[0].name === 'inject') plan = compileInject(steps);
  else if (steps[steps.length - 1].name === 'drop') plan = compileDrop(steps);
  else if (steps.some((s) => s.name === 'property')) plan = compileSetProperty(steps, params);
  else plan = compileRead(steps, params);

  if (discard) {
    if (plan.kind === 'write') { const inner = plan.run; return { kind: 'write', run: (s) => { inner(s); return []; } }; }
    return { ...plan, shape: { kind: 'discard' } };
  }
  return plan;
}

/**
 * Build the movement/filter CTE prefix (the id-relation). Consumes V + the
 * filter/traversal/cardinality steps that compose as pure CTEs; stops at the
 * first order()/projection/other step and returns where it stopped. Shared by
 * reads and drop().
 */
/** Whether the current traverser's `id` column is a node id or an edge id. The
 *  id-relation is typed but the type is *static* — known from the step chain, so
 *  no runtime tag is needed. V()/out()/…V() → node; E()/…E() → edge. */
type Elem = 'node' | 'edge';

/** The (from,to) edge-column pairs a directional step walks: out→src/tgt,
 *  in→tgt/src, both→both. One place so the movement CTE and the correlated
 *  edge-count (edgeCountFrom) can't diverge. */
const dirsFor = (name: string): [string, string][] =>
  name === 'out' ? [['src', 'tgt']] : name === 'in' ? [['tgt', 'src']] : [['src', 'tgt'], ['tgt', 'src']];

/** A union() branch (currently a single out/in/both movement) → a SELECT of the
 *  neighbour node ids from `seed`. Non-movement / multi-step branches defer. */
function branchMovementSelect(bs: Step[], seed: string): { sql: string; binds: any[] } {
  if (bs.length !== 1 || (bs[0].name !== 'out' && bs[0].name !== 'in' && bs[0].name !== 'both'))
    throw new Error(`union() branch __.${bs.map((s) => s.name + '()').join('.')} not yet supported (single out()/in()/both() only)`);
  const mv = bs[0];
  const lf = edgeLabelFilter(mv.args);
  const binds: any[] = [];
  const sel = dirsFor(mv.name).map(([from, to]) => { binds.push(...lf.binds); return `SELECT e.${to} AS id FROM edges e JOIN ${seed} p ON e.${from}=p.id${lf.sql}`; });
  return { sql: sel.join(' UNION ALL '), binds };
}

/** Bound as() labels: label -> its carried column and the element kind it holds. */
type AliasMap = Map<string, { col: string; elem: Elem }>;

/** The SQL expr holding a labelled traverser's id (its carried alias column). */
function aliasIdExpr(label: string, aliases: AliasMap): string {
  const entry = aliases.get(label);
  if (!entry) throw new Error(`where("${label}"): no such label — as("${label}") was not seen`);
  return `p.${entry.col}`;
}

function traversalCtes(steps: Step[], params: Record<string, any> = {}): { ctes: string[]; binds: any[]; stop: number; indexKeys: Set<string>; aliases: AliasMap; elem: Elem } {
  const ctes: string[] = [];
  const binds: any[] = [];
  const indexKeys = new Set<string>();
  // as('x') labels: label -> { synthetic column name (a0,a1,… — user strings
  // never enter SQL identifiers, injection-safe, and stable so a later
  // correlated subquery can reference them), element kind at bind time (so
  // select/project knows whether the label holds a vertex or an edge) }. Once
  // bound a label stays live to the end (Gremlin never unbinds one), so every
  // CTE after the bind carries every bound alias column forward from `p`.
  const aliases: AliasMap = new Map();
  const prev = () => `c${ctes.length - 1}`;
  const carry = () => [...aliases.values()].map((a) => `, p.${a.col}`).join('');

  const first = steps[0];
  if (first.name !== 'V' && first.name !== 'E') throw new Error(`unsupported source step: ${first.name}`);
  let elem: Elem = first.name === 'E' ? 'edge' : 'node';
  const srcTable = elem === 'edge' ? 'edges' : 'nodes';
  if (first.args.length > 0) {
    // V(...)/E(...) ids: numeric args match the rowid, string args match the
    // user id (uid). The id-relation carries rowids throughout, so a uid match
    // still projects `id` (the rowid).
    const nums = first.args.filter((a) => typeof a === 'number');
    const strs = first.args.filter((a) => typeof a === 'string');
    const clauses: string[] = [];
    if (nums.length) { clauses.push(`id IN (${nums.map(() => '?').join(',')})`); binds.push(...nums); }
    if (strs.length) { clauses.push(`uid IN (${strs.map(() => '?').join(',')})`); binds.push(...strs); }
    if (!clauses.length) throw new Error('V()/E() ids must be numbers or strings');
    ctes.push(`c0 AS (SELECT id FROM ${srcTable} WHERE ${clauses.join(' OR ')})`);
  } else {
    ctes.push(`c0 AS (SELECT id FROM ${srcTable})`);
  }

  let i = 1;
  for (; i < steps.length; i++) {
    const s = steps[i];
    switch (s.name) {
      case 'as': {
        // Bind each label to the current traverser. Rebinds reuse the label's
        // column (default Pop = last). Emit a pass-through CTE that keeps id +
        // all carried alias columns, (re)setting the bound ones to the current id.
        const labels = s.args.filter((a): a is string => typeof a === 'string');
        const rebind: string[] = [];
        for (const lbl of labels) {
          let entry = aliases.get(lbl);
          if (!entry) { entry = { col: `a${aliases.size}`, elem }; aliases.set(lbl, entry); }
          else entry.elem = elem; // rebind: default Pop = last, and re-capture kind
          rebind.push(entry.col);
        }
        const cols = ['id', ...[...aliases.values()].map((a) => rebind.includes(a.col) ? `id AS ${a.col}` : a.col)];
        ctes.push(`c${ctes.length} AS (SELECT ${cols.join(', ')} FROM ${prev()})`);
        break;
      }
      case 'hasLabel': {
        const tbl = elem === 'edge' ? 'edges' : 'nodes';
        const lf = labelIn('n.label', s.args);
        ctes.push(`c${ctes.length} AS (SELECT n.id${carry()} FROM ${tbl} n JOIN ${prev()} p ON n.id=p.id WHERE ${lf.sql})`);
        binds.push(...lf.binds);
        break;
      }
      case 'has': {
        const tbl = elem === 'edge' ? 'edges' : 'nodes';
        const conds: string[] = [];
        const hbinds: any[] = [];
        let a = s.args;
        // has(label, key, value) — the 3-arg overload folds in a label filter.
        if (a.length === 3 && typeof a[0] === 'string') {
          conds.push('n.label IN (SELECT id FROM labels WHERE name=?)'); hbinds.push(a[0]);
          a = a.slice(1);
        }
        const [key, val] = a;
        if (key && typeof key === 'object' && 'token' in key) {
          // has(T.label, v|P) / has(T.id, v|P): predicate over the label name or
          // the external id (COALESCE uid,id). Routing through predicateSql means
          // both a bare value AND a P/TextP predicate work (a bare value → equality).
          const expr = key.token === 'label' ? '(SELECT name FROM labels WHERE id=n.label)'
            : key.token === 'id' ? 'COALESCE(n.uid, n.id)'
            : (() => { throw new Error(`has(T.${key.token}) not supported`); })();
          const r = render(predicateSql(sqlText(expr), val));
          conds.push(r.sql); hbinds.push(...r.binds);
        } else {
          const pe = propExtract('n.props', key); // literal path for indexable keys
          // Only node property indexes are auto-built (ensureNodePropIndex); an
          // edge has() filters correctly but stays unindexed for now.
          if (pe.indexKey && elem === 'node') indexKeys.add(pe.indexKey);
          const r = render(predicateSql(pe.expr, val));
          conds.push(r.sql); hbinds.push(...r.binds);
        }
        ctes.push(`c${ctes.length} AS (SELECT n.id${carry()} FROM ${tbl} n JOIN ${prev()} p ON n.id=p.id WHERE ${conds.join(' AND ')})`);
        binds.push(...hbinds);
        break;
      }
      case 'where': case 'filter': case 'not': {
        // A movement-phase filter CTE: join the current element (for property
        // predicates) and keep rows satisfying the nested traversal. `not()`
        // negates with COALESCE so a NULL predicate (missing prop) counts as
        // "no output" → kept, matching not(traversal) semantics.
        const arg0 = s.args[0];
        const tbl = elem === 'edge' ? 'edges' : 'nodes';
        const ctx: ScalarCtx = { elem, idExpr: 'n.id', propsExpr: 'n.props', labelIdExpr: 'n.label', srcExpr: 'n.src', tgtExpr: 'n.tgt' };
        let test: string; const fbinds: any[] = [];
        if (arg0 && typeof arg0 === 'object' && 'nested' in arg0) {
          const pred = compileFilterPredicate(stepChain(arg0.nested, params), ctx, params);
          for (const k of pred.indexKeys) indexKeys.add(k);
          test = s.name === 'not' ? `NOT COALESCE((${pred.sql}), 0)` : pred.sql;
          fbinds.push(...pred.binds);
        } else {
          // Alias-compare: where("a", P.eq("b")) (label vs label) or
          // where(P.neq("a")) (current traverser vs label), optionally .by(key)
          // to compare a property instead of element identity.
          if (s.name === 'filter') throw new Error('filter(predicate) not supported; use filter(traversal)');
          const [left, pred, leftElem]: [string, Pred, Elem] = typeof arg0 === 'string'
            ? [aliasIdExpr(arg0, aliases), s.args[1] as Pred, aliases.get(arg0)!.elem]
            : ['n.id', arg0 as Pred, elem];
          if (!(pred?.op in P_OPS)) throw new Error(`where(P.${pred?.op}) alias comparison not yet supported`);
          const right = aliasIdExpr(pred.values[0], aliases);
          const rightElem = aliases.get(pred.values[0])!.elem;
          const byKey = steps[i + 1]?.name === 'by' ? steps[i + 1].args.find((a) => typeof a === 'string') as string | undefined : undefined;
          if (byKey !== undefined) {
            // propAt reads the nodes table; an edge-typed operand would silently
            // read a vertex's props (ids collide across spaces) → reject.
            if (leftElem === 'edge' || rightElem === 'edge') throw new Error('where().by(key) on an edge-typed label not yet supported');
            const l = render(propAt(left, null, byKey).expr), r = render(propAt(right, null, byKey).expr);
            test = `${l.sql} ${P_OPS[pred.op]} ${r.sql}`; fbinds.push(...l.binds, ...r.binds);
            i++; // consume the by() modulator
          } else {
            test = `${left} ${P_OPS[pred.op]} ${right}`;
          }
          if (s.name === 'not') test = `NOT COALESCE((${test}), 0)`;
        }
        ctes.push(`c${ctes.length} AS (SELECT n.id${carry()} FROM ${tbl} n JOIN ${prev()} p ON n.id=p.id WHERE ${test})`);
        binds.push(...fbinds);
        break;
      }
      case 'and': case 'or': {
        // Filter: keep the traverser when ALL / ANY branch predicates hold.
        const tbl = elem === 'edge' ? 'edges' : 'nodes';
        const ctx: ScalarCtx = { elem, idExpr: 'n.id', propsExpr: 'n.props', labelIdExpr: 'n.label', srcExpr: 'n.src', tgtExpr: 'n.tgt' };
        const pred = combineBranchPreds(s, ctx, params, s.name === 'and' ? 'AND' : 'OR');
        for (const k of pred.indexKeys) indexKeys.add(k);
        ctes.push(`c${ctes.length} AS (SELECT n.id${carry()} FROM ${tbl} n JOIN ${prev()} p ON n.id=p.id WHERE ${pred.sql})`);
        binds.push(...pred.binds);
        break;
      }
      case 'union': {
        // UNION ALL of each branch, seeded from the current relation. Element
        // branches only (each a single movement step); the merged id-relation
        // continues downstream. Aliased/edge/scalar/multi-hop branches defer.
        if (elem !== 'node') throw new Error('union() on edges not yet supported');
        if (aliases.size > 0) throw new Error('union() after as() not yet supported');
        const branches = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
        if (branches.length < 2) throw new Error('union() needs at least two branches');
        const parts = branches.map((b) => branchMovementSelect(stepChain(b.nested, params), prev()));
        ctes.push(`c${ctes.length} AS (${parts.map((p) => p.sql).join(' UNION ALL ')})`);
        for (const p of parts) binds.push(...p.binds);
        break;
      }
      case 'optional': {
        // optional(t) = t if it yields output, else the traverser itself. A
        // single out()/in() → LEFT JOIN: matches emit the neighbour(s), a miss
        // COALESCEs back to self. both()/multi-hop/aliased defer.
        if (elem !== 'node') throw new Error('optional() on edges not yet supported');
        if (aliases.size > 0) throw new Error('optional() after as() not yet supported');
        const bs = stepChain(s.args[0]?.nested, params);
        if (bs.length !== 1 || (bs[0].name !== 'out' && bs[0].name !== 'in'))
          throw new Error(`optional(__.${bs[0]?.name}()) not yet supported (single out()/in() only)`);
        const [from, to] = dirsFor(bs[0].name)[0];
        const lf = edgeLabelFilter(bs[0].args);
        ctes.push(`c${ctes.length} AS (SELECT COALESCE(e.${to}, p.id) AS id FROM ${prev()} p LEFT JOIN edges e ON e.${from}=p.id${lf.sql})`);
        binds.push(...lf.binds);
        break;
      }
      case 'repeat': case 'emit': case 'times': case 'until': {
        // A repeat cluster: gather the contiguous repeat/emit/times/until run
        // (the modulators can sit either side of repeat()). Compile to a
        // WITH RECURSIVE walk(id, depth) seeded from the current relation.
        if (elem !== 'node') throw new Error('repeat() on edges not yet supported');
        if (aliases.size > 0) throw new Error('repeat() after as() not yet supported');
        // Gather one repeat cluster: the contiguous repeat/emit/times/until run,
        // stopping at the first REPEATED step name so a second repeat-loop isn't
        // swallowed — it compiles as a fresh cluster next iteration, correctly
        // chained on this one's output (e.g. repeat(out).times(2).repeat(in).times(1)).
        let j = i;
        const cluster: Step[] = [], seen = new Set<string>();
        while (j < steps.length && ['repeat', 'emit', 'times', 'until'].includes(steps[j].name) && !seen.has(steps[j].name)) {
          seen.add(steps[j].name); cluster.push(steps[j]); j++;
        }
        const rep = cluster.find((s) => s.name === 'repeat');
        if (!rep) throw new Error(`${s.name}() without repeat() not yet supported`);
        if (cluster.some((s) => s.name === 'until')) throw new Error('repeat().until() not yet supported');
        const emitStep = cluster.find((s) => s.name === 'emit');
        if (emitStep?.args.length) throw new Error('emit(predicate) not yet supported');
        const timesStep = cluster.find((s) => s.name === 'times');
        if (timesStep && typeof timesStep.args[0] !== 'number') throw new Error('times(predicate) not yet supported');
        // Require times(): it bounds depth to a user-given n. Unbounded forms
        // (bare emit() with no times, until()) would let the recursive walk fan
        // out to branching-factor^depth rows — deferred rather than risk exhaustion.
        if (!timesStep) throw new Error('repeat() without times() not yet supported (unbounded emit()/until() deferred)');
        const emitBefore = !!emitStep && cluster.indexOf(emitStep) < cluster.indexOf(rep);

        const body = stepChain(rep.args[0]?.nested, params);
        if (body.length !== 1 || !['out', 'in', 'both'].includes(body[0].name))
          throw new Error(`repeat(__.${body.map((s) => s.name + '()').join('.')}) not yet supported (single out()/in()/both() only)`);
        const mv = body[0];
        const maxDepth = Number(timesStep.args[0]); // always present (checked above) → bounded depth
        const lf = edgeLabelFilter(mv.args);
        const w = `w${ctes.length}`;
        const rec = dirsFor(mv.name).map(([from, to]) =>
          `SELECT e.${to} AS id, ${w}.depth + 1 AS depth FROM ${w} JOIN edges e ON e.${from}=${w}.id WHERE ${w}.depth < ${maxDepth}${lf.sql}`);
        ctes.push(`${w}(id, depth) AS (SELECT id, 0 AS depth FROM ${prev()} UNION ALL ${rec.join(' UNION ALL ')})`);
        for (const _ of dirsFor(mv.name)) binds.push(...lf.binds);
        // times() only → the final depth; emit after → every iteration (≥1);
        // emit before → also the starting traverser (≥0).
        const depthCond = !emitStep ? `depth = ${maxDepth}` : emitBefore ? 'depth >= 0' : 'depth >= 1';
        ctes.push(`c${ctes.length} AS (SELECT id FROM ${w} WHERE ${depthCond})`);
        i = j - 1; // consume the whole cluster (loop's i++ steps past it)
        break;
      }
      case 'out': case 'in': case 'both': {
        if (elem !== 'node') throw new Error(`${s.name}() expects a vertex, not an ${elem}`);
        const dirs = dirsFor(s.name);
        const lf = edgeLabelFilter(s.args);
        // Movement carries the alias columns unchanged from p while id moves to
        // the neighbour — this is what recovers "the vertex before the hop".
        const selects = dirs.map(([from, to]) =>
          `SELECT e.${to} AS id${carry()} FROM edges e JOIN ${prev()} p ON e.${from}=p.id${lf.sql}`);
        ctes.push(`c${ctes.length} AS (${selects.join(' UNION ALL ')})`);
        for (const _ of dirs) binds.push(...lf.binds);
        break;
      }
      case 'outE': case 'inE': case 'bothE': {
        // vertex → incident edges. The new id is the EDGE id; elem becomes edge.
        if (elem !== 'node') throw new Error(`${s.name}() expects a vertex, not an ${elem}`);
        const froms = s.name === 'outE' ? ['src'] : s.name === 'inE' ? ['tgt'] : ['src', 'tgt'];
        const lf = edgeLabelFilter(s.args);
        const selects = froms.map((from) =>
          `SELECT e.id AS id${carry()} FROM edges e JOIN ${prev()} p ON e.${from}=p.id${lf.sql}`);
        ctes.push(`c${ctes.length} AS (${selects.join(' UNION ALL ')})`);
        for (const _ of froms) binds.push(...lf.binds);
        elem = 'edge';
        break;
      }
      case 'outV': case 'inV': case 'bothV': {
        // edge → endpoint vertices. The new id is the NODE id; elem becomes node.
        if (elem !== 'edge') throw new Error(`${s.name}() expects an edge, not a ${elem}`);
        const cols = s.name === 'outV' ? ['src'] : s.name === 'inV' ? ['tgt'] : ['src', 'tgt'];
        const selects = cols.map((col) =>
          `SELECT e.${col} AS id${carry()} FROM edges e JOIN ${prev()} p ON e.id=p.id`);
        ctes.push(`c${ctes.length} AS (${selects.join(' UNION ALL ')})`);
        elem = 'node';
        break;
      }
      case 'dedup':
        // Bare dedup() dedups on the current object. Splicing carried alias
        // columns into the DISTINCT would make it path-distinct and silently
        // over-count (the count()-corruption trap). Defer both label-scoped
        // dedup("a") and dedup-with-active-labels rather than answer wrongly.
        if (s.args.length > 0) throw new Error('dedup(label) not yet supported');
        if (aliases.size > 0) throw new Error('dedup() after as() not yet supported (path-distinct semantics)');
        ctes.push(`c${ctes.length} AS (SELECT DISTINCT id FROM ${prev()})`);
        break;
      // limit/range/skip compose as CTEs while still on the id-relation (before
      // any order()); once order() is seen they fold into the final select as
      // tail modifiers so ORDER BY + LIMIT + OFFSET stay in one query.
      case 'limit':
        ctes.push(`c${ctes.length} AS (SELECT p.id${carry()} FROM ${prev()} p LIMIT ${Number(s.args[0])})`);
        break;
      case 'range': {
        const { offset, limit } = rangeToOffsetLimit(s.args);
        ctes.push(`c${ctes.length} AS (SELECT p.id${carry()} FROM ${prev()} p LIMIT ${limit} OFFSET ${offset})`);
        break;
      }
      case 'skip':
        ctes.push(`c${ctes.length} AS (SELECT p.id${carry()} FROM ${prev()} p LIMIT -1 OFFSET ${Number(s.args[0])})`);
        break;
      default:
        return { ctes, binds, stop: i, indexKeys, aliases, elem };
    }
  }
  return { ctes, binds, stop: i, indexKeys, aliases, elem };
}

interface OrderClause { key: string | null; dir: 'asc' | 'desc' | 'shuffle'; }

function compileRead(steps: Step[], params: Record<string, any> = {}): Compiled {
  const { ctes, binds, stop, indexKeys, aliases, elem } = traversalCtes(steps, params);
  const last = `c${ctes.length - 1}`;

  // properties() turns the traverser into a property (owner+key+value) — a shape
  // the node/edge id-relation can't carry, so it and its follow-ons (key/value/
  // element/count) compile in their own tail fn rather than the movement phase.
  if (steps[stop]?.name === 'properties')
    return compileProperties(ctes, binds, last, elem, steps.slice(stop), indexKeys, params);

  // group()/groupCount() is a barrier over the current element stream → one Map.
  if (steps[stop]?.name === 'group' || steps[stop]?.name === 'groupCount') {
    const { bys, end } = collectBys(steps, stop);
    if (end < steps.length) throw new Error(`step not implemented after ${steps[stop].name}(): ${steps[end].name}()`);
    const tbl = elem === 'edge' ? 'edges' : 'nodes';
    const ctx: ScalarCtx = { elem, idExpr: 'n.id', extIdExpr: 'COALESCE(n.uid, n.id)', propsExpr: 'n.props', labelIdExpr: 'n.label', srcExpr: 'n.src', tgtExpr: 'n.tgt' };
    const src: GroupSource = { from: `${tbl} n JOIN ${last} p ON n.id=p.id`, ctx, elem: elem === 'edge' ? 'edge' : 'vertex' };
    return compileGroup(steps[stop].name === 'groupCount', bys, src, ctes, binds, indexKeys, params);
  }

  // Tail phase: an optional projection + order()/range()/skip()/limit() and dedup.
  let projStep: Step | null = null;
  const orders: OrderClause[] = [];
  const bys: any[][] = []; // by() modulator arg-lists attached to a select/project
  let offset = 0, limit: number | null = null, distinct = false;
  let reducer: 'fold' | 'sum' | null = null; // terminal stream reducer applied after the projection
  const isPreds: any[] = []; // is(P) filters on the projected scalar (AND'd)

  const PROJECTIONS = new Set(['values', 'id', 'label', 'count', 'valueMap', 'elementMap', 'select', 'project']);
  const isMapProj = () => projStep?.name === 'select' || projStep?.name === 'project';

  for (let i = stop; i < steps.length; i++) {
    const s = steps[i];
    if (PROJECTIONS.has(s.name)) {
      if (projStep) throw new Error('only one projection step is supported per traversal');
      projStep = s;
      continue;
    }
    switch (s.name) {
      case 'order':
        // by() modulators (next steps) attach to this order; a bare order() with
        // no by() orders by element identity.
        if (steps[i + 1]?.name !== 'by') orders.push({ key: null, dir: 'asc' });
        break;
      case 'by': {
        // A by() after select()/project() is a projection modulator; otherwise
        // it modulates a preceding order().
        if (isMapProj()) { bys.push(s.args); break; }
        if (orders.length === 0 && steps[i - 1]?.name !== 'order')
          throw new Error('by() is only supported as an order() or select()/project() modulator');
        // Reject deferred modulators (mirror byToEntry) rather than let a
        // {token}/{nested} arg fall through to key=null and silently sort by id.
        const bad = s.args.find((a) => a && typeof a === 'object' && ('token' in a || 'nested' in a));
        if (bad) throw new Error('token' in bad ? `by(T.${bad.token}) modulator not yet supported` : 'by(traversal) modulator not yet supported');
        const key = s.args.find((a) => typeof a === 'string') ?? null;
        const ord = s.args.find((a) => a && typeof a === 'object' && 'order' in a);
        orders.push({ key, dir: (ord?.order ?? 'asc') as OrderClause['dir'] });
        break;
      }
      case 'range': ({ offset, limit } = rangeToOffsetLimit(s.args)); break;
      case 'skip': offset = Number(s.args[0]); break;
      case 'limit': limit = Number(s.args[0]); break;
      case 'dedup': distinct = true; break;
      case 'is':
        // is() folds into the projection WHERE (before ORDER BY/LIMIT). That's
        // only correct if no limit/range/skip preceded it — filtering commutes
        // with order() but NOT with a limit that already truncated the stream.
        if (limit !== null || offset > 0) throw new Error('is() after limit()/range()/skip() not yet supported');
        isPreds.push(s.args[0]);
        break;
      // fold()/sum() are terminal barriers over the projected stream. They must
      // be last (nothing composes after them here yet).
      case 'fold': case 'sum':
        if (reducer) throw new Error(`${s.name}() after ${reducer}() not yet supported`);
        if (i !== steps.length - 1) throw new Error(`step not implemented after ${s.name}(): ${steps[i + 1].name}()`);
        reducer = s.name;
        break;
      default:
        throw new Error(`step not implemented: ${s.name}()`);
    }
  }

  if (isMapProj())
    return compileSelectProject(projStep!, bys, aliases, ctes, binds, last, { orders, distinct, offset, limit }, indexKeys, elem);

  // Resolve the projection to a shape + a row source (cols/from/where).
  const projName = projStep?.name ?? 'vertex';
  let shape: Shape;
  const fb: any[] = []; // final-select binds, appended after the CTE-prefix binds

  if (reducer && projName === 'count') throw new Error(`${reducer}() after count() not yet supported`);

  // count folds any tail limit/offset/distinct into the counted id-relation.
  if (projName === 'count') {
    let src = `SELECT ${distinct ? 'DISTINCT ' : ''}id FROM ${last}`;
    if (limit !== null || offset > 0) src += ` LIMIT ${limit ?? -1} OFFSET ${offset}`;
    let sql = `SELECT COUNT(*) AS v FROM (${src})`;
    // count().is(P): filter the single count value (0 or 1 result rows).
    const cb: any[] = [];
    if (isPreds.length) sql = `SELECT v FROM (${sql}) WHERE ${isPreds.map((p) => { const q = render(predicateSql(sqlText('v'), p)); cb.push(...q.binds); return q.sql; }).join(' AND ')}`;
    return { kind: 'read', sql: `WITH RECURSIVE ${ctes.join(',\n')}\n${sql}`, binds: [...binds, ...cb], shape: { kind: 'count' }, indexKeys: [...indexKeys] };
  }

  // The current element's table; `n` is the element row regardless of kind.
  const tbl = elem === 'edge' ? 'edges' : 'nodes';
  const vJoin = `${tbl} n JOIN ${last} p ON n.id=p.id`;
  const vlJoin = `${vJoin} JOIN labels l ON l.id=n.label`;
  let cols: string, from: string, where = '';
  // The projected scalar expression (+ its binds), captured so a trailing is(P)
  // can filter on it. Non-scalar projections leave it null → is() throws.
  let scalarExpr: Expression | null = null;
  // An element reports its user id when it has one, else the rowid. Used only in
  // the outward-facing projection — the id-relation joins keep the raw rowid.
  const extId = 'COALESCE(n.uid, n.id)';
  switch (projName) {
    case 'values': {
      shape = { kind: 'value' };
      const pe = propExtract('n.props', projStep!.args[0]);
      const r = render(pe.expr);
      cols = `${r.sql} AS v`; from = vJoin;
      where = ` WHERE ${r.sql} IS NOT NULL`;
      fb.push(...r.binds, ...r.binds); // one set for the SELECT, one for the WHERE
      scalarExpr = pe.expr;
      // values(k).is(P) is a filter-position use → auto-index the key (like has());
      // a bare values() projection is deliberately NOT indexed (bounds proliferation).
      if (isPreds.length && pe.indexKey && elem === 'node') indexKeys.add(pe.indexKey);
      break;
    }
    case 'id':
      // Join the element table even though the id lives in `last`, so a preceding
      // order().by(key) — which references n.props — has the alias in scope.
      shape = { kind: 'value' }; cols = `${extId} AS v`; from = vJoin; scalarExpr = sqlText(extId); break;
    case 'label':
      shape = { kind: 'value' }; cols = `l.name AS v`; from = vlJoin; scalarExpr = sqlText('l.name'); break;
    case 'valueMap': {
      const keys = projStep!.args.filter((a) => typeof a === 'string') as string[];
      shape = { kind: 'valueMap', keys: keys.length ? keys : null, tokens: projStep!.args.includes(true) };
      cols = `${extId} AS id, l.name AS label, n.props`; from = vlJoin; break;
    }
    case 'elementMap': {
      if (elem === 'edge') throw new Error('elementMap() on edges not yet supported'); // needs IN/OUT direction tokens
      const keys = projStep!.args.filter((a) => typeof a === 'string') as string[];
      shape = { kind: 'elementMap', keys: keys.length ? keys : null };
      cols = `${extId} AS id, l.name AS label, n.props`; from = vlJoin; break;
    }
    default: // the element itself
      if (elem === 'edge') { shape = { kind: 'edge' }; cols = `${extId} AS id, l.name AS label, n.src, n.tgt, n.props`; from = vlJoin; }
      else { shape = { kind: 'vertex' }; cols = `${extId} AS id, l.name AS label, n.props`; from = vlJoin; }
  }

  // is(P): filter the projected scalar. Folds into the WHERE so a following
  // order()/limit() still composes; non-scalar projections reject it.
  if (isPreds.length) {
    if (!scalarExpr) throw new Error('is() requires a scalar stream (values/label/id/count)');
    for (const p of isPreds) {
      const q = render(predicateSql(scalarExpr, p));
      where += where ? ` AND ${q.sql}` : ` WHERE ${q.sql}`;
      fb.push(...q.binds);
    }
  }

  let sql = `SELECT ${distinct ? 'DISTINCT ' : ''}${cols} FROM ${from}${where}`;

  if (orders.length) {
    const parts = orders.map((o) => {
      if (o.dir === 'shuffle') return 'RANDOM()';
      const dir = o.dir === 'desc' ? 'DESC' : 'ASC';
      if (o.key !== null) {
        const pe = propExtract('n.props', o.key); const r = render(pe.expr); fb.push(...r.binds);
        if (pe.indexKey && elem === 'node') indexKeys.add(pe.indexKey); // order().by(key) sorts via the index (node-only auto-index)
        return `${r.sql} ${dir}`;
      }
      return `${shape.kind === 'value' ? 'v' : 'n.id'} ${dir}`;
    });
    sql += ` ORDER BY ${parts.join(', ')}`;
  }
  if (limit !== null || offset > 0) sql += ` LIMIT ${limit ?? -1} OFFSET ${offset}`;

  // Terminal reducers wrap the projected select. fold() → the whole stream as one
  // List (handler collapses rows); sum() → one numeric via SQL SUM.
  if (reducer === 'fold') {
    const fe: ElemShape | 'scalar' =
      shape.kind === 'vertex' ? 'vertex' : shape.kind === 'edge' ? 'edge' :
      shape.kind === 'value' ? 'scalar' : (() => { throw new Error(`fold() of ${shape.kind} not yet supported`); })();
    shape = { kind: 'list', elem: fe };
  } else if (reducer === 'sum') {
    if (shape.kind !== 'value') throw new Error(`sum() of ${shape.kind} not yet supported`);
    // typeof(SUM) is 'integer' or 'real' → the handler frames Int/Long vs Double
    // to match TinkerPop (sum of ints → Int/Long by magnitude; of doubles → Double).
    sql = `SELECT SUM(v) AS v, typeof(SUM(v)) AS vt FROM (${sql})`;
    shape = { kind: 'scalar' };
  }

  return { kind: 'read', sql: `WITH RECURSIVE ${ctes.join(',\n')}\n${sql}`, binds: [...binds, ...fb], shape, indexKeys: [...indexKeys] };
}

interface TailMods { orders: OrderClause[]; distinct: boolean; offset: number; limit: number | null; }

/** Interpret one by() modulator's args into a projected sub-value kind. */
function byToEntry(byArgs: any[] | undefined): { sub: 'vertex' | 'value'; key?: string } {
  if (!byArgs || byArgs.length === 0) return { sub: 'vertex' }; // no by() / bare by() → the element itself
  const a = byArgs[0];
  if (typeof a === 'string') return { sub: 'value', key: a };
  if (a && typeof a === 'object' && 'nested' in a) throw new Error('by(traversal) modulator not yet supported');
  if (a && typeof a === 'object' && 'token' in a) throw new Error(`by(T.${a.token}) modulator not yet supported`);
  throw new Error('unsupported by() modulator');
}

// ---------- nested-traversal by() → correlated scalar (shared with where) ----------

/** SQL exprs for the current traverser's base fields, in terms of the outer row
 *  (aliased `n`). A nested by(__.…) compiles to a scalar expression correlated
 *  on these. Property context carries the json_each expansion's columns. */
export interface ScalarCtx {
  elem: 'node' | 'edge' | 'property';
  idExpr: string;        // n.id  (rowid — for correlated joins)
  extIdExpr?: string;    // COALESCE(n.uid, n.id) — the outward-facing id for framing
  propsExpr: string;     // n.props   (base row, directly readable)
  labelIdExpr: string;   // n.label
  srcExpr?: string;      // n.src  (edge)
  tgtExpr?: string;      // n.tgt  (edge)
  ownerExpr?: string;      // property: owning node id
  ownerPropsExpr?: string; // property: owner props (directly readable)
  pkExpr?: string;         // property: key column
  pvExpr?: string;         // property: value column
}

interface Scalar { expr: Expression; indexKey: string | null }

const labelNameSub = (labelIdExpr: string) => `(SELECT name FROM labels WHERE id=${labelIdExpr})`;

/** json_extract of a property on a node identified by `nodeId`. `directProps`,
 *  when set, is a props column already in scope (base row) → read it inline;
 *  otherwise correlate a subquery into nodes. */
function propAt(nodeId: string, directProps: string | null, key: unknown): Scalar {
  if (directProps) return propExtract(directProps, key);
  // Correlated subquery: keep the json_extract node as a child so any exotic-key
  // bind stays a Value token (nodeId is a bind-free fragment → raw text()).
  const pe = propExtract('props', key);
  return { expr: expression(sqlText('(SELECT'), pe.expr, sqlText(`FROM nodes WHERE id=${nodeId})`)), indexKey: null };
}

/**
 * Compile a nested traversal (the node inside by(__.…)/where(__.…)) to a
 * correlated SQL scalar expression. Focused on the proven step set — the L3
 * gate's key/value sub-traversals plus common where idioms:
 *   node ctx:  values(k) | label() | id() | out|in|both([lbl])…count()
 *   edge ctx:  outV|inV()[.values(k)|.label()|.id()] | values(k) | label() | id()
 *   prop ctx:  key() | value() | element()[.values(k)|.label()|.id()]
 * Anything past this throws clearly (never silently mis-executes).
 */
function compileNestedScalar(inner: Step[], ctx: ScalarCtx): Scalar {
  let steps = inner;
  // A pointer to the "current node" for terminal value/label/id reads.
  let nodeId: string;
  let directProps: string | null;   // props readable inline (base row), else null → subquery
  let directLabelId: string | null; // label id readable inline, else null → subquery via nodes

  const head = steps[0]?.name;
  if (!head) throw new Error('empty nested traversal');

  if (ctx.elem === 'property') {
    if (head === 'key') { requireTerminal(steps, 1); return { expr: sqlText(ctx.pkExpr!), indexKey: null }; }
    if (head === 'value') { requireTerminal(steps, 1); return { expr: sqlText(ctx.pvExpr!), indexKey: null }; }
    if (head === 'element') { nodeId = ctx.ownerExpr!; directProps = ctx.ownerPropsExpr!; directLabelId = null; steps = steps.slice(1); }
    else throw new Error(`by(__.${head}()) over a property not yet supported`);
  } else if (ctx.elem === 'edge') {
    if (head === 'outV' || head === 'inV') { nodeId = head === 'outV' ? ctx.srcExpr! : ctx.tgtExpr!; directProps = null; directLabelId = null; steps = steps.slice(1); }
    else if (head === 'label') { requireTerminal(steps, 1); return { expr: sqlText(labelNameSub(ctx.labelIdExpr)), indexKey: null }; }
    else if (head === 'id') { requireTerminal(steps, 1); return { expr: sqlText(ctx.idExpr), indexKey: null }; }
    else if (head === 'values') { requireTerminal(steps, 1); return propAt(ctx.idExpr, ctx.propsExpr, steps[0].args[0]); }
    // out()/in()/both() are NOT valid on an edge (must go through outV()/inV());
    // routing them to edgeCountFrom here would compare edges.src to the edge's own
    // id and silently mis-count, so let them hit the clear throw below.
    else throw new Error(`by(__.${head}()) over an edge not yet supported`);
  } else { // node
    nodeId = ctx.idExpr; directProps = ctx.propsExpr; directLabelId = ctx.labelIdExpr;
    if (MOVES.has(head)) return edgeCountFrom(steps, ctx.idExpr);
  }

  // Terminal projection on the resolved current node.
  const s = steps[0];
  if (!s) throw new Error('nested traversal resolves to no projection');
  switch (s.name) {
    case 'values': requireTerminal(steps, 1); return propAt(nodeId, directProps, s.args[0]);
    case 'label':  requireTerminal(steps, 1); return { expr: sqlText(labelNameSub(directLabelId ?? `(SELECT label FROM nodes WHERE id=${nodeId})`)), indexKey: null };
    case 'id':     requireTerminal(steps, 1); return { expr: sqlText(nodeId), indexKey: null };
    default: throw new Error(`by(__.${s.name}()) not yet supported`);
  }
}

/** Vertex→edge/neighbour movement steps (count/EXISTS both key off these). */
const MOVES = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE']);

/** out/in/both/outE/inE/bothE([label])…count() → a correlated edge count on the
 *  outer node. The E-suffixed forms count the same incident edges (1:1 with the
 *  neighbour hop), so direction is the un-suffixed base. */
function edgeCountFrom(steps: Step[], nodeIdExpr: string): Scalar {
  const mv = steps[0];
  if (steps[1]?.name !== 'count' || steps.length > 2)
    throw new Error(`by(__.${mv.name}(…)) only supports a terminal count() for now`);
  const dirs = dirsFor(mv.name.endsWith('E') ? mv.name.slice(0, -1) : mv.name);
  const lblFilter = (): Expression => mv.args.length
    ? expression(sqlText('AND label IN (SELECT id FROM labels WHERE name IN'), parens(mv.args.map(value)), sqlText(')'))
    : sqlText('');
  const terms = dirs.map(([from]) =>
    expression(sqlText(`(SELECT COUNT(*) FROM edges WHERE ${from}=${nodeIdExpr}`), lblFilter(), sqlText(')')));
  return { expr: terms.length === 1 ? terms[0] : expression(sqlText('('), list(terms, sqlText(' + ')), sqlText(')')), indexKey: null };
}

const requireTerminal = (steps: Step[], n: number) => {
  if (steps.length > n) throw new Error(`step not implemented in nested traversal: ${steps[n].name}()`);
};

// ---------- where()/not()/filter(__.…) → a boolean filter predicate ----------

/**
 * Compile a where()/filter() nested traversal into a boolean SQL predicate
 * correlated on the current traverser (for `WHERE [NOT] <pred>`). Supported:
 *   __.<move>.count().is(P)   → correlated count compared (reuses compileNestedScalar)
 *   __.values(k)[.is(P)]      → current-property predicate (bare → IS NOT NULL)
 *   __.has(k[,v]) / hasLabel  → current-element predicate
 *   __.<move>([label])        → EXISTS over incident edges (bare "has a neighbour")
 *   __.and(t…) / __.or(t…)    → the branch predicates combined with AND / OR
 * Multi-hop / neighbour-terminal-filter are deferred with clear errors.
 */
function compileFilterPredicate(nested: Step[], ctx: ScalarCtx, params: Record<string, any> = {}): { sql: string; binds: any[]; indexKeys: string[] } {
  const indexKeys: string[] = [];
  let body = nested;
  let isPred: any = undefined, hasIs = false;
  if (body[body.length - 1]?.name === 'is') { isPred = body[body.length - 1].args[0]; hasIs = true; body = body.slice(0, -1); }

  const head = body[0]?.name;
  if (!head) throw new Error('empty where()/filter() traversal');

  // and(t…)/or(t…): combine each branch's predicate. (infix .and()/.or() — a
  // multi-step body — is not this shape and falls through to the deferred throw.)
  if ((head === 'and' || head === 'or') && body.length === 1)
    return combineBranchPreds(body[0], ctx, params, head === 'and' ? 'AND' : 'OR');

  const term = body[body.length - 1]?.name;

  // A reducing scalar (count/sum) compared by is(P). Bare (no is) always yields
  // one value → the traverser always passes, so it's a no-op filter.
  if (term === 'count' || term === 'sum') {
    if (!hasIs) return { sql: '1', binds: [], indexKeys };
    const sc = compileNestedScalar(body, ctx);
    const q = render(predicateSql(sc.expr, isPred));
    return { sql: q.sql, binds: q.binds, indexKeys };
  }

  // Current-element predicates (no movement).
  if (head === 'values' && body.length === 1) {
    const pe = propExtract(ctx.propsExpr, body[0].args[0]);
    if (pe.indexKey && ctx.elem === 'node') indexKeys.push(pe.indexKey);
    const q = render(predicateSql(pe.expr, hasIs ? isPred : undefined)); // bare where(__.values(k)) → exists → IS NOT NULL
    return { sql: q.sql, binds: q.binds, indexKeys };
  }
  if (head === 'has' && body.length === 1 && typeof body[0].args[0] === 'string') {
    const pe = propExtract(ctx.propsExpr, body[0].args[0]);
    if (pe.indexKey && ctx.elem === 'node') indexKeys.push(pe.indexKey);
    const q = render(predicateSql(pe.expr, body[0].args[1]));
    return { sql: q.sql, binds: q.binds, indexKeys };
  }
  if (head === 'hasLabel' && body.length === 1) {
    const ph = body[0].args.map(() => '?').join(',');
    return { sql: `${ctx.labelIdExpr} IN (SELECT id FROM labels WHERE name IN (${ph}))`, binds: [...body[0].args], indexKeys };
  }

  if (MOVES.has(head) && body.length === 1) {
    // where(__.out().is(P)) would mean "has a neighbour satisfying P" — the bare
    // EXISTS ignores P, so reject rather than silently drop it.
    if (hasIs) throw new Error(`where(__.${head}().is(P)) not yet supported`);
    return { ...compileExists(body[0], ctx), indexKeys };
  }
  throw new Error(`where()/filter() form not yet supported: __.${body.map((s) => s.name + '()').join('.')}`);
}

/** and(t…)/or(t…): each branch → a filter predicate, joined by AND/OR. Used both
 *  as a top-level filter step and inside where(__.and/or). */
function combineBranchPreds(step: Step, ctx: ScalarCtx, params: Record<string, any>, op: 'AND' | 'OR'): { sql: string; binds: any[]; indexKeys: string[] } {
  const branches = step.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 2) throw new Error(`${step.name}() needs at least two traversal branches`);
  const binds: any[] = [], indexKeys: string[] = [];
  const parts = branches.map((b) => {
    const p = compileFilterPredicate(stepChain(b.nested, params), ctx, params);
    binds.push(...p.binds); indexKeys.push(...p.indexKeys);
    return `(${p.sql})`;
  });
  return { sql: `(${parts.join(` ${op} `)})`, binds, indexKeys };
}

/** EXISTS over a single incident-edge movement (out/in/both/outE/inE/bothE),
 *  correlated on the outer node. "Does this vertex have such a neighbour/edge." */
function compileExists(mv: Step, ctx: ScalarCtx): { sql: string; binds: any[] } {
  if (ctx.elem !== 'node') throw new Error(`where(__.${mv.name}()) expects a vertex, not an ${ctx.elem}`);
  const dirs = dirsFor(mv.name.endsWith('E') ? mv.name.slice(0, -1) : mv.name);
  const lf = edgeLabelFilter(mv.args);
  const binds: any[] = [];
  const terms = dirs.map(([from]) => { binds.push(...lf.binds); return `EXISTS(SELECT 1 FROM edges e WHERE e.${from}=${ctx.idExpr}${lf.sql})`; });
  return { sql: terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`, binds };
}

/**
 * select(labels…)/project(keys…). select reads previously-labelled traversers
 * from their alias columns; project applies its by() modulators to the current
 * traverser under freshly-named keys. by() modulators cycle across the keys
 * (`by('name')` alone → applied to all; `.by('age').by('name')` → key0/key1/…).
 * A single-key select reuses the scalar vertex/value shape; anything else is a
 * per-row Map ({kind:'map'}).
 */
function compileSelectProject(
  proj: Step, bys: any[][], aliases: AliasMap,
  ctes: string[], binds: any[], last: string, tail: TailMods, indexKeys: Set<string>, curElem: Elem,
): Compiled {
  const { orders, distinct, offset, limit } = tail;
  if (orders.length) throw new Error('order() after select()/project() not yet supported');
  const isProject = proj.name === 'project';
  const fb: any[] = [];

  // Reject the deferred long-tail forms explicitly (tokens are now captured, not
  // silently dropped) so a Pop/Column arg can never mis-execute as a plain key.
  const pop = proj.args.find((a) => a && typeof a === 'object' && 'pop' in a) as { pop: string } | undefined;
  if (pop && pop.pop !== 'last') throw new Error(`select(Pop.${pop.pop}) not yet supported`);
  if (proj.args.some((a) => a && typeof a === 'object' && 'column' in a)) throw new Error('select(Column) not yet supported');

  const keys = proj.args.filter((a): a is string => typeof a === 'string');
  if (!keys.length) throw new Error(`${proj.name}() requires at least one key`);

  // The `last`-CTE column holding each key's element id, and the element kind it
  // holds: project → current traverser (p.id); select → the label's alias column
  // (must have been bound). The joins below assume a vertex — an edge-typed
  // source would silently join the wrong table (nodes), so reject it clearly
  // (edge-valued select/project waits on the edge-shape map work).
  const sourceOf = (k: string): string => {
    if (isProject) {
      if (curElem === 'edge') throw new Error('project() of an edge is not yet supported');
      return 'p.id';
    }
    const entry = aliases.get(k);
    if (!entry) throw new Error(`select("${k}"): no such label — as("${k}") was not seen`);
    if (entry.elem === 'edge') throw new Error(`select("${k}") of an edge-typed label is not yet supported`);
    return `p.${entry.col}`;
  };
  const entryKind = (i: number) => byToEntry(bys.length ? bys[i % bys.length] : undefined);

  const tailSql = (limit !== null || offset > 0) ? ` LIMIT ${limit ?? -1} OFFSET ${offset}` : '';
  const withPrefix = `WITH RECURSIVE ${ctes.join(',\n')}\n`;

  // Single-key select → the labelled element directly (not wrapped in a Map),
  // reusing the existing vertex/value shapes so the handler needs no new case.
  if (!isProject && keys.length === 1) {
    const src = sourceOf(keys[0]);
    const e = entryKind(0);
    if (e.sub === 'vertex') {
      const sql = `SELECT ${distinct ? 'DISTINCT ' : ''}COALESCE(n.uid, n.id) AS id, l.name AS label, n.props FROM nodes n JOIN ${last} p ON n.id=${src} JOIN labels l ON l.id=n.label${tailSql}`;
      return { kind: 'read', sql: withPrefix + sql, binds, shape: { kind: 'vertex' }, indexKeys: [...indexKeys] };
    }
    // A by(key) here is a projection, not a filter/order — deliberately NOT
    // reported as an indexKey (matches values(); bounds index proliferation).
    const pe = render(propExtract('n.props', e.key).expr); fb.push(...pe.binds);
    const sql = `SELECT ${distinct ? 'DISTINCT ' : ''}${pe.sql} AS v FROM nodes n JOIN ${last} p ON n.id=${src}${tailSql}`;
    return { kind: 'read', sql: withPrefix + sql, binds: [...binds, ...fb], shape: { kind: 'value' }, indexKeys: [...indexKeys] };
  }

  // Multi-key select / any project → a Map per row. Each entry joins nodes for
  // its source element under a distinct alias and emits prefixed columns.
  const cols: string[] = [];
  const joins: string[] = [`${last} p`];
  const entries: MapEntry[] = keys.map((k, i) => {
    const prefix = `e${i}`;
    const e = entryKind(i);
    const src = sourceOf(k);
    joins.push(`JOIN nodes ${prefix}n ON ${prefix}n.id=${src}`);
    if (e.sub === 'vertex') {
      joins.push(`JOIN labels ${prefix}l ON ${prefix}l.id=${prefix}n.label`);
      cols.push(`COALESCE(${prefix}n.uid, ${prefix}n.id) AS ${prefix}_id`, `${prefix}l.name AS ${prefix}_label`, `${prefix}n.props AS ${prefix}_props`);
    } else {
      const pe = render(propExtract(`${prefix}n.props`, e.key).expr); fb.push(...pe.binds); // projection, not indexed
      cols.push(`${pe.sql} AS ${prefix}_v`);
    }
    return { key: k, prefix, sub: e.sub };
  });

  const sql = `SELECT ${distinct ? 'DISTINCT ' : ''}${cols.join(', ')} FROM ${joins.join(' ')}${tailSql}`;
  return { kind: 'read', sql: withPrefix + sql, binds: [...binds, ...fb], shape: { kind: 'map', entries }, indexKeys: [...indexKeys] };
}

// ---------- group()/groupCount() (barrier → one Map) ----------

/** Describes the row source a group() folds over: the FROM (rows aliased `n`),
 *  the scalar context for nested key/value sub-traversals, and the element kind
 *  a bare key / element value frames as. */
interface GroupSource { from: string; ctx: ScalarCtx; elem: ElemShape; }

/** Columns that frame one element (vertex/edge/property) under `prefix`, using
 *  base exprs from ctx. label rides as a subquery so the FROM needs no labels join. */
function elementSelect(elem: ElemShape, prefix: string, ctx: ScalarCtx): string {
  if (elem === 'edge')
    return `${ctx.extIdExpr ?? ctx.idExpr} AS ${prefix}_id, ${labelNameSub(ctx.labelIdExpr)} AS ${prefix}_label, ${ctx.srcExpr} AS ${prefix}_src, ${ctx.tgtExpr} AS ${prefix}_tgt, ${ctx.propsExpr} AS ${prefix}_props`;
  if (elem === 'property')
    return `${ctx.ownerExpr} AS ${prefix}_owner, ${ctx.pkExpr} AS ${prefix}_pk, ${ctx.pvExpr} AS ${prefix}_pv`;
  return `${ctx.extIdExpr ?? ctx.idExpr} AS ${prefix}_id, ${labelNameSub(ctx.labelIdExpr)} AS ${prefix}_label, ${ctx.propsExpr} AS ${prefix}_props`;
}

/** The SQL expr to GROUP BY / frame an element by identity. */
const elementIdExpr = (elem: ElemShape, ctx: ScalarCtx) =>
  elem === 'property' ? ctx.pkExpr! : ctx.idExpr;

/** Collect the by() modulator arg-lists immediately following step `i`; returns
 *  them plus the index of the first non-by step (for trailing-step rejection). */
function collectBys(steps: Step[], i: number): { bys: any[][]; end: number } {
  const bys: any[][] = [];
  let j = i + 1;
  for (; j < steps.length && steps[j].name === 'by'; j++) bys.push(steps[j].args);
  return { bys, end: j };
}

interface GroupKeyBuild { desc: GroupKey; cols: string; group: string; binds: any[] }

/** Build the key columns for group(). `params` re-parses nested project()/by(). */
function buildGroupKey(keyArgs: any[] | undefined, src: GroupSource, indexKeys: Set<string>, params: Record<string, any>): GroupKeyBuild {
  const binds: any[] = [];
  // Bare by() (or no key by()) → the element itself is the key.
  if (!keyArgs || keyArgs.length === 0) {
    if (src.elem === 'property') throw new Error('group().by() on a property element is not yet supported');
    return { desc: { kind: 'element', elem: src.elem }, cols: elementSelect(src.elem, 'k', src.ctx), group: elementIdExpr(src.elem, src.ctx), binds };
  }
  const a = keyArgs[0];
  if (typeof a === 'string') { // by('name')
    const pe = propExtract(src.ctx.propsExpr, a); // property ctx sets propsExpr = ownerProps
    if (pe.indexKey && src.elem === 'vertex') indexKeys.add(pe.indexKey);
    const r = render(pe.expr); binds.push(...r.binds);
    return { desc: { kind: 'scalar' }, cols: `${r.sql} AS gk`, group: 'gk', binds };
  }
  if (a && typeof a === 'object' && 'token' in a) { // by(T.label)/by(T.id)
    const expr = a.token === 'label' ? labelNameSub(src.ctx.labelIdExpr) : a.token === 'id' ? src.ctx.idExpr : null;
    if (!expr) throw new Error(`group().by(T.${a.token}) not yet supported`);
    return { desc: { kind: 'scalar' }, cols: `${expr} AS gk`, group: 'gk', binds };
  }
  if (a && typeof a === 'object' && 'nested' in a) {
    const inner = stepChain(a.nested, params);
    if (inner[0]?.name === 'project') { // composite Map key
      const keys = inner[0].args.filter((x: any): x is string => typeof x === 'string');
      const partBys = inner.slice(1);
      if (partBys.some((s) => s.name !== 'by')) throw new Error(`step not implemented in group().by(project): ${partBys.find((s) => s.name !== 'by')!.name}()`);
      if (partBys.length !== keys.length) throw new Error('group().by(project) needs one by() per key');
      const cols: string[] = [], group: string[] = [];
      keys.forEach((k, idx) => {
        const nb = partBys[idx].args.find((x: any) => x && typeof x === 'object' && 'nested' in x);
        if (!nb) throw new Error('group().by(project(...).by(x)) requires a traversal in each by()');
        const sc = render(compileNestedScalar(stepChain(nb.nested, params), src.ctx).expr);
        binds.push(...sc.binds); cols.push(`${sc.sql} AS k${idx}_v`); group.push(`k${idx}_v`);
      });
      return { desc: { kind: 'map', parts: keys.map((k) => ({ key: k })) }, cols: cols.join(', '), group: group.join(', '), binds };
    }
    const sc = render(compileNestedScalar(inner, src.ctx).expr); // by(__.label()) etc → scalar
    binds.push(...sc.binds);
    return { desc: { kind: 'scalar' }, cols: `${sc.sql} AS gk`, group: 'gk', binds };
  }
  throw new Error('unsupported group().by() key modulator');
}

/**
 * group()/groupCount(): fold the whole stream into one Map. Dual-path (locked
 * decision #3): a scalar-reducing value (count/sum) or scalar list becomes a SQL
 * GROUP BY aggregate; an element value (default list / by(__.tail()) / fold of
 * elements) can't be aggregated in SQL (props must be framed), so we emit the
 * rows ORDER BY the key and the handler folds runs into the Map. Both shapes are
 * one Map buffer; the handler's assembler is one loop keyed on GroupVal.kind.
 */
function compileGroup(isCount: boolean, bys: any[][], src: GroupSource, ctes: string[], binds: any[], indexKeys: Set<string>, params: Record<string, any>): Compiled {
  // Only key (bys[0]) and value (bys[1]) modulators are read; reject extras
  // rather than silently drop them (the file's no-silent-drop discipline).
  if (bys.length > 2) throw new Error('group() with more than two by() modulators not yet supported');
  const withPrefix = `WITH RECURSIVE ${ctes.join(',\n')}\n`;
  const key = buildGroupKey(bys[0], src, indexKeys, params);
  const fb: any[] = [...key.binds];

  // Resolve the value reducer.
  let val: GroupVal, valSql: string, groupBy = true;
  const valArgs = bys[1];
  if (isCount) { val = { kind: 'count' }; valSql = 'COUNT(*) AS gv'; }
  else if (!valArgs || valArgs.length === 0) { val = { kind: 'elementList', elem: src.elem }; groupBy = false; valSql = elementSelect(src.elem, 'v', src.ctx); }
  else {
    const a = valArgs[0];
    if (typeof a === 'string') { // by('age') → list of scalars
      const pe = render(propExtract(src.ctx.propsExpr, a).expr); // property ctx sets propsExpr = ownerProps
      fb.push(...pe.binds); val = { kind: 'scalarList' }; valSql = `json_group_array(${pe.sql}) AS gv`;
    } else if (a && typeof a === 'object' && 'nested' in a) {
      const inner = stepChain(a.nested, params);
      const names = inner.map((s) => s.name);
      if (names.length === 1 && names[0] === 'tail') { val = { kind: 'elementLast', elem: src.elem }; groupBy = false; valSql = elementSelect(src.elem, 'v', src.ctx); }
      else if (names.length === 1 && names[0] === 'fold') { val = { kind: 'elementList', elem: src.elem }; groupBy = false; valSql = elementSelect(src.elem, 'v', src.ctx); }
      else if (names.length === 1 && names[0] === 'count') { val = { kind: 'count' }; valSql = 'COUNT(*) AS gv'; }
      else if (names[names.length - 1] === 'sum') {
        const sc = render(compileNestedScalar(inner.slice(0, -1), src.ctx).expr); fb.push(...sc.binds, ...sc.binds);
        val = { kind: 'sum' }; valSql = `SUM(${sc.sql}) AS gv, typeof(SUM(${sc.sql})) AS gvt`; // gvt → Int/Long vs Double
      } else { // scalar projection folded to a list, e.g. by(__.label()) / by(__.values("name"))
        const sc = render(compileNestedScalar(inner, src.ctx).expr); fb.push(...sc.binds);
        val = { kind: 'scalarList' }; valSql = `json_group_array(${sc.sql}) AS gv`;
      }
    } else throw new Error('unsupported group().by() value modulator');
  }

  const sql = groupBy
    ? `SELECT ${key.cols}, ${valSql} FROM ${src.from} GROUP BY ${key.group}`
    : `SELECT ${key.cols}, ${valSql} FROM ${src.from} ORDER BY ${key.group}`;
  return { kind: 'read', sql: withPrefix + sql, binds: [...binds, ...fb], shape: { kind: 'group', key: key.desc, val }, indexKeys: [...indexKeys] };
}

/**
 * properties()/properties(keys) on the current element, plus an optional single
 * follow-on: key()/value()/count(), or element()[.values(k)/.id()/.label()/
 * .count()]. The traverser is a property — a json_each expansion over the
 * owner's props — carrying owner id/label/props + the property key(pk)/value(pv).
 * Chains that traverse on past element() (e.g. properties().element().out()) and
 * property predicates (hasKey/hasValue) are deferred to later work.
 */
function compileProperties(
  ctes: string[], binds: any[], last: string, elem: Elem, tail: Step[], indexKeys: Set<string>,
  params: Record<string, any> = {},
): Compiled {
  const tbl = elem === 'edge' ? 'edges' : 'nodes';
  const keys = tail[0].args.filter((a): a is string => typeof a === 'string');
  const fb: any[] = [];
  const keyFilter = keys.length ? ` WHERE je.key IN (${keys.map(() => '?').join(',')})` : '';
  if (keys.length) fb.push(...keys);
  // Expand each element's JSON props into (owner, key, value) rows; keep the
  // owner's label/props too so a following element() projection has them.
  const pc = `c${ctes.length}`;
  const propCte = `${pc} AS (SELECT n.id AS owner, l.name AS ownerLabel, n.props AS ownerProps, je.key AS pk, je.value AS pv FROM ${tbl} n JOIN ${last} p ON n.id=p.id JOIN labels l ON l.id=n.label, json_each(n.props) je${keyFilter})`;
  const allCtes = [...ctes, propCte];
  const withPrefix = `WITH RECURSIVE ${allCtes.join(',\n')}\n`;
  // `consumed` = how many tail steps this shape accounts for; reject any trailing
  // steps rather than silently dropping them (matches the file's discard-discipline).
  const done = (sql: string, shape: Shape, consumed: number): Compiled => {
    if (tail.length > consumed)
      throw new Error(`step not implemented after properties(): ${tail[consumed].name}()`);
    return { kind: 'read', sql: withPrefix + sql, binds: [...binds, ...fb], shape, indexKeys: [...indexKeys] };
  };

  const next = tail[1]?.name;

  // properties().group()/.groupCount() — group over the property stream. The
  // gate's getVertexProperties() caching traversal lives here.
  if (next === 'group' || next === 'groupCount') {
    const { bys, end } = collectBys(tail, 1);
    if (end < tail.length) throw new Error(`step not implemented after properties().${next}(): ${tail[end].name}()`);
    const ctx: ScalarCtx = { elem: 'property', idExpr: 'owner', propsExpr: 'ownerProps', labelIdExpr: '(SELECT label FROM nodes WHERE id=owner)', ownerExpr: 'owner', ownerPropsExpr: 'ownerProps', pkExpr: 'pk', pvExpr: 'pv' };
    const src: GroupSource = { from: pc, ctx, elem: 'property' };
    return compileGroup(next === 'groupCount', bys, src, allCtes, [...binds, ...fb], indexKeys, params);
  }

  switch (next) {
    case undefined: // properties() terminal → VertexProperty elements
      return done(`SELECT owner, pk, pv FROM ${pc}`, { kind: 'property' }, 1);
    case 'key':
      return done(`SELECT pk AS v FROM ${pc}`, { kind: 'value' }, 2);
    case 'value':
      return done(`SELECT pv AS v FROM ${pc}`, { kind: 'value' }, 2);
    case 'count':
      return done(`SELECT COUNT(*) AS v FROM ${pc}`, { kind: 'count' }, 2);
    case 'element': {
      // Back to the owning element. Support a terminal projection off it.
      const after = tail[2]?.name;
      // Bare element() needs the full owner element; for an edge that means
      // src/tgt cols the property CTE doesn't carry, so defer just that case.
      // Scalar projections (.id/.label/.values/.count) need no such cols.
      if (elem === 'edge' && after === undefined)
        throw new Error('element() of an edge property not yet supported');
      switch (after) {
        case undefined:
          return done(`SELECT owner AS id, ownerLabel AS label, ownerProps AS props FROM ${pc}`, { kind: 'vertex' }, 2);
        case 'id':
          return done(`SELECT owner AS v FROM ${pc}`, { kind: 'value' }, 3);
        case 'label':
          return done(`SELECT ownerLabel AS v FROM ${pc}`, { kind: 'value' }, 3);
        case 'values': {
          const pe = render(propExtract('ownerProps', tail[2].args[0]).expr);
          fb.push(...pe.binds, ...pe.binds); // SELECT + WHERE occurrences
          return done(`SELECT ${pe.sql} AS v FROM ${pc} WHERE ${pe.sql} IS NOT NULL`, { kind: 'value' }, 3);
        }
        case 'count':
          return done(`SELECT COUNT(*) AS v FROM ${pc}`, { kind: 'count' }, 3);
        default:
          throw new Error(`step not implemented after element(): ${after}()`);
      }
    }
    default:
      throw new Error(`step not implemented after properties(): ${next}()`);
  }
}

// g.V(...).<filters>.drop() — delete the target vertices and their incident
// edges. (Edge-valued drop, e.g. g.V().outE().drop(), waits on edge traversal.)
function compileDrop(steps: Step[]): WritePlan {
  const { ctes, binds, stop, elem } = traversalCtes(steps.slice(0, -1));
  if (stop !== steps.length - 1)
    throw new Error(`drop() after ${steps[stop].name}() not yet supported`);
  if (elem === 'edge') throw new Error('edge drop() (e.g. g.E().drop()) not yet supported');
  const targetSql = `WITH RECURSIVE ${ctes.join(',\n')}\nSELECT id FROM c${ctes.length - 1}`;
  return {
    kind: 'write',
    run: (store) => {
      // Materialize the target ids ONCE, before mutating. If the traversal
      // reads the edges table (out()/in()/both() before drop()), deleting the
      // incident edges first would empty a re-evaluated target CTE, silently
      // leaving the vertices behind. Snapshot the ids, then delete by value.
      const ids = store.query<{ id: number }>(targetSql, binds).map((r) => r.id);
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        store.query(`DELETE FROM edges WHERE src IN (${ph}) OR tgt IN (${ph})`, [...ids, ...ids]);
        store.query(`DELETE FROM nodes WHERE id IN (${ph})`, ids);
      }
      return [];
    },
  };
}

// g.V(x).<filters>.property(k, v)[.property(...)] — set properties on the
// matched existing element(s), single cardinality (last write wins). Reuses the
// read movement engine to pick the targets, snapshots their ids (drop()'s
// mutate-after-snapshot discipline), then JS-merges the new keys into each props
// bag and writes it back whole (preserves value types exactly, like addV).
// Multi-property (Cardinality.list/set) waits on W4's schema rework.
function compileSetProperty(steps: Step[], params: Record<string, any>): WritePlan {
  const firstProp = steps.findIndex((s) => s.name === 'property');
  const prefix = steps.slice(0, firstProp);
  const { ctes, binds, stop, elem } = traversalCtes(prefix, params);
  if (stop !== prefix.length)
    throw new Error(`property() after ${steps[stop].name}() not yet supported`);
  const setProps: Record<string, any> = {};
  for (const s of steps.slice(firstProp)) {
    if (s.name !== 'property')
      throw new Error(`step not implemented after property(): ${s.name}()`);
    const [key, val] = stripCardinality(s.args);
    if (key && typeof key === 'object' && 'token' in key)
      throw new Error(`property(T.${key.token}) on an existing element not yet supported`);
    setProps[key] = val;
  }
  const tbl = elem === 'edge' ? 'edges' : 'nodes';
  const labelSub = `(SELECT name FROM labels WHERE id=${tbl}.label) AS label`;
  const readCur = elem === 'edge'
    ? `SELECT uid, src, tgt, props, ${labelSub} FROM edges WHERE id=?`
    : `SELECT uid, props, ${labelSub} FROM nodes WHERE id=?`;
  const targetSql = `WITH RECURSIVE ${ctes.join(',\n')}\nSELECT id FROM c${ctes.length - 1}`;
  return {
    kind: 'write',
    run: (store) => {
      const ids = store.query<{ id: number }>(targetSql, binds).map((r) => r.id);
      return ids.map((id) => {
        const cur = store.query<any>(readCur, [id])[0];
        const props = { ...JSON.parse(cur.props), ...setProps };
        store.query(`UPDATE ${tbl} SET props=? WHERE id=?`, [JSON.stringify(props), id]);
        // Edge endpoints expose the external id (COALESCE uid,id), consistent
        // with the addE/mergeE write paths (nodeExtId).
        return elem === 'edge'
          ? { edge: { id: cur.uid ?? id, label: cur.label, src: nodeExtId(store, cur.src), tgt: nodeExtId(store, cur.tgt), props } }
          : { vertex: { id: cur.uid ?? id, label: cur.label, props } };
      });
    },
  };
}

// g.inject(v1, v2, ...) — seed a value stream from constants. The collection /
// mid-traversal forms (and inject as a barrier) belong to the P2 select() work.
function compileInject(steps: Step[]): Compiled {
  if (steps.length !== 1) throw new Error('inject() with subsequent steps not yet supported');
  const vals = steps[0].args;
  if (vals.length === 0)
    return { kind: 'read', sql: `SELECT NULL AS v WHERE 0`, binds: [], shape: { kind: 'value' } };
  // Built entirely from lazyrecords nodes: WITH c0(v) AS (VALUES …) SELECT v FROM c0.
  // The injected values are Value tokens, so binds derive from the tree.
  const tree = lsql(withClause(
    [cte('c0', valuesClause(vals.map((v) => [v])), ['v'])],
    lsql(sqlText('select v from c0')),
  ));
  return compiled(tree, { kind: 'value' });
}

interface VertexSpec { label: string; props: Record<string, any>; uid: string | number | null; }

// A leading Cardinality token on property() args: `single` is a no-op we drop;
// list/set (real multi-property) wait on W4's schema rework. One place so every
// property()-consuming site (addV/addE/set) rejects list/set identically.
function stripCardinality(args: any[]): any[] {
  if (args[0] && typeof args[0] === 'object' && 'cardinality' in args[0]) {
    if (args[0].cardinality !== 'single') throw new Error(`property(Cardinality.${args[0].cardinality}) (multi-property) deferred to W4`);
    return args.slice(1);
  }
  return args;
}

// An addV(...) step + its trailing property() steps → a vertex spec.
// property(T.id, …)/property(T.label, …) set the id/label; the rest are data props.
function parseVertexSpec(addV: Step, propSteps: Step[]): VertexSpec {
  let label = (typeof addV.args[0] === 'string' ? addV.args[0] : null) ?? 'vertex';
  const props: Record<string, any> = {};
  let uid: string | number | null = null;
  for (const s of propSteps) {
    const a = stripCardinality(s.args);
    const [key, val] = a;
    if (key && typeof key === 'object' && 'token' in key) {
      if (key.token === 'id') uid = val;
      else if (key.token === 'label') label = String(val);
      else throw new Error(`property(T.${key.token}) not supported`);
      continue;
    }
    props[key] = val;
  }
  return { label, props, uid };
}

// Insert a vertex from a spec; returns its rowid and external id (uid ?? rowid).
// A numeric T.id writes the rowid directly; a string T.id becomes the uid.
function insertVertex(store: GraphStore, spec: VertexSpec): { id: number; extId: string | number } {
  const lid = store.labelId(spec.label);
  const uidCol = typeof spec.uid === 'string' ? spec.uid : null;
  const idCol = typeof spec.uid === 'number' ? spec.uid : null;
  const cols = ['label', 'props', ...(uidCol !== null ? ['uid'] : []), ...(idCol !== null ? ['id'] : [])];
  const vals: any[] = [lid, JSON.stringify(spec.props), ...(uidCol !== null ? [uidCol] : []), ...(idCol !== null ? [idCol] : [])];
  const row = store.query<{ id: number; uid: string | null }>(
    `INSERT INTO nodes(${cols.join(', ')}) VALUES(${cols.map(() => '?').join(', ')}) RETURNING id, uid`, vals)[0];
  return { id: row.id, extId: row.uid ?? row.id };
}

// g.addV('label').property(k, v)...  — and multi-element chains (a graph
// initializer, e.g. g.addV(a).addV(b)): the linear write interpreter. Like
// Gremlin, the stream after the chain is just the last created element.
function compileAddV(steps: Step[]): WritePlan {
  if (steps.some((s, i) => i > 0 && s.name !== 'property'))
    return { kind: 'write', run: (store) => runWriteChainFull(store, steps, {}) };
  const spec = parseVertexSpec(steps[0], steps.slice(1));
  return { kind: 'write', run: (store) => [{ vertex: { id: insertVertex(store, spec).extId, label: spec.label, props: spec.props } }] };
}

// An addE(label) + its trailing from/to/property modulators, plus the index of
// the first step that is NOT part of the cluster (so chains of addE parse).
interface EdgeCluster { label: string; fromSpec: any; toSpec: any; edgeUid: string | number | null; props: Record<string, any>; next: number; }
function parseEdgeCluster(steps: Step[], addEIdx: number): EdgeCluster {
  const label = steps[addEIdx].args[0];
  if (typeof label !== 'string') throw new Error('addE(label): nested-traversal label not supported');
  let fromSpec: any, toSpec: any, edgeUid: string | number | null = null;
  const props: Record<string, any> = {};
  let i = addEIdx + 1;
  for (; i < steps.length && (steps[i].name === 'from' || steps[i].name === 'to' || steps[i].name === 'property'); i++) {
    const m = steps[i];
    if (m.name === 'from') fromSpec = m.args[0];
    else if (m.name === 'to') toSpec = m.args[0];
    else {
      const [k, v] = stripCardinality(m.args);
      if (k && typeof k === 'object' && 'token' in k) { if (k.token === 'id') edgeUid = v; else throw new Error(`property(T.${k.token}) on an edge not supported`); }
      else props[k] = v;
    }
  }
  return { label, fromSpec, toSpec, edgeUid, props, next: i };
}

function nodeExtId(store: GraphStore, rowid: number): any {
  return store.query<{ x: any }>('SELECT COALESCE(uid, id) AS x FROM nodes WHERE id=?', [rowid])[0]?.x ?? rowid;
}

// Insert one edge from a cluster + resolved endpoints; returns the framed result.
function insertEdge(store: GraphStore, c: EdgeCluster, src: number, tgt: number): any {
  const lid = store.labelId(c.label);
  const uidCol = typeof c.edgeUid === 'string' ? c.edgeUid : null;
  const idCol = typeof c.edgeUid === 'number' ? c.edgeUid : null;
  const cols = ['src', 'label', 'tgt', 'props', ...(uidCol !== null ? ['uid'] : []), ...(idCol !== null ? ['id'] : [])];
  const vals: any[] = [src, lid, tgt, JSON.stringify(c.props), ...(uidCol !== null ? [uidCol] : []), ...(idCol !== null ? [idCol] : [])];
  const row = store.query<{ id: number; uid: string | null }>(
    `INSERT INTO edges(${cols.join(', ')}) VALUES(${cols.map(() => '?').join(', ')}) RETURNING id, uid`, vals)[0];
  return { edge: { id: row.uid ?? row.id, label: c.label, src: nodeExtId(store, src), tgt: nodeExtId(store, tgt), props: c.props } };
}

// Resolve a cluster's from()/to() (each an alias / nested __.V / the fallback
// traverser) and insert the edge. Shared by the read-mode and write-chain paths.
function applyEdgeCluster(store: GraphStore, c: EdgeCluster, aliases: Map<string, number>, fallback: number | null, params: Record<string, any>): any {
  const src = c.fromSpec !== undefined ? resolveEndpoint(store, c.fromSpec, { aliases }, params) : fallback;
  const tgt = c.toSpec !== undefined ? resolveEndpoint(store, c.toSpec, { aliases }, params) : fallback;
  if (src == null || tgt == null) throw new Error('addE needs both endpoints — supply from()/to() or an incoming traverser');
  return insertEdge(store, c, src, tgt);
}

// addE — general form. A pure write chain (addV/as/addE/from/to/property — a
// graph initializer, possibly many addE) goes to the sequential interpreter;
// otherwise it's a single addE with a V()-rooted prefix (mid-traversal), one
// edge per resulting traverser (outV = from() else the incoming, inV = to()
// else the incoming). from()/to() take an as() alias or a nested __.V(...).
function compileAddE(steps: Step[], params: Record<string, any>): WritePlan {
  const CHAIN = new Set(['addV', 'as', 'addE', 'from', 'to', 'property']);
  if (steps.every((s) => CHAIN.has(s.name)))
    return { kind: 'write', run: (store) => runWriteChainFull(store, steps, params) };

  const addEIdx = steps.findIndex((s) => s.name === 'addE');
  const cluster = parseEdgeCluster(steps, addEIdx);
  if (cluster.next !== steps.length) throw new Error(`step not implemented after addE(): ${steps[cluster.next].name}()`);
  const prefix = steps.slice(0, addEIdx);
  const t = traversalCtes(prefix, params);
  if (t.stop !== prefix.length) throw new Error(`addE after ${prefix[t.stop].name}() not yet supported`);
  const aliasCols: [string, string][] = [...t.aliases].map(([lbl, a]) => [lbl, a.col]);
  const readSql = `WITH RECURSIVE ${t.ctes.join(',\n')}\nSELECT ${['id', ...aliasCols.map(([, c]) => c)].join(', ')} FROM c${t.ctes.length - 1}`;
  return {
    kind: 'write',
    run: (store) => store.query<any>(readSql, t.binds).map((r) =>
      applyEdgeCluster(store, cluster, new Map(aliasCols.map(([lbl, c]) => [lbl, r[c]])), r.id, params)),
  };
}

// Interpret a linear write chain (addV/property/as/addE/from/to): vertices thread
// into as() aliases; each addE creates an edge (from/to = alias / nested __.V /
// the current vertex). Returns the last created element (Gremlin's 1→1 stream).
function runWriteChainFull(store: GraphStore, steps: Step[], params: Record<string, any>): any[] {
  const aliases = new Map<string, number>();
  let currentV: number | null = null;
  let last: any = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.name === 'addV') {
      const propSteps: Step[] = [];
      while (i + 1 < steps.length && steps[i + 1].name === 'property') propSteps.push(steps[++i]);
      const spec = parseVertexSpec(s, propSteps);
      const v = insertVertex(store, spec);
      currentV = v.id; last = { vertex: { id: v.extId, label: spec.label, props: spec.props } };
    } else if (s.name === 'as') {
      if (currentV == null) throw new Error('as() before any vertex in write chain');
      for (const lbl of s.args) if (typeof lbl === 'string') aliases.set(lbl, currentV);
    } else if (s.name === 'addE') {
      const cluster = parseEdgeCluster(steps, i);
      i = cluster.next - 1;
      last = applyEdgeCluster(store, cluster, aliases, currentV, params);
    } else throw new Error(`write-chain step not supported: ${s.name}()`);
  }
  return last ? [last] : [];
}

// Resolve an addE from()/to() endpoint to a node rowid: a string names an as()
// alias; a nested traversal is run and its FIRST matched vertex used.
function resolveEndpoint(store: GraphStore, spec: any, d: { aliases: Map<string, number> }, params: Record<string, any>): number {
  if (typeof spec === 'string') {
    const id = d.aliases.get(spec);
    if (id === undefined) throw new Error(`addE from/to("${spec}"): unknown as() label`);
    return id;
  }
  if (spec && typeof spec === 'object' && spec.nested) {
    const inner = stepChain(spec.nested, params);
    const t = traversalCtes(inner, params);
    if (t.stop !== inner.length) throw new Error(`addE endpoint traversal not supported past ${inner[t.stop].name}()`);
    const rows = store.query<{ id: number }>(`WITH RECURSIVE ${t.ctes.join(',\n')}\nSELECT id FROM c${t.ctes.length - 1}`, t.binds);
    if (!rows.length) throw new Error('addE endpoint traversal matched no vertex');
    return rows[0].id;
  }
  throw new Error('addE from()/to() must be an as() label or a nested __.V(...) traversal');
}

// ---------- mergeV / mergeE (upsert) ----------

// A merge search/apply map, normalised from either a bound Map parameter (keys
// arrive as GraphBinary EnumValues) or an inline [k: v] literal (keys arrive as
// {token}/{direction} tags). label/id/outV/inV are the reserved T./Direction./
// Merge. keys; everything else is a data property.
interface MergeSpec { label: string | null; id: string | number | null; outV: any; inV: any; props: Record<string, any>; }

/** The reserved role a merge-map key plays (or a plain data-property key). */
function classifyMergeKey(k: any): { kind: 'label' | 'id' | 'outV' | 'inV' | 'prop'; name?: string } {
  const enumName = (typeName: string) => k && typeof k === 'object' && k.typeName === typeName ? String(k.elementName).toLowerCase() : null;
  const t = enumName('T') ?? (k && typeof k === 'object' && 'token' in k ? k.token : null);
  if (t) { if (t === 'label') return { kind: 'label' }; if (t === 'id') return { kind: 'id' }; throw new Error(`merge map key T.${t} not supported`); }
  const d = enumName('Direction') ?? (k && typeof k === 'object' && 'direction' in k ? k.direction : null);
  if (d) {
    if (d === 'out' || d === 'from') return { kind: 'outV' };
    if (d === 'in' || d === 'to') return { kind: 'inV' };
    throw new Error(`merge map key Direction.${d} not supported`);
  }
  return { kind: 'prop', name: String(k) };
}

/** A merge-map endpoint VALUE: a Merge.outV/inV token means "the incoming
 *  traverser" (mergeE mid-chain); otherwise it's a concrete endpoint id. */
function classifyMergeVal(v: any): any {
  const m = v && typeof v === 'object' ? (v.typeName === 'Merge' ? String(v.elementName).toLowerCase() : ('merge' in v ? v.merge : null)) : null;
  return m ? { incoming: m } : v;
}

function normalizeMergeMap(raw: any): MergeSpec {
  const spec: MergeSpec = { label: null, id: null, outV: undefined, inV: undefined, props: {} };
  if (raw == null) return spec; // mergeV(null) — match anything
  if (!(raw instanceof Map)) {
    if (raw && typeof raw === 'object' && 'nested' in raw) throw new Error('merge with a traversal argument (e.g. __.select(...)) not yet supported');
    throw new Error('merge argument must be a map ([k:v] / bound Map), null, or empty ([:])');
  }
  for (const [k, v] of raw) {
    const c = classifyMergeKey(k);
    if (c.kind === 'label') spec.label = String(v);
    else if (c.kind === 'id') spec.id = v;
    else if (c.kind === 'outV') spec.outV = classifyMergeVal(v);
    else if (c.kind === 'inV') spec.inV = classifyMergeVal(v);
    else spec.props[c.name!] = v;
  }
  return spec;
}

/** SELECT of the vertices matching a merge spec (label + id/uid + prop equality;
 *  an empty spec matches every vertex). Returns the columns write-framing needs. */
function mergeMatchQuery(spec: MergeSpec): { sql: string; binds: any[] } {
  const conds: string[] = [];
  const binds: any[] = [];
  if (spec.label != null) { conds.push('label IN (SELECT id FROM labels WHERE name=?)'); binds.push(spec.label); }
  if (spec.id != null) { conds.push(typeof spec.id === 'number' ? 'id=?' : 'uid=?'); binds.push(spec.id); }
  for (const [k, v] of Object.entries(spec.props)) {
    const pe = render(propExtract('props', k).expr);
    conds.push(`${pe.sql} = ?`); binds.push(...pe.binds, v);
  }
  return {
    sql: `SELECT id, uid, (SELECT name FROM labels WHERE id=nodes.label) AS label, props FROM nodes WHERE ${conds.length ? conds.join(' AND ') : '1'}`,
    binds,
  };
}

// The option(Merge.onCreate|onMatch, map) modulators following a merge step.
function parseMergeOptions(mods: Step[], step: string): { onCreate: MergeSpec | null; onMatch: MergeSpec | null } {
  let onCreate: MergeSpec | null = null, onMatch: MergeSpec | null = null;
  for (const s of mods) {
    if (s.name !== 'option') throw new Error(`step not implemented after ${step}(): ${s.name}()`);
    const [sel, mapArg] = s.args;
    if (!sel || typeof sel !== 'object' || !('merge' in sel))
      throw new Error(`${step} option() selector must be Merge.onCreate/onMatch`);
    const spec = normalizeMergeMap(mapArg);
    if (sel.merge === 'oncreate') onCreate = spec;
    else if (sel.merge === 'onmatch') onMatch = spec;
    else throw new Error(`${step} option(Merge.${sel.merge}) not supported`);
  }
  return { onCreate, onMatch };
}

// The incoming traversers a merge runs once per, evaluated at run time. A start
// step → one null driver (no vertex identity). A bare inject(v1,…) prefix → one
// null driver per injected value (so g.inject(a,b).mergeV runs twice, per the
// multiset semantics). A V()-rooted prefix → the matched vertex rowids (which a
// mergeE endpoint token Merge.outV/inV binds to).
function mergeDrivers(prefix: Step[], params: Record<string, any>): (store: GraphStore) => (number | null)[] {
  if (prefix.length === 0) return () => [null];
  if (prefix.length === 1 && prefix[0].name === 'inject') { const nulls = prefix[0].args.map(() => null); return () => nulls; }
  const t = traversalCtes(prefix, params);
  if (t.stop !== prefix.length) throw new Error(`merge after ${prefix[t.stop].name}() not yet supported`);
  const sql = `WITH RECURSIVE ${t.ctes.join(',\n')}\nSELECT id FROM c${t.ctes.length - 1}`;
  return (store) => store.query<{ id: number }>(sql, t.binds).map((r) => r.id);
}

// g.mergeV(map) [.option(Merge.onCreate, map)] [.option(Merge.onMatch, map)]
// Upsert by the search map: matches → emitted (props patched by onMatch); no
// match → one vertex created from the search map merged with onCreate. As a
// start step it runs once; mid-chain (g.V()....mergeV) it runs once per incoming
// traverser, re-querying each time so an earlier create is visible to a later one.
function compileMergeV(steps: Step[], params: Record<string, any>): WritePlan {
  const mvIdx = steps.findIndex((s) => s.name === 'mergeV');
  if (steps[mvIdx].args.length === 0)
    throw new Error('mergeV() with no argument (uses the incoming traverser as the map) not yet supported');
  const matchSpec = normalizeMergeMap(steps[mvIdx].args[0]);
  const { onCreate, onMatch } = parseMergeOptions(steps.slice(mvIdx + 1), 'mergeV');
  const drivers = mergeDrivers(steps.slice(0, mvIdx), params);
  const match = mergeMatchQuery(matchSpec);
  return {
    kind: 'write',
    run: (store) => {
      const out: any[] = [];
      for (const _driver of drivers(store)) {
        const matches = store.query<any>(match.sql, match.binds);
        if (matches.length) {
          for (const m of matches) {
            let props = JSON.parse(m.props);
            if (onMatch) { props = { ...props, ...onMatch.props }; store.query('UPDATE nodes SET props=? WHERE id=?', [JSON.stringify(props), m.id]); }
            out.push({ vertex: { id: m.uid ?? m.id, label: m.label, props } });
          }
        } else {
          const label = onCreate?.label ?? matchSpec.label ?? 'vertex';
          const props = { ...matchSpec.props, ...(onCreate?.props ?? {}) };
          const v = insertVertex(store, { label, props, uid: matchSpec.id ?? onCreate?.id ?? null });
          out.push({ vertex: { id: v.extId, label, props } });
        }
      }
      return out;
    },
  };
}

// Resolve a mergeE endpoint spec to a node rowid, requiring the vertex to exist
// (mergeE cannot create endpoints — matches TinkerPop's error). A rowid comes in
// from an incoming traverser; a user id (number/string) resolves through id/uid.
function resolveMergeEndpoint(store: GraphStore, raw: any): number {
  const r = store.query<{ id: number }>(
    typeof raw === 'number' ? 'SELECT id FROM nodes WHERE id=?' : 'SELECT id FROM nodes WHERE uid=?', [raw])[0];
  if (!r) throw new Error('Vertex does not exist for mergeE');
  return r.id;
}

// SELECT of edges matching a merge spec between two resolved endpoints.
function edgeMatchQuery(spec: MergeSpec, outV: number, inV: number): { sql: string; binds: any[] } {
  const conds = ['src=?', 'tgt=?'];
  const binds: any[] = [outV, inV];
  if (spec.label != null) { conds.push('label IN (SELECT id FROM labels WHERE name=?)'); binds.push(spec.label); }
  if (spec.id != null) { conds.push(typeof spec.id === 'number' ? 'id=?' : 'uid=?'); binds.push(spec.id); }
  for (const [k, v] of Object.entries(spec.props)) {
    const pe = render(propExtract('props', k).expr);
    conds.push(`${pe.sql} = ?`); binds.push(...pe.binds, v);
  }
  return { sql: `SELECT id, uid, src, tgt, (SELECT name FROM labels WHERE id=edges.label) AS label, props FROM edges WHERE ${conds.join(' AND ')}`, binds };
}

// g.mergeE(map) [.option(Merge.onCreate, map)] [.option(Merge.onMatch, map)]
// Upsert an edge keyed on (outV, inV, label, props). Endpoints come from the
// map's Direction.OUT/IN keys (a Merge.outV/inV value means the incoming
// traverser); both must exist. Mid-chain it runs per incoming traverser.
function compileMergeE(steps: Step[], params: Record<string, any>): WritePlan {
  const meIdx = steps.findIndex((s) => s.name === 'mergeE');
  if (steps[meIdx].args.length === 0)
    throw new Error('mergeE() with no argument (uses the incoming traverser as the map) not yet supported');
  const matchSpec = normalizeMergeMap(steps[meIdx].args[0]);
  const { onCreate, onMatch } = parseMergeOptions(steps.slice(meIdx + 1), 'mergeE');
  const drivers = mergeDrivers(steps.slice(0, meIdx), params);
  return {
    kind: 'write',
    run: (store) => {
      // An endpoint spec: a Merge.outV/inV token → the incoming traverser; else a
      // concrete id. onCreate can also supply the endpoints if the search map omits them.
      const endpoint = (spec: any, oc: any, cur: number | null, role: string): number => {
        const raw = spec?.incoming !== undefined ? cur : spec ?? (oc?.incoming !== undefined ? cur : oc);
        if (raw == null) throw new Error(`mergeE: missing ${role} endpoint (need Direction.${role === 'outV' ? 'OUT' : 'IN'} or an incoming traverser)`);
        return resolveMergeEndpoint(store, raw);
      };
      const out: any[] = [];
      for (const cur of drivers(store)) {
        const outV = endpoint(matchSpec.outV, onCreate?.outV, cur, 'outV');
        const inV = endpoint(matchSpec.inV, onCreate?.inV, cur, 'inV');
        const match = edgeMatchQuery(matchSpec, outV, inV);
        const matches = store.query<any>(match.sql, match.binds);
        if (matches.length) {
          for (const m of matches) {
            let props = JSON.parse(m.props);
            if (onMatch) { props = { ...props, ...onMatch.props }; store.query('UPDATE edges SET props=? WHERE id=?', [JSON.stringify(props), m.id]); }
            out.push({ edge: { id: m.uid ?? m.id, label: m.label, src: nodeExtId(store, m.src), tgt: nodeExtId(store, m.tgt), props } });
          }
        } else {
          const label = matchSpec.label ?? onCreate?.label;
          if (!label) throw new Error('mergeE cannot create an edge without a label');
          const props = { ...matchSpec.props, ...(onCreate?.props ?? {}) };
          out.push(insertEdge(store, { label, fromSpec: undefined, toSpec: undefined, edgeUid: matchSpec.id ?? onCreate?.id ?? null, props, next: 0 }, outV, inV));
        }
      }
      return out;
    },
  };
}
