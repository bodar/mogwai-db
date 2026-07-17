import { CharStream, CommonTokenStream, BaseErrorListener, ParserRuleContext } from 'antlr4ng';
import { GremlinLexer } from '../parser/GremlinLexer.ts';
import { GremlinParser } from '../parser/GremlinParser.ts';
import { flatType, type TypeNode, type CanonicalType } from './gremlin-types.ts';

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

// `argTypes[i]` is the canonical Gremlin type of `args[i]` as declared by its
// carrying channel — a parsed literal's subtype (numeric suffix, string, boolean,
// datetime, uuid, list, map) or, for a bound-param reference, the wire DataType the
// client serialized (applied in Task 6). null when the channel says nothing. Carried
// in parallel so `args` stays plain values for every consumer; read by bare asNumber()/
// asDate() (to recover the input subtype the value can't carry) and by the write seam
// (to store vertex_properties/edge_properties.vtype — see gremlin-types.ts).
export interface Step { name: string; args: any[]; ctx: ParserRuleContext; argTypes?: (TypeNode | null)[]; }

// Numeric-literal suffix → subtype. No suffix: an integer literal defaults to `int`,
// a float literal to `double` (TinkerPop's literal typing).
const INT_LIT_SUFFIX: Record<string, CanonicalType> = { b: 'byte', s: 'short', i: 'int', l: 'long', n: 'bigint' };
const FLOAT_LIT_SUFFIX: Record<string, CanonicalType> = { f: 'float', d: 'double', m: 'bigdecimal' };
const intLitType = (text: string): CanonicalType => INT_LIT_SUFFIX[text.slice(-1).toLowerCase()] ?? 'int';
const floatLitType = (text: string): CanonicalType => FLOAT_LIT_SUFFIX[text.slice(-1).toLowerCase()] ?? 'double';

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
 *  param-resolved arg records the right canonical type in Step.argTypes. */
export function stepChain(tree: any, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): Step[] {
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
      const { args, types } = extractArgs(node, params, paramTypes);
      steps.push({ name, args, ctx: node, argTypes: types });
      // nested traversals inside this step's args must not contribute to the top chain
      for (let i = 0; i < node.getChildCount(); i++) visit(node.getChild(i), true);
      return;
    }
    for (let i = 0; i < (node.getChildCount?.() ?? 0); i++) visit(node.getChild(i), insideNested);
  };
  visit(tree, false);
  return steps;
}

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
  const out: any[] = [], types: (TypeNode | null)[] = [];
  walkArgs(gl, out, params, types);
  const op = descendants(w, 'TraversalOperatorContext')[0];
  return { init: out[0], initType: flatType(types[0]), mergeOp: op ? enumSuffix(op) : undefined };
}

/** Pull withSideEffect(key, constValue) declarations into a name→constant registry.
 *  withSideEffect values are compile-time constants (a map/list/scalar literal or a bound
 *  param), so a later select(key) resolves to the constant directly. The reducer form
 *  withSideEffect(key, seed, BiFunction) is deferred (left unregistered → select throws). */
export function extractSideEffects(tree: any, params: Record<string, any>): Map<string, any> {
  const out = new Map<string, any>();
  for (const w of descendants(tree, 'TraversalSourceSelfMethod_withSideEffectContext')) {
    if (descendants(w, 'TraversalBiFunctionContext').length) continue; // reducer form → defer
    const keyNode = descendants(w, 'StringLiteralContext')[0];
    const valNode = descendants(w, 'GenericLiteralContext')[0];
    if (!keyNode || !valNode) continue;
    const ks: any[] = [], vs: any[] = [];
    walkArgs(keyNode, ks, params, []);
    walkArgs(valNode, vs, params, []);
    if (typeof ks[0] === 'string') out.set(ks[0], vs[0]);
  }
  return out;
}

/** Pull literal / predicate / variable arguments out of a step context, plus the
 *  parallel numeric-subtype tags (see Step.argTypes). */
