// Collection sites inside a BRANCH arm (union/choose/coalesce). The branch merges a fresh unordered
// stream, so it drops/mints the encounter a downstream collecting cap demands rather than declining
// (unionArms/chooseArms/coalesceArms, lower.ts). A coalesce arm that is a pure stream-identity
// side effect always fires, so it exhausts the coalesce (isStreamIdentity whole-body check).
import { test, expect, describe } from 'bun:test';
import { run, seededStore } from '../support/harness.ts';

describe('collection sites inside a branch arm', () => {
  const one = (store: ReturnType<typeof seededStore>, g: string) =>
    (run(store, g) as { v: unknown }[])[0]!.v;

  test('union arm sites accumulate into the root label and cap unfolds', () => {
    const store = seededStore();
    // both arms run over every vertex; arm 0 aggregates all 6
    expect(one(store, 'g.V().union(__.aggregate("a"), __.identity()).cap("a").unfold().count()')).toBe(6);
    // out() (6) + in() (6) over the 6-edge modern graph = 12 members in "a"
    expect(one(store, 'g.V().union(__.out().aggregate("a"), __.in().aggregate("a")).cap("a").unfold().count()')).toBe(12);
  });

  test('choose arm sites accumulate', () => {
    const store = seededStore();
    expect(one(store, 'g.V().choose(__.hasLabel("person"), __.aggregate("a"), __.aggregate("a")).cap("a").unfold().count()')).toBe(6);
  });

  test('a stream-identity coalesce arm always fires and exhausts the coalesce', () => {
    const store = seededStore();
    // arm 0 (aggregate) always produces, so every vertex takes it; the identity fallback never fires
    expect(one(store, 'g.V().coalesce(__.aggregate("a"), __.identity()).cap("a").unfold().count()')).toBe(6);
  });
});
