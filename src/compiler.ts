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
    // order()/by() take an Order token (asc|desc|shuffle) that is a grammar rule,
    // not a literal — capture it so the compiler can pick sort direction.
    if (cls === 'TraversalOrderContext') {
      const seg = node.getText().split('.').pop().toLowerCase();
      args.push({ order: seg }); return;
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
  | { kind: 'count' }
  | { kind: 'valueMap'; keys: string[] | null; tokens: boolean }
  | { kind: 'elementMap'; keys: string[] | null }
  | { kind: 'discard' };

export interface Compiled {
  kind: 'read';
  sql: string;
  binds: any[];
  shape: Shape;
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
 *  keys literally (index-friendly); binds anything else (returned in `binds`). */
function propExtract(col: string, key: unknown): { sql: string; binds: any[] } {
  if (typeof key !== 'string') throw new Error('property key must be a string');
  if (SAFE_KEY.test(key)) return { sql: `json_extract(${col}, '$.${key}')`, binds: [] };
  return { sql: `json_extract(${col}, '$.' || ?)`, binds: [key] };
}

/** range(low, high) → SQL [offset, limit]. high < 0 means "no upper bound". */
function rangeToOffsetLimit(args: any[]): { offset: number; limit: number } {
  const [lo, hi] = args.map(Number);
  if (hi >= 0 && lo > hi) throw new Error(`Not a legal range: [${lo}, ${hi}]`);
  return { offset: lo, limit: hi < 0 ? -1 : hi - lo };
}

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
  else if (steps[0].name === 'inject') plan = compileInject(steps);
  else if (steps[steps.length - 1].name === 'drop') plan = compileDrop(steps);
  else plan = compileRead(steps);

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
function traversalCtes(steps: Step[]): { ctes: string[]; binds: any[]; stop: number } {
  const ctes: string[] = [];
  const binds: any[] = [];
  const prev = () => `c${ctes.length - 1}`;

  const first = steps[0];
  if (first.name !== 'V') throw new Error(`unsupported source step: ${first.name}`);
  if (first.args.length > 0) {
    ctes.push(`c0 AS (SELECT id FROM nodes WHERE id IN (${first.args.map(() => '?').join(',')}))`);
    binds.push(...first.args.map(Number));
  } else {
    ctes.push(`c0 AS (SELECT id FROM nodes)`);
  }

  let i = 1;
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
        const pe = propExtract('n.props', key); // literal path for indexable keys
        const join = `SELECT n.id FROM nodes n JOIN ${prev()} p ON n.id=p.id`;
        if (val !== null && typeof val === 'object' && 'op' in val) {
          const p = val as Pred;
          if (p.op in P_OPS) {
            ctes.push(`c${ctes.length} AS (${join} WHERE ${pe.sql} ${P_OPS[p.op]} ?)`);
            binds.push(...pe.binds, p.values[0]);
          } else if (p.op === 'within' || p.op === 'without') {
            const ph = p.values.map(() => '?').join(',');
            const neg = p.op === 'without' ? 'NOT ' : '';
            ctes.push(`c${ctes.length} AS (${join} WHERE ${pe.sql} ${neg}IN (${ph}))`);
            binds.push(...pe.binds, ...p.values);
          } else if (p.op === 'between' || p.op === 'inside') {
            ctes.push(`c${ctes.length} AS (${join} WHERE ${pe.sql} >= ? AND ${pe.sql} < ?)`);
            binds.push(...pe.binds, p.values[0], ...pe.binds, p.values[1]);
          } else throw new Error(`unsupported predicate: P.${p.op}`);
        } else {
          ctes.push(`c${ctes.length} AS (${join} WHERE ${pe.sql} = ?)`);
          binds.push(...pe.binds, val);
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
      // limit/range/skip compose as CTEs while still on the id-relation (before
      // any order()); once order() is seen they fold into the final select as
      // tail modifiers so ORDER BY + LIMIT + OFFSET stay in one query.
      case 'limit':
        ctes.push(`c${ctes.length} AS (SELECT id FROM ${prev()} LIMIT ${Number(s.args[0])})`);
        break;
      case 'range': {
        const { offset, limit } = rangeToOffsetLimit(s.args);
        ctes.push(`c${ctes.length} AS (SELECT id FROM ${prev()} LIMIT ${limit} OFFSET ${offset})`);
        break;
      }
      case 'skip':
        ctes.push(`c${ctes.length} AS (SELECT id FROM ${prev()} LIMIT -1 OFFSET ${Number(s.args[0])})`);
        break;
      default:
        return { ctes, binds, stop: i };
    }
  }
  return { ctes, binds, stop: i };
}

interface OrderClause { key: string | null; dir: 'asc' | 'desc' | 'shuffle'; }

function compileRead(steps: Step[]): Compiled {
  const { ctes, binds, stop } = traversalCtes(steps);
  const last = `c${ctes.length - 1}`;

  // Tail phase: an optional projection + order()/range()/skip()/limit() and dedup.
  let projStep: Step | null = null;
  const orders: OrderClause[] = [];
  let offset = 0, limit: number | null = null, distinct = false;

  const PROJECTIONS = new Set(['values', 'id', 'label', 'count', 'valueMap', 'elementMap']);

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
        if (orders.length === 0 && steps[i - 1]?.name !== 'order')
          throw new Error('by() is only supported as an order() modulator');
        const key = s.args.find((a) => typeof a === 'string') ?? null;
        const ord = s.args.find((a) => a && typeof a === 'object' && 'order' in a);
        orders.push({ key, dir: (ord?.order ?? 'asc') as OrderClause['dir'] });
        break;
      }
      case 'range': ({ offset, limit } = rangeToOffsetLimit(s.args)); break;
      case 'skip': offset = Number(s.args[0]); break;
      case 'limit': limit = Number(s.args[0]); break;
      case 'dedup': distinct = true; break;
      default:
        throw new Error(`step not implemented: ${s.name}()`);
    }
  }

  // Resolve the projection to a shape + a row source (cols/from/where).
  const projName = projStep?.name ?? 'vertex';
  let shape: Shape;
  const fb: any[] = []; // final-select binds, appended after the CTE-prefix binds

  // count folds any tail limit/offset/distinct into the counted id-relation.
  if (projName === 'count') {
    let src = `SELECT ${distinct ? 'DISTINCT ' : ''}id FROM ${last}`;
    if (limit !== null || offset > 0) src += ` LIMIT ${limit ?? -1} OFFSET ${offset}`;
    return { kind: 'read', sql: `WITH ${ctes.join(',\n')}\nSELECT COUNT(*) AS v FROM (${src})`, binds, shape: { kind: 'count' } };
  }

  const vJoin = `nodes n JOIN ${last} p ON n.id=p.id`;
  const vlJoin = `${vJoin} JOIN labels l ON l.id=n.label`;
  let cols: string, from: string, where = '';
  switch (projName) {
    case 'values': {
      shape = { kind: 'value' };
      const pe = propExtract('n.props', projStep!.args[0]);
      cols = `${pe.sql} AS v`; from = vJoin;
      where = ` WHERE ${pe.sql} IS NOT NULL`;
      fb.push(...pe.binds, ...pe.binds); // one set for the SELECT, one for the WHERE
      break;
    }
    case 'id':
      // Join nodes n even though the id lives in `last`, so a preceding
      // order().by(key) — which references n.props — has the alias in scope.
      shape = { kind: 'value' }; cols = `n.id AS v`; from = vJoin; break;
    case 'label':
      shape = { kind: 'value' }; cols = `l.name AS v`; from = vlJoin; break;
    case 'valueMap': {
      const keys = projStep!.args.filter((a) => typeof a === 'string') as string[];
      shape = { kind: 'valueMap', keys: keys.length ? keys : null, tokens: projStep!.args.includes(true) };
      cols = `n.id, l.name AS label, n.props`; from = vlJoin; break;
    }
    case 'elementMap': {
      const keys = projStep!.args.filter((a) => typeof a === 'string') as string[];
      shape = { kind: 'elementMap', keys: keys.length ? keys : null };
      cols = `n.id, l.name AS label, n.props`; from = vlJoin; break;
    }
    default: // vertex
      shape = { kind: 'vertex' }; cols = `n.id, l.name AS label, n.props`; from = vlJoin;
  }

  let sql = `SELECT ${distinct ? 'DISTINCT ' : ''}${cols} FROM ${from}${where}`;

  if (orders.length) {
    const parts = orders.map((o) => {
      if (o.dir === 'shuffle') return 'RANDOM()';
      const dir = o.dir === 'desc' ? 'DESC' : 'ASC';
      if (o.key !== null) { const pe = propExtract('n.props', o.key); fb.push(...pe.binds); return `${pe.sql} ${dir}`; }
      return `${shape.kind === 'value' ? 'v' : 'n.id'} ${dir}`;
    });
    sql += ` ORDER BY ${parts.join(', ')}`;
  }
  if (limit !== null || offset > 0) sql += ` LIMIT ${limit ?? -1} OFFSET ${offset}`;

  return { kind: 'read', sql: `WITH ${ctes.join(',\n')}\n${sql}`, binds: [...binds, ...fb], shape };
}

