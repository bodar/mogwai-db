import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { decode } from '../support/decode.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';

// The OLAP barrier scratch table `barrier_state` is RESIDENT (survives across requests in a DO
// isolate), so every run token it holds must be reclaimed or it leaks for the isolate's life. The
// happy path defers that to the framer (`frameResolved`'s finally, via `plan.cleanup`); a chain that
// THROWS mid-drive — a chained/decorated barrier whose tail the lowering declines, AFTER an earlier
// `apply` already wrote its rows — never reaches the framer, so the drive drops the runs it allocated
// in its own catch (`src/drive.ts` `dropRuns`). Substrate: reshape plan §8.

const PR = 'gremlin.pageRankVertexProgram.pageRank';
const rows = (store: ReturnType<typeof seeded>) =>
  store.query<{ c: number }>('SELECT count(*) AS c FROM barrier_state')[0].c;

describe('barrier_state run-token GC — no leak on the happy path or on a throw', () => {
  test('a completed OLAP query leaves no scratch rows (framer cleanup)', async () => {
    const store = seeded(MODERN_SEED);
    const out = await exec(store).framedAsync(`g.V().pageRank().count()`, {});
    out.map((f) => decode(f.buf)); // drain
    expect(rows(store)).toBe(0);
  });

  test('a single barrier whose tail DECLINES at resume leaks nothing (drop-on-throw)', async () => {
    const store = seeded(MODERN_SEED);
    // has(decoratedKey, <value>) is not supported over a decorated property — it throws during the
    // resume's lowering, AFTER pageRank's apply wrote its run's rows. Those must be dropped, not leaked.
    await expect(exec(store).framedAsync(`g.V().pageRank().has("${PR}", 0.15)`, {})).rejects.toThrow();
    expect(rows(store)).toBe(0);
  });

  test('a CHAINED barrier that declines at the final resume drops BOTH runs', async () => {
    const store = seeded(MODERN_SEED);
    // pageRank apply writes run A; connectedComponent apply writes run B; then has(PR, value) declines.
    // Neither run reaches the framer's cleanup — the drive's catch must drop both.
    await expect(exec(store).framedAsync(`g.V().pageRank().connectedComponent().has("${PR}", 0.15)`, {})).rejects.toThrow();
    expect(rows(store)).toBe(0);
  });

  test('the sync framed() path drops on throw too', () => {
    const store = seeded(MODERN_SEED);
    // pageRank has a synchronous core, so framed() drives it; the same decline must not leak.
    expect(() => exec(store).framed(`g.V().pageRank().has("${PR}", 0.15)`, {})).toThrow();
    expect(rows(store)).toBe(0);
  });
});
