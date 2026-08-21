import { test, expect, describe } from 'bun:test';
import { driveSegments, driveSegmentsSync, type SegmentHost } from '../src/drive.ts';
import type { Plan } from '../src/compiler/segment.ts';
import type { Compiled, Executable } from '../src/sql/kernel/render.ts';
import type { BarrierInput, ForeignRow } from '../src/services/spi/types.ts';

// Phase 0 extracted the segment trampoline out of Executor into a free function over an injected host
// (src/drive.ts). The payoff is exactly this: the loop is now testable in-process with a FAKE host —
// no store, no compiler, no framing — so the trampoline's own semantics (degenerate pass-through, the
// read→apply→resume cycle, depth threading, the source-form null head, and the SYNC-barrier no-await
// path) are pinned independently of everything they used to be tangled with.

const sql = (tag: string): Executable => ({ kind: 'read', sql: tag, binds: [], shape: { kind: 'discard' } } as unknown as Executable);
const head = (tag: string): Compiled => ({ kind: 'read', sql: tag, binds: [], shape: { kind: 'value' } } as unknown as Compiled);
const throwSync = () => { throw new Error('readHeadSync should not be called for an async barrier'); };

describe('driveSegments', () => {
  test('a non-segmented plan returns its compiled immediately — no readHead, no apply', async () => {
    let reads = 0;
    const host: SegmentHost = {
      compile: () => ({ kind: 'sql', compiled: sql('DONE') }),
      readHead: () => { reads++; return []; },
      readHeadSync: () => { reads++; return []; },
    };
    const out = await driveSegments(host, 'g.V()', {}, {}, 0);
    expect((out as any).sql).toBe('DONE');
    expect(reads).toBe(0);
  });

  test('an ASYNC barrier loops read→apply→resume, then returns the resumed compiled', async () => {
    const seen: { readHead: string[]; applyRows: (readonly BarrierInput[])[]; resumeForeign: ForeignRow[][] } =
      { readHead: [], applyRows: [], resumeForeign: [] };
    const foreign: ForeignRow[] = [{ kind: 'vertex', id: 7, label: 'person', labels: ['person'], props: {} }];
    const segment: Plan = {
      kind: 'segment',
      mode: 'async',
      head: head('HEAD_SQL'),
      params: {},
      residency: 'worker',
      apply: async (rows) => { seen.applyRows.push(rows); return foreign; },
      resume: (f, headRows) => { seen.resumeForeign.push(f); expect(headRows).toBe(headRowsRef); return { kind: 'sql', compiled: sql('RESUMED') }; },
    };
    const headRowsRef: BarrierInput[] = [{ injectedValue: 'marko' }];
    const host: SegmentHost = {
      compile: () => segment,
      readHead: (h) => { seen.readHead.push((h as any).sql); return headRowsRef; },
      readHeadSync: throwSync,
    };
    const out = await driveSegments(host, 'g.V().call("x")', {}, {}, 0);
    expect((out as any).sql).toBe('RESUMED');
    expect(seen.readHead).toEqual(['HEAD_SQL']);      // the head was drained
    expect(seen.applyRows).toEqual([headRowsRef]);     // apply got the drained head rows
    expect(seen.resumeForeign).toEqual([foreign]);     // resume got apply's output
  });

  test('a SOURCE-form async barrier (null head) never calls readHead; apply gets []', async () => {
    let reads = 0;
    const segment: Plan = {
      kind: 'segment', mode: 'async', head: null, params: {}, residency: 'worker',
      apply: async (rows) => { expect(rows).toEqual([]); return []; },
      resume: () => ({ kind: 'sql', compiled: sql('SRC') }),
    };
    const host: SegmentHost = {
      compile: () => segment,
      readHead: () => { reads++; return []; },
      readHeadSync: throwSync,
    };
    const out = await driveSegments(host, 'g.call("x")', {}, {}, 0);
    expect((out as any).sql).toBe('SRC');
    expect(reads).toBe(0);
  });

  test('a SYNC barrier reads its head via readHeadSync (NOT readHead) and never calls apply', async () => {
    const seen = { readHead: 0, readHeadSync: [] as string[] };
    const headRowsRef: BarrierInput[] = [{ injectedValue: 'marko' }];
    const segment: Plan = {
      kind: 'segment', mode: 'sync', head: head('SYNC_HEAD'),
      resume: (headRows) => { expect(headRows).toBe(headRowsRef); return { kind: 'sql', compiled: sql('SYNC_DONE') }; },
    };
    const host: SegmentHost = {
      compile: () => segment,
      readHead: () => { seen.readHead++; return []; },        // must NOT be used
      readHeadSync: (h) => { seen.readHeadSync.push((h as any).sql); return headRowsRef; },
    };
    const out = await driveSegments(host, 'g.V().has("k", TextP.regex("^m"))', {}, {}, 0);
    expect((out as any).sql).toBe('SYNC_DONE');
    expect(seen.readHead).toBe(0);                            // the async reader was never touched
    expect(seen.readHeadSync).toEqual(['SYNC_HEAD']);
  });

  test('federationDepth is threaded into compile verbatim', async () => {
    let seenDepth = -1;
    const host: SegmentHost = {
      compile: (_g, _p, _pt, depth) => { seenDepth = depth; return { kind: 'sql', compiled: sql('D') }; },
      readHead: () => [],
      readHeadSync: () => [],
    };
    await driveSegments(host, 'g.V()', {}, {}, 3);
    expect(seenDepth).toBe(3);
  });
});

describe('driveSegmentsSync', () => {
  test('resolves a SYNC barrier chain with no await', () => {
    const headRows: BarrierInput[] = [{ injectedValue: 'x' }];
    const segment: Plan = {
      kind: 'segment', mode: 'sync', head: head('H'),
      resume: () => ({ kind: 'sql', compiled: sql('SYNC') }),
    };
    const out = driveSegmentsSync(() => headRows, segment);
    expect((out as any).sql).toBe('SYNC');
  });

  test('a non-segmented plan passes straight through', () => {
    const out = driveSegmentsSync(() => [], { kind: 'sql', compiled: sql('PLAIN') });
    expect((out as any).sql).toBe('PLAIN');
  });

  test('THROWS on an async barrier — there is no await here to run its transform', () => {
    const segment: Plan = {
      kind: 'segment', mode: 'async', head: head('H'), params: {}, residency: 'do',
      apply: async () => [], resume: () => ({ kind: 'sql', compiled: sql('X') }),
    };
    expect(() => driveSegmentsSync(() => [], segment)).toThrow(/async barrier/);
  });
});
