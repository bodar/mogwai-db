import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { Channels } from '../src/channels.ts';
import { runProgram } from '../src/program.ts';
import { col, lit } from '../src/rel/expr.ts';
import { filter, project, ref, scan, values } from '../src/rel/factory.ts';
import { plan } from '../src/rel/plan.ts';
import { insert, remove } from '../src/rel/stmt-factory.ts';
import { relId } from '../src/rel/types.ts';

/**
 * The binding executor over real SQLite. These are about ORDER and RETENTION — the two things
 * `Plan.bindings` exists to state — not about SQL spelling, which `test/stmt.test.ts` pins.
 */
const channels: Channels = [];
const ids = [{ name: 'id', type: 'int', nullable: false }] as const;
const noReturning = { cols: [] } as const;
const nodes = scan({ id: relId('nodes'), table: 'nodes', alias: 'nodes', channels,
  type: { cols: [{ name: 'id', type: 'int', nullable: false }, { name: 'uid', type: 'text', nullable: true }] },
});

const store = () => {
  const db = new Database(':memory:');
  db.run('CREATE TABLE nodes (id INTEGER PRIMARY KEY, uid TEXT)');
  return { db, query: <T>(sql: string, binds: readonly unknown[] = []) => db.query(sql).all(...(binds as any[])) as T[] };
};

describe('RelIR programs', () => {
  test('runs statement bindings in order and returns the result rows', () => {
    const rows = values({ id: relId('rows'), channels, rows: [[lit(1, 'int'), lit('a', 'text')], [lit(2, 'int'), lit('b', 'text')]],
      type: { cols: [{ name: 'id', type: 'int', nullable: false }, { name: 'uid', type: 'text', nullable: false }] } });
    const added = insert({ target: nodes, cols: ['id', 'uid'], source: rows, channels, type: { cols: ids },
      returning: [['id', col(nodes.id, 'id')]] });
    const source = store();

    expect(runProgram(source, plan({ bindings: [{ name: 'added', node: added }], result: ref({ id: relId('r'), name: 'added', channels, type: { cols: ids } }) })))
      .toEqual([{ id: 1 }, { id: 2 }]);
    expect(source.db.query('SELECT id, uid FROM nodes').all()).toEqual([{ id: 1, uid: 'a' }, { id: 2, uid: 'b' }]);
    source.db.close();
  });

  test('a later step sees the PRE-MUTATION rows a statement returned, not a re-evaluated source', () => {
    const source = store();
    source.db.run("INSERT INTO nodes VALUES (1, 'a'), (2, 'b'), (3, 'c')");

    // Step 1 renames the two low-numbered vertices and RETAINS which ids it touched. Step 2 deletes
    // exactly those. Re-evaluating "id < 3" after step 1 would be the same answer here; re-evaluating
    // "uid = 'renamed'" would not — so the second is what the retention has to survive.
    const renamed = filter({ id: relId('renamed'), input: nodes, channels, type: nodes.type,
      pred: { kind: 'binary', op: '<', left: col(nodes.id, 'id'), right: lit(3, 'int') } });
    const touched = insert({
      // An upsert: the ids already exist, so ON CONFLICT rewrites their uid and RETURNS them.
      target: nodes, cols: ['id', 'uid'], channels, type: { cols: ids },
      source: project({ id: relId('renamedRows'), input: renamed, channels,
        type: { cols: [{ name: 'id', type: 'int', nullable: false }, { name: 'uid', type: 'text', nullable: false }] },
        exprs: [['id', col(renamed.id, 'id')], ['uid', lit('renamed', 'text')]] }),
      onConflict: { target: ['id'], set: [['uid', lit('renamed', 'text')]] },
      returning: [['id', col(nodes.id, 'id')]],
    });
    const prior = ref({ id: relId('prior'), name: 'touched', channels, type: { cols: ids } });

    runProgram(source, plan({
      bindings: [
        { name: 'touched', node: touched },
        { name: 'dropped', node: remove({ target: nodes, channels, type: noReturning, returning: [], where: { kind: 'in-query', expr: col(nodes.id, 'id'), plan: prior, negated: false } }) },
      ],
      result: ref({ id: relId('dropped'), name: 'dropped', channels, type: noReturning }),
    }));

    expect(source.db.query('SELECT id, uid FROM nodes').all()).toEqual([{ id: 3, uid: 'c' }]);
    source.db.close();
  });

  test('refuses to transport a value JSON cannot carry losslessly, naming the column', () => {
    const source = store();
    source.db.run("INSERT INTO nodes VALUES (1, 'a')");
    source.db.run('CREATE TABLE blobs (id INTEGER PRIMARY KEY, payload BLOB)');
    source.db.run("INSERT INTO blobs VALUES (1, x'0102')");
    const blobs = scan({ id: relId('blobs'), table: 'nodes', alias: 'blobs', channels,
      type: { cols: [{ name: 'id', type: 'int', nullable: false }, { name: 'payload', type: 'blob', nullable: true }] } });
    const captured = remove({
      target: blobs, channels, type: { cols: [...blobs.type.cols] },
      where: { kind: 'binary', op: '=', left: col(blobs.id, 'id'), right: lit(1, 'int') },
      returning: [['id', col(blobs.id, 'id')], ['payload', col(blobs.id, 'payload')]],
    });
    const prior = ref({ id: relId('priorBlobs'), name: 'captured', channels, type: { cols: [...blobs.type.cols] } });

    expect(() => runProgram({ query: () => [{ id: 1, payload: new Uint8Array([1, 2]) }] as any }, plan({
      bindings: [
        { name: 'captured', node: captured },
        { name: 'again', node: remove({ target: blobs, channels, type: noReturning, returning: [], where: { kind: 'in-query', expr: col(blobs.id, 'id'), plan: prior, negated: false } }) },
      ],
      result: ref({ id: relId('again'), name: 'again', channels, type: noReturning }),
    }))).toThrow("column 'payload' holds a object that JSON transport cannot carry losslessly");
    source.db.close();
  });
});
