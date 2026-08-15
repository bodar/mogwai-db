// SQLite's JSON channel loses precision two ways — its WRITER serializes a binary64 REAL at 15
// significant digits, and a JS reader's JSON.parse rounds an INTEGER past 2^53. `jsonMember`
// (build.ts) is the ONE JSON-entry repair, so any numeric value survives a json_object/json_array/
// json_group_array at any depth. This pins the REAL half: a computed mean that needs 16-17 digits
// round-trips exactly through the blob. See docs/2026-08-01-relir-build-plan.md §12.
import { test, expect, describe } from 'bun:test';
import { run, seededStore } from '../support/harness.ts';

// The value side of a group whose key is `name`, as a Map<name, number>.
const meanByName = (g: string): Record<string, { t: string; v: number }> => {
  const rows = run(seededStore(), g) as { map: string }[];
  const pairs = JSON.parse(rows[0]!.map) as [{ v: string }, { t: string; v: number }][];
  return Object.fromEntries(pairs.map(([k, v]) => [k.v, v]));
};

describe('a binary64 survives the JSON blob (§12 real precision)', () => {
  test('group-scoped mean carries all 17 digits, not 15', () => {
    // lop's incident created-edge weights are 0.4, 0.4, 0.2 → mean exactly 1/3, which needs 16 digits;
    // the 15-digit form 0.333333333333333 is a DIFFERENT binary64. The blob must round-trip to 1/3.
    const m = meanByName('g.V().hasLabel("software").group().by("name").by(__.bothE().values("weight").mean())');
    expect(m.lop!.t).toBe('double');
    expect(m.lop!.v).toBe(1 / 3);            // exact binary64 equality — the whole point
    expect(m.ripple!.v).toBe(1);             // josh→ripple weight 1.0, mean of one value
  });

  test("a mean whose value is a non-exact whole-ish double keeps its exact bits", () => {
    // josh's incident weights are 0.4 (created lop), 1.0 (created ripple), 1.0 (knows, inbound) → 2.4/3,
    // which is 0.79999999999999993 in binary64 (NOT 0.8). The 15-digit form '0.8' would round-trip to a
    // DIFFERENT double, so the lossy-guard must fire and keep the exact value.
    const m = meanByName('g.V().hasLabel("person").group().by("name").by(__.bothE().values("weight").mean())');
    expect(m.josh!.v).toBe(2.4 / 3);
  });
});
