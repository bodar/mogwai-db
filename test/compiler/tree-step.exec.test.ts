// `tree()` — the reducing barrier that folds every traverser's path into one prefix tree
// (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TreeStep.java).
// The official Tree.feature (L3) pins the plain and by() forms through the real client; these pin the
// edges it does not name — the empty seed, a skipped unproductive position, the untyped (JSON) form, and
// the forms that still decline. Values are canonical strings read from the GraphBinary bytes (`canon`).
import { test, expect, describe } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { exec } from '../support/executor.ts';
import { canon } from '../L6-workload/canon.ts';
import { UnsupportedTraversal } from '../../src/compiler/unsupported.ts';

const store = seededStore();
const trees = (g: string): string[] => exec(store).framed(g, {}).map((f) => canon(f.buf, {}));

describe('tree()', () => {
  test('over no traversers it is the empty Tree, not no result', () =>
    expect(trees("g.V().has('name','nobody').out().tree()")).toEqual(['tree{}']));
  test('an unproductive by() position is skipped, not dropped: lop/ripple have no age', () =>
    expect(trees("g.V().has('name','josh').out().tree().by('age')")).toEqual(['tree{32i:tree{}}']));
  test('paths through one prefix share it', () =>
    expect(trees("g.V().has('name','marko').out().out().tree().by('name')"))
      .toEqual(['tree{"marko":tree{"josh":tree{"lop":tree{},"ripple":tree{}}}}']));
  test('element keys are one child per element', () =>
    expect(trees("g.V().has('name','marko').out().out().tree()")).toEqual(['tree{v[1]:tree{v[4]:tree{v[3]:tree{},v[5]:tree{}}}}']));
  test('the by() ring cycles over positions', () =>
    expect(trees("g.V().has('name','marko').outE('knows').inV().tree().by('name').by(T.label)"))
      .toEqual(['tree{"marko":tree{"knows":tree{"josh":tree{},"vadas":tree{}}}}']));
  test('the untyped (JSON) form is a list of {key, value} entries', async () => {
    const [tree] = JSON.parse(await exec(store).jsonAsync("g.V().has('name','marko').out('knows').tree().by('name')", {}));
    expect(tree).toHaveLength(1);
    expect(tree[0].key).toBe('marko');
    expect(tree[0].value.map((b: { key: string }) => b.key).sort()).toEqual(['josh', 'vadas']);
  });
  // A `map(identity())` opens a path position (`MapStep` extends the path), and `tree()` reads the path
  // exactly as `path()` does — so the identity-host splice must keep it when ONLY `tree()` reads the
  // path (`PATH_READERS`, src/compiler/ir/step.ts), at chain position and under an arm alike.
  describe('a map(identity()) position is a level of the tree, as it is a position of the path', () => {
    test('chain position, elements', () =>
      expect(trees("g.V(1).map(identity()).out('created').tree()")).toEqual(['tree{v[1]:tree{v[1]:tree{v[3]:tree{}}}}']));
    test('chain position, by()', () =>
      expect(trees("g.V(1).map(identity()).out('created').tree().by('name')")).toEqual(['tree{"marko":tree{"marko":tree{"lop":tree{}}}}']));
    test('the path agrees', () =>
      expect(exec(store).framed("g.V(1).map(identity()).out('created').path().by('name')", {}).map((f) => canon(f.buf, {})))
        .toEqual(['path["marko","marko","lop"]']));
    for (const q of [
      "g.V(1).union(map(identity()).out('created')).tree().by('name')",
      "g.V(1).optional(map(identity()).out('created')).tree().by('name')",
      "g.V(1).union(union(map(identity()).out('created'))).tree().by('name')",
      "g.V(1).choose(constant(true), map(identity()).out('created')).tree().by('name')",
      "g.V(1).flatMap(identity()).out('created').tree().by('name')",
      "g.V(1).as('a').map(identity()).out('created').tree().by('name')",
    ]) test(`under an arm or host: ${q}`, () => expect(trees(q)).toEqual(['tree{"marko":tree{"marko":tree{"lop":tree{}}}}']));
  });
  test('a step after tree() and the side-effect form still decline', () => {
    expect(() => trees("g.V().out().tree().count(local)")).toThrow(UnsupportedTraversal);
    expect(() => trees("g.V().out().tree('a').cap('a')")).toThrow(UnsupportedTraversal);
  });
});
