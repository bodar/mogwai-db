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

export interface Step { name: string; args: any[]; ctx: ParserRuleContext; }

export const stepName = (cls: string, prefix: string) =>
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
