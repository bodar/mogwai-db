import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { aliasOf, fromTree, shapeOf } from '../src/rel/block.ts';
import { emitQuery } from '../src/rel/emit.ts';
import { planOf } from '../src/rel/plan.ts';
import { col, compilerInt, compilerNull, compilerText, lit } from '../src/rel/expr.ts';
import type { Expr } from '../src/rel/expr.ts';
import { aggregate, distinct, filter, join, limit, project, recursive, scan as scanRel, sort, union, values, window } from '../src/rel/factory.ts';
import type { Channels } from '../src/channels.ts';
import type { Rel } from '../src/rel/rel.ts';
import { relId } from '../src/rel/types.ts';

/**
 * An EMITTER SNAPSHOT — one exact string per node kind, and the block assembler's own properties.
 *
 * It is deliberately NOT the Phase-1 exit gate, and an earlier version of the build plan recorded it
 * as one: a gate over ten L2 traversal FAMILIES cannot be met by transcribing the emitter's own
 * output, which is what a per-kind pin is. It survives because a byte-exact record of what one node
 * renders to is the cheapest way to review an emitter change, and because the assembler's whole
 * claim — a run of operators is ONE `SELECT`, and a nested one opens only where a slot is already
 * occupied — is a statement about strings.
 */
const channels: Channels = [];
const cols = [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'text', nullable: false }] as const;
const pairedCols = [...cols, ...cols.map((column) => ({ ...column, name: `${column.name}_r` }))] as const;
const scan = (id: string, alias = id) => scanRel({ id: relId(id), table: 'nodes', alias, channels, type: { cols } });
const eq = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: '=', left, right });