function extractArgs(ctx: any, params: Record<string, any>, paramTypes: Record<string, TypeNode> = {}): { args: any[]; types: (TypeNode | null)[] } {
  const args: any[] = [];
  const types: (TypeNode | null)[] = [];
  // skip child 0 (step name token) and parens; walking all children is fine since tokens have no children
  for (let i = 0; i < ctx.getChildCount(); i++) walkArgs(ctx.getChild(i), args, params, types, paramTypes);
  return { args, types };
}

/** The single argument a subtree contributes — used for map-entry values, which
 *  must not flatten into the surrounding step's arg list (subtype tags irrelevant
 *  for these, so they're discarded), and for a withStrategies configuration value
 *  (a nested criterion → `{nested}`, a list → array, a scalar → the literal), so
 *  strategy config reuses the one arg walker. */
function argOf(node: any, params: Record<string, any>): any {
  const out: any[] = [];
  walkArgs(node, out, params, []);
  return out.length === 1 ? out[0] : out;
}

/** Walk one AST node, pushing each recognised argument onto `out` (and its numeric
 *  subtype, or null, onto `types` in lockstep). Unrecognised nodes recurse into
 *  children (a literal buried deeper still surfaces). */
function walkArgs(node: any, out: any[], params: Record<string, any>, types: (TypeNode | null)[], paramTypes: Record<string, TypeNode> = {}): void {
  const emit = (v: any, t: TypeNode | null = null) => { out.push(v); types.push(t); };
  const cls = node.constructor.name;
  if (cls === 'StringLiteralContext') { emit(unquote(node.getText()), 'string'); return; }
  if (cls === 'IntegerLiteralContext') { emit(parseInt(node.getText().replace(/[lL]$/, ''), 10), intLitType(node.getText())); return; }
  if (cls === 'FloatLiteralContext') { emit(parseFloat(node.getText()), floatLitType(node.getText())); return; }
  if (cls === 'BooleanLiteralContext') { emit(node.getText() === 'true', 'boolean'); return; }
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
    // nothing (JSON request path), so the write seam infers from the JS value.
    emit(params[name], paramTypes[name] ?? null); return;
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
  // Cardinality.list/set/single — property() cardinality (list/set deferred to W4).
  if (cls === 'TraversalCardinalityContext') { emit({ cardinality: enumSuffix(node) }); return; }
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
    emit(node.genericLiteral().map((lit: any) => argOf(lit, params)), 'list');
    return;
  }
  if (cls === 'NestedTraversalContext') { emit({ nested: node }); return; }
  for (let i = 0; i < (node.getChildCount?.() ?? 0); i++) walkArgs(node.getChild(i), out, params, types, paramTypes);
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
  const entries: Record<string, TypeNode | null> = {};
  for (const entry of node.mapEntry()) {
    const out: any[] = [], types: (TypeNode | null)[] = [];
    walkArgs(entry.genericLiteral(), out, params, types);
    // A single scalar/map value carries its captured type; a multi-arg or empty walk
    // (unusual) → null (infer at use).
    entries[String(mapKeyOf(entry.mapKey()))] = out.length === 1 ? (types[0] ?? null) : null;
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

export interface Pred { op: string; values: any[]; }

function parsePredicate(node: any, params: Record<string, any>): Pred {
  const m = node.constructor.name.match(/^TraversalPredicate_(\w+)Context$/);
  const { args: values } = extractArgs(node, params); // predicate values; subtype tags unused
  // P.within/without/inside/between accept both varargs (P.within('a','b')) and a
  // single bracketed list (P.within(['a','b'])). Collection literals now parse as one
  // array value, so unwrap a lone array arg back to the value varargs the predicate
  // consumes (predicateSql spreads them into an IN-list / bounds). A bound-param list
  // (a JS array from a binding) unwraps the same way, matching the prior flatten.
  const vals = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
  return { op: m![1], values: vals };
}

function unquote(s: string): string {
  const body = s.slice(1, -1);
  return body.replace(/\\(['"\\nrt])/g, (_, c) =>
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c);
}