// g.V(...).<filters>.drop() — delete the target vertices and their incident
// edges. (Edge-valued drop, e.g. g.V().outE().drop(), waits on edge traversal.)
function compileDrop(steps: Step[]): WritePlan {
  const { ctes, binds, stop } = traversalCtes(steps.slice(0, -1));
  if (stop !== steps.length - 1)
    throw new Error(`drop() after ${steps[stop].name}() not yet supported`);
  const targetSql = `WITH ${ctes.join(',\n')}\nSELECT id FROM c${ctes.length - 1}`;
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

// g.inject(v1, v2, ...) — seed a value stream from constants. The collection /
// mid-traversal forms (and inject as a barrier) belong to the P2 select() work.
function compileInject(steps: Step[]): Compiled {
  if (steps.length !== 1) throw new Error('inject() with subsequent steps not yet supported');
  const vals = steps[0].args;
  if (vals.length === 0)
    return { kind: 'read', sql: `SELECT NULL AS v WHERE 0`, binds: [], shape: { kind: 'value' } };
  const rows = vals.map(() => '(?)').join(',');
  return { kind: 'read', sql: `WITH c0(v) AS (VALUES ${rows}) SELECT v FROM c0`, binds: vals, shape: { kind: 'value' } };
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
      const row = store.query(
        'INSERT INTO nodes(label, props) VALUES(?, ?) RETURNING id',
        [lid, JSON.stringify(props)],
      )[0];
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
      const row = store.query(
        'INSERT INTO edges(src, label, tgt) VALUES(?,?,?) RETURNING id',
        [src, lid, tgt],
      )[0];
      return [{ edge: { id: row.id, label, src, tgt } }];
    },
  };
}
