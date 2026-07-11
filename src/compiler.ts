import { CharStream, CommonTokenStream, BaseErrorListener, ParserRuleContext } from 'antlr4ng';
import { GremlinLexer } from '../parser/GremlinLexer.js';
import { GremlinParser } from '../parser/GremlinParser.js';
import type { GraphStore } from './storage.js';

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
  const walk = (node: any) => {
    const cls = node.constructor.name;
    if (cls === 'StringLiteralContext') { args.push(unquote(node.getText())); return; }
    if (cls === 'IntegerLiteralContext') { args.push(parseInt(node.getText().replace(/[lL]$/, ''), 10)); return; }
    if (cls === 'FloatLiteralContext') { args.push(parseFloat(node.getText())); return; }
    if (cls === 'BooleanLiteralContext') { args.push(node.getText() === 'true'); return; }
    if (cls === 'VariableContext') {
      const name = node.getText();
      if (!(name in params)) throw new Error(`Unbound parameter '${name}'`);
      args.push(params[name]); return;
    }
    if (cls.startsWith('TraversalPredicate_')) {
      args.push(parsePredicate(node, params)); return;
    }
    if (cls === 'NestedTraversalContext') { args.push({ nested: node }); return; }
    for (let i = 0; i < (node.getChildCount?.() ?? 0); i++) walk(node.getChild(i));
  };
  // skip child 0 (step name token) and parens; walking all children is fine since tokens have no children
  for (let i = 0; i < ctx.getChildCount(); i++) walk(ctx.getChild(i));
  return args;
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

export type Shape =
  | { kind: 'vertex' }
  | { kind: 'value' }
  | { kind: 'count' };

export interface Compiled {
  kind: 'read';
  sql: string;
  binds: any[];
  shape: Shape;
}

export interface WritePlan { kind: 'write'; run: (store: GraphStore) => any[]; }

const P_OPS: Record<string, string> = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

export function compile(gremlin: string, params: Record<string, any>): Compiled | WritePlan {
  const steps = stepChain(parseGremlin(gremlin), params);
  if (steps.length === 0) throw new Error('empty traversal');

  // v4 iterate() appends discard(): execute, return nothing
  let discard = false;
  const last = steps[steps.length - 1];
  if (last.name === 'discard' || last.name === 'none') { steps.pop(); discard = true; }

  let plan: Compiled | WritePlan;
  if (steps[0].name === 'addV') plan = compileAddV(steps);
  else if (steps[0].name === 'V' && steps.some(s => s.name === 'addE')) plan = compileAddE(steps, params);
  else plan = compileRead(steps);

  if (discard) {
    if (plan.kind === 'write') { const inner = plan.run; return { kind: 'write', run: (s) => { inner(s); return []; } }; }
    return { ...plan, shape: { kind: 'discard' } as any };
  }
  return plan;
}

