import { test, expect, describe } from 'bun:test';
import { driveSegments, type SegmentHost } from '../src/drive.ts';
import type { Plan } from '../src/compiler/segment.ts';
import type { Compiled, Executable } from '../src/sql/kernel/render.ts';
import type { BarrierInput, ForeignRow } from '../src/services/spi/types.ts';

// Phase 0 extracted the segment trampoline out of Executor into a free function over an injected host
// (src/drive.ts). The payoff is exactly this: the loop is now testable in-process with a FAKE host —
// no store, no compiler, no framing — so the trampoline's own semantics (degenerate pass-through, the
// read→apply→resume cycle, depth threading, the source-form null head) are pinned independently of
// everything they used to be tangled with.

const sql = (tag: string): Executable => ({ kind: 'read', sql: tag, binds: [], shape: { kind: 'discard' } } as unknown as Executable);
const head = (tag: string): Compiled => ({ kind: 'read', sql: tag, binds: [], shape: { kind: 'value' } } as unknown as Compiled);

describe('driveSegments', () => {
  test('a non-segmented plan returns its compiled immediately — no readHead, no apply', async () => {
    let reads = 0;
    const host: SegmentHost = {
      compile: () => ({ kind: 'sql', compiled: sql('DONE') }),
      readHead: () => { reads++; return []; },
    };
    const out = await driveSegments(host, 'g.V()', {}, {}, 0);
    expect((out as any).sql).toBe('DONE');
    expect(reads).toBe(0);
  });

  test('a barrier loops read→apply→resume, then returns the resumed compiled', async () => {
    const seen: { readHead: string[]; applyRows: (readonly BarrierInput[])[]; resumeForeign: ForeignRow[][] } =
      { readHead: [], applyRows: [], resumeForeign: [] };
    const foreign: ForeignRow[] = [{ kind: 'vertex', id: 7, label: 'person', labels: ['person'], props: {} }];
    const segment: Plan = {
      kind: 'segment',
      head: head('HEAD_SQL'),
      params: {},
      apply: async (rows) => { seen.applyRows.push(rows); return foreign; },
      resume: (f, headRows) => { seen.resumeForeign.push(f); expect(headRows).toBe(headRowsRef); return { kind: 'sql', compiled: sql('RESUMED') }; },
    };
    const headRowsRef: BarrierInput[] = [{ injectedValue: 'marko' }];
    const host: SegmentHost = {
      compile: () => segment,
      readHead: (h) => { seen.readHead.push((h as any).sql); return headRowsRef; },
    };
    const out = await driveSegments(host, 'g.V().call("x")', {}, {}, 0);
    expect((out as any).sql).toBe('RESUMED');
    expect(seen.readHead).toEqual(['HEAD_SQL']);      // the head was drained
    expect(seen.applyRows).toEqual([headRowsRef]);     // apply got the drained head rows
    expect(seen.resumeForeign).toEqual([foreign]);     // resume got apply's output
  });

  test('a SOURCE-form barrier (null head) never calls readHead; apply gets []', async () => {
    let reads = 0;
    const segment: Plan = {
      kind: 'segment', head: null, params: {},
      apply: async (rows) => { expect(rows).toEqual([]); return []; },
      resume: () => ({ kind: 'sql', compiled: sql('SRC') }),
    };
    const host: SegmentHost = {
      compile: () => segment,
      readHead: () => { reads++; return []; },
    };
    const out = await driveSegments(host, 'g.call("x")', {}, {}, 0);
    expect((out as any).sql).toBe('SRC');
    expect(reads).toBe(0);
  });

  test('federationDepth is threaded into compile verbatim', async () => {
    let seenDepth = -1;
    const host: SegmentHost = {
      compile: (_g, _p, _pt, depth) => { seenDepth = depth; return { kind: 'sql', compiled: sql('D') }; },
      readHead: () => [],
    };
    await driveSegments(host, 'g.V()', {}, {}, 3);
    expect(seenDepth).toBe(3);
  });
});
