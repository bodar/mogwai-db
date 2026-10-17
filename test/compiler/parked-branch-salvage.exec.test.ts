// THE PARKED BRANCHES' FAIL-CLOSED RESIDUE — each a shape that reached the user as an INTERNAL error (a
// checker assertion, a framer TypeError) or as a different question answered, now a plain
// `UnsupportedTraversal`. An L4 `@Unsupported` scenario cannot pin these: it accepts ANY thrown `Error`, the
// internal ones included, so the class is asserted here. Reference answers live beside the L4 twins in
// `test/L4-addendum/parked-branch-salvage.feature`.
import { test, expect, describe } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';
import { UnsupportedTraversal } from '../../src/compiler/compiler.ts';

const answer = async (q: string): Promise<unknown[]> => decodeAll(executeQuery(seededStore(), q));
const declines = async (q: string): Promise<void> => {
  let thrown: unknown;
  try { await answer(q); } catch (error) { thrown = error; }
  expect(thrown, q).toBeInstanceOf(UnsupportedTraversal);
};

describe('a write in a predicate body declines at every filter host (writesAnywhere)', () => {
  // Was "RelIR: Ref 'pwN' is not a Plan binding declared before this point".
  for (const q of [
    "g.V().hasLabel('person').where(__.out().mergeE([(T.label):'q']))",
    "g.V().hasLabel('person').not(__.out().mergeE([(T.label):'q']))",
    "g.V().hasLabel('person').and(__.out().mergeE([(T.label):'q']), __.out())",
    "g.V().hasLabel('person').where(__.out().mergeE([(T.label):'q']).count())",
    "g.V().hasLabel('person').choose(__.out().mergeE([(T.label):'q']), __.constant(1), __.constant(2))",
  ]) test(q, () => declines(q));
});

describe('variant arms that the row tag cannot tell apart decline', () => {
  // Two LIST arms with different members share one `vk`: the framer crashed (TypeError) or framed vertex
  // rowids as the strings "2","3"; a reducing arm beside a list arm threw the internal channel mismatch.
  for (const q of [
    'g.V().union(__.out().fold(), __.labels().fold())',
    'g.V().union(__.labels().fold(), __.out().fold())',
    'g.V().union(__.out().fold(), __.outE().fold())',
    'g.V().choose(__.hasLabel("person"), __.fold(), __.labels().fold())',
  ]) test(q, () => declines(q));

  test('one list arm beside a scalar arm still answers, arm-major', async () => {
    const [list, ...rest] = await answer('g.V().union(__.out().fold(), __.constant(1))');
    expect((list as unknown[]).length).toBe(6);
    expect(rest).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe('a terminal method other than toList() declines (unansweredTerminalMethod)', () => {
  // The step walk never saw it: `next()` answered the whole stream.
  for (const q of [
    "g.V().values('name').next()", "g.V().values('name').next(2)", "g.V().values('name').tryNext()",
    "g.V().values('name').hasNext()", "g.V().values('name').toSet()", "g.V().values('name').toBulkSet()",
    "g.V().values('name').iterate()", "g.V().values('name').explain()",
  ]) test(q, () => declines(q));

  test('toList() is the stream', async () => {
    expect(await answer("g.V().values('name').toList()")).toHaveLength(6);
  });
});

describe('a scope value\'s by() runs on a NEW traverser at every scope reader (freshTraverserRow)', () => {
  // TraversalUtil.produce(S start, …) generates the traverser: no labels, the initial sack.
  for (const q of [
    'g.V().as("a").select("a").by(__.select("a"))',
    'g.V().as("a").select("a","a").by(__.select("a"))',
    'g.V().as("a").out().as("b").select("a","b").by(__.select("a"))',
    'g.V().as("a").math("a + 1").by(__.select("a").values("age"))',
    'g.withSack(1).V().has("age").as("a").sack(Operator.sum).by("age").select("a").by(__.sack())',
    'g.withSack(1).V().has("age").as("a").sack(Operator.sum).by("age").math("a + 0").by(__.sack())',
    'g.withSack(1).V().has("age").as("a").sack(Operator.sum).by("age").out().as("b").dedup("a").by(__.sack())',
  ]) test(q, () => declines(q));
});