function compileRead(steps: Step[]): Compiled {
  const ctes: string[] = [];
  const binds: any[] = [];
  let shape: Shape = { kind: 'vertex' };
  let i = 0;
  const prev = () => `c${ctes.length - 1}`;

  const first = steps[i++];
  if (first.name !== 'V') throw new Error(`unsupported source step: ${first.name}`);
  if (first.args.length > 0) {
    ctes.push(`c0 AS (SELECT id FROM nodes WHERE id IN (${first.args.map(() => '?').join(',')}))`);
    binds.push(...first.args.map(Number));
  } else {
    ctes.push(`c0 AS (SELECT id FROM nodes)`);
  }

  let terminalSql: string | null = null;

  for (; i < steps.length; i++) {
    const s = steps[i];
    switch (s.name) {
      case 'hasLabel': {
        const ph = s.args.map(() => '?').join(',');
        ctes.push(`c${ctes.length} AS (SELECT n.id FROM nodes n JOIN ${prev()} p ON n.id=p.id WHERE n.label IN (SELECT id FROM labels WHERE name IN (${ph})))`);
        binds.push(...s.args);
        break;
      }
      case 'has': {
        const [key, val] = s.args;
        if (typeof key !== 'string') throw new Error('has: key must be a string');
        const path = `'$.' || ?`; // key bound, path built in SQL to avoid injection via key
        if (val !== null && typeof val === 'object' && 'op' in val) {
          const p = val as Pred;
          if (p.op in P_OPS) {
            ctes.push(`c${ctes.length} AS (SELECT n.id FROM nodes n JOIN ${prev()} p ON n.id=p.id WHERE json_extract(n.props, ${path}) ${P_OPS[p.op]} ?)`);
            binds.push(key, p.values[0]);
          } else if (p.op === 'within' || p.op === 'without') {
            const ph = p.values.map(() => '?').join(',');
            const neg = p.op === 'without' ? 'NOT ' : '';
            ctes.push(`c${ctes.length} AS (SELECT n.id FROM nodes n JOIN ${prev()} p ON n.id=p.id WHERE json_extract(n.props, ${path}) ${neg}IN (${ph}))`);
            binds.push(key, ...p.values);
          } else if (p.op === 'between' || p.op === 'inside') {
            ctes.push(`c${ctes.length} AS (SELECT n.id FROM nodes n JOIN ${prev()} p ON n.id=p.id WHERE json_extract(n.props, ${path}) >= ? AND json_extract(n.props, ${path.replace('?', '?')}) < ?)`);
            binds.push(key, p.values[0], key, p.values[1]);
          } else throw new Error(`unsupported predicate: P.${p.op}`);
        } else {
          ctes.push(`c${ctes.length} AS (SELECT n.id FROM nodes n JOIN ${prev()} p ON n.id=p.id WHERE json_extract(n.props, ${path}) = ?)`);
          binds.push(key, val);
        }
        break;
      }
      case 'out': case 'in': case 'both': {
        const dirs = s.name === 'out' ? [['src', 'tgt']] : s.name === 'in' ? [['tgt', 'src']] : [['src', 'tgt'], ['tgt', 'src']];
        const labelFilter = s.args.length
          ? ` AND e.label IN (SELECT id FROM labels WHERE name IN (${s.args.map(() => '?').join(',')}))`
          : '';
        const selects = dirs.map(([from, to]) =>
          `SELECT e.${to} AS id FROM edges e JOIN ${prev()} p ON e.${from}=p.id${labelFilter}`);
        ctes.push(`c${ctes.length} AS (${selects.join(' UNION ALL ')})`);
        for (const _ of dirs) binds.push(...s.args);
        break;
      }
      case 'dedup':
        ctes.push(`c${ctes.length} AS (SELECT DISTINCT id FROM ${prev()})`);
        break;
      case 'limit':
        ctes.push(`c${ctes.length} AS (SELECT id FROM ${prev()} LIMIT ${Number(s.args[0])})`);
        break;
      case 'values': {
        const key = s.args[0];
        terminalSql = `SELECT json_extract(n.props, '$.' || ?) AS v FROM nodes n JOIN ${prev()} p ON n.id=p.id WHERE json_extract(n.props, '$.' || ?) IS NOT NULL`;
        binds.push(key, key);
        shape = { kind: 'value' };
        break;
      }
      case 'id':
        terminalSql = `SELECT id AS v FROM ${prev()}`;
        shape = { kind: 'value' };
        break;
      case 'label':
        terminalSql = `SELECT l.name AS v FROM nodes n JOIN ${prev()} p ON n.id=p.id JOIN labels l ON l.id=n.label`;
        shape = { kind: 'value' };
        break;
      case 'count':
        terminalSql = `SELECT COUNT(*) AS v FROM ${prev()}`;
        shape = { kind: 'count' };
        break;
      default:
        throw new Error(`step not implemented: ${s.name}()`);
    }
    if (terminalSql && i < steps.length - 1) throw new Error(`no steps allowed after ${s.name}() yet`);
  }

  const finalSelect = terminalSql ??
    `SELECT n.id, l.name AS label, n.props FROM nodes n JOIN ${prev()} p ON n.id=p.id JOIN labels l ON l.id=n.label`;
  return { kind: 'read', sql: `WITH ${ctes.join(',\n')}\n${finalSelect}`, binds, shape };
}

// g.addV('label').property(k, v)...
function compileAddV(steps: Step[]): WritePlan {
  const label = steps[0].args[0] ?? 'vertex';
  const props: Record<string, any> = {};
  for (const s of steps.slice(1)) {
    if (s.name !== 'property') throw new Error(`step not implemented after addV: ${s.name}()`);
    props[s.args[0]] = s.args[1];
  }
  return {
    kind: 'write',
    run: (store) => {
      const lid = store.labelId(label);
      const row = store.db
        .prepare('INSERT INTO nodes(label, props) VALUES(?, ?) RETURNING id, props')
        .get(lid, JSON.stringify(props)) as any;
      return [{ vertex: { id: row.id, label, props } }];
    },
  };
}

// g.V(a).addE('label').to(__.V(b)) — restricted nested-traversal shape for the slice
function compileAddE(steps: Step[], params: Record<string, any>): WritePlan {
  const [vStep, addE, to] = steps;
  if (steps.length !== 3 || vStep.name !== 'V' || addE.name !== 'addE' || to.name !== 'to')
    throw new Error('addE currently supports exactly g.V(id).addE(label).to(__.V(id))');
  const src = Number(vStep.args[0]);
  const nested = to.args[0]?.nested;
  if (!nested) throw new Error('to() must contain a nested traversal');
  const inner = stepChain(nested, params);
  if (inner.length !== 1 || inner[0].name !== 'V' || inner[0].args.length !== 1)
    throw new Error('to() nested traversal must be __.V(id) for now');
  const tgt = Number(inner[0].args[0]);
  const label = addE.args[0];
  return {
    kind: 'write',
    run: (store) => {
      const lid = store.labelId(label);
      const row = store.db
        .prepare('INSERT INTO edges(src, label, tgt) VALUES(?,?,?) RETURNING id')
        .get(src, lid, tgt) as any;
      return [{ edge: { id: row.id, label, src, tgt } }];
    },
  };
}