describe('RelIR relational-core SQL', () => {
  test('compiler text is escaped SQL syntax; query data remains a bind', () => {
    const v = values({
      id: relId('v'), channels, type: { cols },
      rows: [[compilerText("O'Reilly"), lit("O'Reilly", 'text')]],
    });
    const emitted = emitQuery(planOf(v));
    expect(emitted.sql).toBe("SELECT v.column1 AS id, v.column2 AS name FROM (VALUES ('O''Reilly', ?)) v");
    expect(emitted.binds).toEqual(["O'Reilly"]);
  });

  test('compiler integer and NULL syntax do not turn identical query data into SQL text', () => {
    const v = values({
      id: relId('v'), channels, type: { cols },
      rows: [[compilerInt(1), compilerNull()], [lit(1, 'int'), lit(null, 'any')]],
    });
    const emitted = emitQuery(planOf(v));
    expect(emitted.sql).toBe('SELECT v.column1 AS id, v.column2 AS name FROM (VALUES (1, NULL), (?, ?)) v');
    expect(emitted.binds).toEqual([1, null]);
    expect(() => compilerInt(1.5)).toThrow('safe integer');
  });

  test('pins the rendering of every relational node kind', () => {
    const n = scan('n');
    const v = values({ id: relId('v'), rows: [[lit(1, 'int'), lit('marko', 'text')]], channels, type: { cols } });
    const p = project({ id: relId('p'), input: n, channels, type: { cols }, exprs: [['id', col(n.id, 'id')], ['name', col(n.id, 'name')]] });
    const f = filter({ id: relId('f'), input: n, channels, type: { cols }, pred: eq(col(n.id, 'name'), lit('marko', 'text')) });
    const a = aggregate({ id: relId('a'), input: n, channels, type: { cols: [{ name: 'n', type: 'int', nullable: false }] }, groupBy: [], aggs: [['n', { kind: 'agg', fn: 'count', args: [] }]] });
    const s = sort({ id: relId('s'), input: n, channels, type: { cols }, terms: [{ expr: col(n.id, 'name'), dir: 'asc' }] });
    const l = limit({ id: relId('l'), input: n, channels, type: { cols }, count: lit(2, 'int') });
    const d = distinct({ id: relId('d'), input: n, channels, type: { cols } });
    const m = scan('m');
    const j = join({ id: relId('j'), left: n, right: m, join: 'inner', on: eq(col(n.id, 'id'), col(m.id, 'id')), channels, type: { cols: pairedCols } });
    const u = union({ id: relId('u'), inputs: [n, m], all: true, channels, type: { cols } });

    expect([
      emitQuery(planOf(v)).sql,
      emitQuery(planOf(p)).sql,
      emitQuery(planOf(f)).sql,
      emitQuery(planOf(a)).sql,
      emitQuery(planOf(s)).sql,
      emitQuery(planOf(l)).sql,
      emitQuery(planOf(d)).sql,
      emitQuery(planOf(j)).sql,
      emitQuery(planOf(u)).sql,
      emitQuery(planOf(recursive({ id: relId('walk'), name: 'walk', cols: ['id', 'name'], seed: v, channels, type: { cols }, step: (self) => self }))).sql,
    ]).toEqual([
      'SELECT v.column1 AS id, v.column2 AS name FROM (VALUES (?, ?)) v',
      'SELECT n.id AS id, n.name AS name FROM nodes n',
      'SELECT n.id AS id, n.name AS name FROM nodes n WHERE (n.name = ?)',
      'SELECT count(*) AS n FROM nodes n',
      'SELECT n.id AS id, n.name AS name FROM nodes n ORDER BY n.name ASC',
      'SELECT n.id AS id, n.name AS name FROM nodes n LIMIT ?',
      'SELECT DISTINCT n.id AS id, n.name AS name FROM nodes n',
      'SELECT n.id AS id, n.name AS name, m.id AS id_r, m.name AS name_r FROM nodes n INNER JOIN nodes m ON (n.id = m.id)',
      // Unparenthesised on purpose: SQLite's compound arms are select-CORES, and `(SELECT …) UNION
      // ALL (SELECT …)` is `near "(": syntax error`.
      'SELECT n.id AS id, n.name AS name FROM nodes n UNION ALL SELECT m.id AS id, m.name AS name FROM nodes m',
      'WITH RECURSIVE walk(id, name) AS (SELECT v.column1 AS id, v.column2 AS name FROM (VALUES (?, ?)) v UNION ALL SELECT walk.id AS id, walk.name AS name FROM walk walk) SELECT * FROM walk',
    ]);
  });

  /**
   * THE ANTI-DRIFT GATE FOR `src/rel/block.ts`.
   *
   * `check` decides a `Recursive` step's legality by asking the block analysis where the walk's
   * reference LANDS — and that analysis is the emitter's fusion walk with every rendered expression
   * removed. The rules themselves cannot disagree (`NEEDS_SUBQUERY`/`spliceable` have one
   * definition, which the assembler reads), but the TRAVERSAL is written twice, and a divergence
   * there is the worst failure available: a plan the checker admits and the emitter then wraps,
   * which SQLite answers with `circular reference` — a production throw no unit test would see.
   *
   * So the analysis is pinned against the STRINGS. For each shape below, the relations `fromTree`
   * says stand unwrapped in the FROM join tree must be exactly the aliases the emitted SQL puts
   * there — a derived table, a table-valued function and a compound arm each contributing none.
   */
  test('the block analysis agrees with the SQL the emitter actually renders', () => {
    /** FROM items standing UNWRAPPED at the top level of a single-SELECT statement. A `(SELECT …)`
     *  is a derived table and a `json_each(…)` a table-valued function — neither is a relation of
     *  the algebra standing in this FROM — while `(VALUES …)` IS a row source despite its parens. */
    const emittedSources = (sql: string): readonly string[] => {
      const tokens = sql.match(/\(|\)|[A-Za-z_][A-Za-z0-9_]*|\S/g) ?? [];
      const closes = (from: number): number => {
        let depth = 0;
        for (let j = from; j < tokens.length; j++) {
          if (tokens[j] === '(') depth++;
          else if (tokens[j] === ')' && --depth === 0) return j;
        }
        throw new Error(`unbalanced parentheses in ${sql}`);
      };
      const out: string[] = [];
      let depth = 0;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token === '(') { depth++; continue; }
        if (token === ')') { depth--; continue; }
        if (depth !== 0 || !/^(FROM|JOIN)$/i.test(token)) continue;
        const head = tokens[i + 1]!;
        if (head === '(') {
          const end = closes(i + 1);
          if (/^VALUES$/i.test(tokens[i + 2] ?? '')) out.push(tokens[end + 1]!);
          i = end + 1;
        } else if (tokens[i + 2] === '(') {
          i = closes(i + 2) + 1;                       // json_each(…) alias — an alias, not a source
        } else {
          out.push(tokens[i + 2]!);                    // <table> <alias>
          i += 2;
        }
      }
      return out;
    };

    /** EVERY FROM-item alias standing at the TOP LEVEL of this statement — a table source, a
     *  `(VALUES …)`, a `json_each(…)` and a derived `(SELECT …)` alike each contribute their own
     *  alias (a source inside a derived table is a different SELECT and contributes none). This is
     *  the set `free`/`maySplice` test a splice against, so pinning it is what keeps `aliasOf` and the
     *  alias bookkeeping honest across the two modules. */
    const emittedAliases = (sql: string): readonly string[] => {
      const tokens = sql.match(/\(|\)|[A-Za-z_][A-Za-z0-9_]*|\S/g) ?? [];
      const closes = (from: number): number => {
        let depth = 0;
        for (let j = from; j < tokens.length; j++) {
          if (tokens[j] === '(') depth++;
          else if (tokens[j] === ')' && --depth === 0) return j;
        }
        throw new Error(`unbalanced parentheses in ${sql}`);
      };
      const out: string[] = [];
      let depth = 0;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token === '(') { depth++; continue; }
        if (token === ')') { depth--; continue; }
        if (depth !== 0 || !/^(FROM|JOIN)$/i.test(token)) continue;
        if (tokens[i + 1] === '(') { const end = closes(i + 1); out.push(tokens[end + 1]!); i = end + 1; }        // (SELECT…)/(VALUES…) alias
        else if (tokens[i + 2] === '(') { const end = closes(i + 2); out.push(tokens[end + 1]!); i = end + 1; }   // json_each(…) alias
        else { out.push(tokens[i + 2]!); i += 2; }                                                                // <table> alias
      }
      return out;
    };

    const n = scan('n');
    const m = scan('m');
    const shadow = scanRel({ id: relId('shadow'), table: 'nodes', alias: 'n', channels, type: { cols } });
    const v = values({ id: relId('v'), rows: [[lit(1, 'int'), lit('marko', 'text')]], channels, type: { cols } });
    const both = (left: Rel, right: Rel, id: string, kind: 'inner' | 'left' | 'cross' | 'semi' | 'anti' = 'inner') =>
      join({ id: relId(id), left, right, join: kind, channels,
        // A LEFT join null-pads its right side, so those outputs must be declared nullable.
        type: { cols: kind === 'semi' || kind === 'anti' ? [...cols]
          : [...cols, ...cols.map((c) => ({ ...c, name: `${c.name}_r`, nullable: kind === 'left' }))] },
        ...(kind === 'cross' ? {} : { on: eq(col(left.id, 'id'), col(right.id, 'id')) }) });
    const pass = (id: string, input: Rel) => project({ id: relId(id), input, channels, type: { cols },
      exprs: [['id', col(input.id, 'id')], ['name', col(input.id, 'name')]] });
    const kept = (id: string, input: Rel) => filter({ id: relId(id), input, channels, type: { cols }, pred: eq(col(input.id, 'name'), lit('x', 'text')) });
    const deduped = (id: string, input: Rel) => distinct({ id: relId(id), input, channels, type: { cols } });
    const capped = (id: string, input: Rel) => limit({ id: relId(id), input, channels, type: { cols }, count: lit(2, 'int') });

    const shapes = [
      n,
      pass('p1', n),
      kept('f1', pass('p2', n)),
      both(n, m, 'j1'),
      pass('p3', both(n, m, 'j2')),
      both(kept('f2', n), m, 'j3'),                    // a spliceable side lifts its own FROM item
      both(deduped('d1', n), m, 'j4'),                 // …and a DISTINCT side fills a slot, so it nests
      both(m, deduped('d2', n), 'j5'),
      both(n, shadow, 'j6'),                           // an alias collision pushes the side into its own SELECT
      both(n, m, 'j7', 'left'),
      // ⚠️ A LEFT join may NOT splice its right side — its predicate has to stay inside the subquery,
      // or an unmatched row is filtered instead of null-padded. The same side under an INNER join
      // splices, so this pair is what makes the rule observable at all.
      both(n, kept('f3', m), 'j11', 'left'),
      both(n, kept('f4', m), 'j12'),
      both(n, m, 'j8', 'cross'),
      both(n, m, 'j9', 'semi'),                        // the right side is an EXISTS, never a FROM item
      capped('l1', capped('l2', n)),                   // the occupied slot that nests
      sort({ id: relId('s1'), input: deduped('d3', n), channels, type: { cols }, terms: [{ expr: col(relId('d3'), 'name'), dir: 'asc' }] }),
      v,
      pass('p4', v),
      both(v, m, 'j10'),
      aggregate({ id: relId('a1'), input: n, channels, type: { cols: [{ name: 'c', type: 'int', nullable: false }] }, groupBy: [], aggs: [['c', { kind: 'agg', fn: 'count', args: [] }]] }),
      window({ id: relId('w1'), input: n, channels, type: { cols: [...cols, { name: 'rn', type: 'int', nullable: false }] },
        specs: [['rn', { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [], orderBy: [{ expr: col(n.id, 'name'), dir: 'asc' }] } }]] }),
    ];

    for (const shape of shapes) {
      const predicted = fromTree(shape).map((source) => aliasOf(source));
      const sql = emitQuery(planOf(shape)).sql;
      expect({ shape: shape.id, sources: predicted }).toEqual({ shape: shape.id, sources: [...emittedSources(sql)] });
      // …and the FULL alias set the analysis says this block occupies — not only the unwrapped
      // sources, but the derived tables and `json_each` items too — is exactly what the SQL puts in
      // FROM. This is the set the splice/`free` collision test reads, so it must agree byte-for-byte.
      const analysed = shapeOf(shape);
      const predictedAliases = analysed === 'closed' ? [] : analysed.aliases;
      expect({ shape: shape.id, aliases: predictedAliases }).toEqual({ shape: shape.id, aliases: [...emittedAliases(sql)] });
    }
  });

  /** A compound is a complete SELECT of its own, so nothing inside it stands in an enclosing FROM —
   *  which is why the walk above cannot cover it, and why a `Union` step is refused outright. */
  test('a compound relation exposes no FROM item to the level above it', () => {
    expect(fromTree(union({ id: relId('u1'), inputs: [scan('n'), scan('m')], all: true, channels, type: { cols } }))).toEqual([]);
  });

  test('a run of operators is ONE SELECT, not one derived table per node', () => {
    const edgeCols = [{ name: 'src', type: 'int', nullable: false }, { name: 'tgt', type: 'int', nullable: false }] as const;
    const e = scanRel({ id: relId('e'), table: 'edges', alias: 'e', channels, type: { cols: edgeCols } });
    const p = scan('p');
    const joined = join({
      id: relId('j'), left: e, right: p, join: 'inner', channels,
      on: eq(col(e.id, 'src'), col(p.id, 'id')),
      type: { cols: [...edgeCols, ...cols] },
    });
    const kept = filter({ id: relId('kept'), input: joined, channels, type: joined.type, pred: eq(col(joined.id, 'name'), lit('marko', 'text')) });
    const out = project({ id: relId('out'), input: kept, channels, type: { cols: [{ name: 'id', type: 'int', nullable: false }] }, exprs: [['id', col(kept.id, 'tgt')]] });

    expect(emitQuery(planOf(out)).sql).toBe('SELECT e.tgt AS id FROM edges e INNER JOIN nodes p ON (e.src = p.id) WHERE (p.name = ?)');
  });

  test('a nested SELECT opens exactly where a slot is already occupied', () => {
    const n = scan('n');
    const capped = limit({ id: relId('capped'), input: n, channels, type: { cols }, count: lit(2, 'int') });
    // LIMIT is the slot the outer LIMIT needs, so this one — and only this one — nests.
    const twice = limit({ id: relId('twice'), input: capped, channels, type: { cols }, count: lit(1, 'int') });
    expect(emitQuery(planOf(twice)).sql).toBe('SELECT capped.id AS id, capped.name AS name FROM (SELECT n.id AS id, n.name AS name FROM nodes n LIMIT ?) capped LIMIT ?');

    // A filter over the same source needs only WHERE, which is free, so nothing nests.
    const named = filter({ id: relId('named'), input: n, channels, type: { cols }, pred: eq(col(n.id, 'name'), lit('marko', 'text')) });
    expect(emitQuery(planOf(named)).sql).not.toContain('(SELECT');
  });

  test('a Window over a WINDOWED block nests, because SQLite refuses one inside another OVER', () => {
    // The rule is legality, not preference: a window's `OVER (…)` may never reference a window
    // function, so a spec reading a column its input MINTED with one has no legal spelling in the
    // same SELECT. This is the exact shape a lowering produces when a step mints an emission order
    // and a later window ranks by it, and SQLite's answer is a THROW — so it is pinned by EXECUTING
    // the emitted SQL, not only by reading it.
    const n = scan('n');
    const position = window({
      id: relId('position'), input: n, channels,
      type: { cols: [...cols, { name: 'rn', type: 'int', nullable: false }] },
      specs: [['rn', { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [], orderBy: [{ expr: col(n.id, 'name'), dir: 'asc' }] } }]],
    });
    const ranked = window({
      id: relId('ranked'), input: position, channels,
      type: { cols: [...position.type.cols, { name: 'rk', type: 'int', nullable: false }] },
      specs: [['rk', { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [col(position.id, 'name')], orderBy: [{ expr: col(position.id, 'rn'), dir: 'asc' }] } }]],
    });
    const emitted = emitQuery(planOf(ranked));
    expect(emitted.sql).toContain('(SELECT');
    // The inner window is named, not re-spelled, in the outer OVER.
    expect(emitted.sql).toContain('OVER (PARTITION BY position.name ORDER BY position.rn ASC)');

    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'marko'), (3, 'vadas')");
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([
      { id: 1, name: 'marko', rn: 1, rk: 1 }, { id: 2, name: 'marko', rn: 2, rk: 2 }, { id: 3, name: 'vadas', rn: 3, rk: 1 },
    ]);
    db.close();
  });

  test('a Filter over an Aggregate is HAVING, not a wrapping SELECT', () => {
    const n = scan('n');
    const byName = aggregate({
      id: relId('byName'), input: n, channels,
      type: { cols: [{ name: 'name', type: 'text', nullable: false }, { name: 'n', type: 'int', nullable: false }] },
      groupBy: [col(n.id, 'name')], aggs: [['n', { kind: 'agg', fn: 'count', args: [] }]],
    });
    const popular = filter({ id: relId('popular'), input: byName, channels, type: byName.type, pred: { kind: 'binary', op: '>', left: col(byName.id, 'n'), right: lit(1, 'int') } });
    const emitted = emitQuery(planOf(popular));
    expect(emitted.sql).toBe('SELECT n.name AS name, count(*) AS n FROM nodes n GROUP BY n.name HAVING (count(*) > ?)');

    const db = new Database(':memory:');
    db.run('CREATE TABLE nodes (id INTEGER, name TEXT)');
    db.run("INSERT INTO nodes VALUES (1, 'marko'), (2, 'marko'), (3, 'vadas')");
    expect(db.query(emitted.sql).all(...emitted.binds)).toEqual([{ name: 'marko', n: 2 }]);
    db.close();
  });
});
