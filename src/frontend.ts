import { CharStream, CommonTokenStream, BaseErrorListener, ParserRuleContext } from 'antlr4ng';
import { GremlinLexer } from '../parser/GremlinLexer.ts';
import { GremlinParser } from '../parser/GremlinParser.ts';

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

// `argTypes[i]` is the declared numeric subtype of `args[i]` when it is a numeric
// literal (from the grammar context + suffix), else null. Carried in parallel so
// `args` stays plain numbers for every existing consumer; only bare asNumber() reads
// it (to recover the input subtype the value alone can't carry — 5b/5i/5l/5.0 → 5).
export interface Step { name: string; args: any[]; ctx: ParserRuleContext; argTypes?: (string | null)[]; }

// Numeric-literal suffix → subtype. No suffix: an integer literal defaults to `int`,
// a float literal to `double` (TinkerPop's literal typing).
const INT_LIT_SUFFIX: Record<string, string> = { b: 'byte', s: 'short', i: 'int', l: 'long', n: 'bigint' };
const FLOAT_LIT_SUFFIX: Record<string, string> = { f: 'float', d: 'double', m: 'bigdecimal' };
const intLitType = (text: string): string => INT_LIT_SUFFIX[text.slice(-1).toLowerCase()] ?? 'int';
const floatLitType = (text: string): string => FLOAT_LIT_SUFFIX[text.slice(-1).toLowerCase()] ?? 'double';

export const stepName = (cls: string, prefix: string) =>
  cls.startsWith(prefix) && cls.endsWith('Context')
    ? cls.slice(prefix.length, -'Context'.length).split('_')[0]
    : null;

/** Collect the top-level step chain (does not descend into nested traversal args). */
export function stepChain(tree: any, params: Record<string, any>): Step[] {
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
      const { args, types } = extractArgs(node, params);
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

/** Pull literal / predicate / variable arguments out of a step context, plus the
 *  parallel numeric-subtype tags (see Step.argTypes). */
function extractArgs(ctx: any, params: Record<string, any>): { args: any[]; types: (string | null)[] } {
  const args: any[] = [];
  const types: (string | null)[] = [];
  // skip child 0 (step name token) and parens; walking all children is fine since tokens have no children
  for (let i = 0; i < ctx.getChildCount(); i++) walkArgs(ctx.getChild(i), args, params, types);
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
function walkArgs(node: any, out: any[], params: Record<string, any>, types: (string | null)[]): void {
  const emit = (v: any, t: string | null = null) => { out.push(v); types.push(t); };
  const cls = node.constructor.name;
  if (cls === 'StringLiteralContext') { emit(unquote(node.getText())); return; }
  if (cls === 'IntegerLiteralContext') { emit(parseInt(node.getText().replace(/[lL]$/, ''), 10), intLitType(node.getText())); return; }
  if (cls === 'FloatLiteralContext') { emit(parseFloat(node.getText()), floatLitType(node.getText())); return; }
  if (cls === 'BooleanLiteralContext') { emit(node.getText() === 'true'); return; }
  if (cls === 'NullLiteralContext') { emit(null); return; }
  if (cls === 'VariableContext') {
    const name = node.getText();
    if (!(name in params)) throw new Error(`Unbound parameter '${name}'`);
    emit(params[name]); return;
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
  if (cls === 'GenericMapLiteralContext') { emit(mapLiteral(node, params)); return; }
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
    emit(s ? parseIsoMs(unquote(s.getText())) : Date.now()); return;
  }
  // DT.second/minute/hour/day (or the bare unit) — dateAdd()'s unit selector.
  if (cls === 'TraversalDTContext') { emit({ dt: enumSuffix(node) }); return; }
  if (cls === 'NestedTraversalContext') { emit({ nested: node }); return; }
  for (let i = 0; i < (node.getChildCount?.() ?? 0); i++) walkArgs(node.getChild(i), out, params, types);
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
  return { op: m![1], values };
}

function unquote(s: string): string {
  const body = s.slice(1, -1);
  return body.replace(/\\(['"\\nrt])/g, (_, c) =>
    c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c);
}
