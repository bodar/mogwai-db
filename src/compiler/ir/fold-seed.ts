import { isOperatorArg, type Arg, type Step } from '../../gremlin/frontend.ts';
import { flatType } from '../../gremlin/types.ts';
import { eachChainDeep, rawBodies } from './walk.ts';
import { ranPerTraverser, type IRStep } from './step.ts';

// ---------- fold-seed: where a MUTABLE `fold(seed, Operator)` seed is ONE object across parents ----------
//
// `fold(seed, foldFunction)` does not copy its seed. `GraphTraversal.fold(E2, BiFunction)` wraps the ONE
// literal the parser built in a `ConstantSupplier`
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/dsl/graph/GraphTraversal.java:1300`),
// whose `get()` hands back that same object every time
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/function/ConstantSupplier.java`).
// The no-argument `fold()` is NOT that: it is `ArrayListSupplier`, a FRESH list per `get()`
// (`.../process/traversal/step/map/FoldStep.java:46-48`).
//
// `ReducingBarrierStep` re-fetches its seed from the supplier after every `reset()`
// (`.../process/traversal/step/util/ReducingBarrierStep.java:88-111`), and a child traversal hosted per
// parent traverser — `local()`/`map()`/`flatMap()`, a `by()`, a `where()`/`filter()`/`not()` body, a
// `choose()`/`coalesce()` arm, a `repeat()` body — is reset between parents. So every parent
// folds into the SAME seed object, and `Operator.addAll` MUTATES it in place (`Collection.addAll` /
// `Map.putAll`, `.../process/traversal/Operator.java:187-194`): the reference's per-parent results all
// alias one accumulating collection. `g.V().hasLabel('person').local(__.out().values('name').fold([],
// Operator.addAll))` is ONE list of six names returned four times, not four per-vertex lists; a where()
// over its size sees 3, 3, 5, 6.
//
// Every lowering we have builds a FRESH accumulator per group, which is the plain `fold()`'s semantics, not
// this one. So a fold with a mutable seed is answered only where it provably runs ONCE: a step of the
// ROOT traversal's own chain that no per-traverser host was spliced around (`ranPerTraverser`). Anywhere
// else the compile declines — a GLOBAL child that runs once at the root (a root `union()` arm) included,
// because the same arm nested under a per-traverser host does not, and this check does not try to tell
// the two apart (fail closed: a decline, never a different answer). One whole-tree check asked once before lowering — `unlocatableSubPath`'s
// shape — is what covers every host at every depth, rather than a guard per fold site the next host
// forgets. An immutable seed (a number, a string, a boolean) cannot alias observably and is not affected.

/** Is this argument a mutable seed — a list, set or map literal (or a parameter bound to one)? Those are
 *  the only seeds an `Operator` can mutate (`addAll`); a Java number/string/boolean is immutable. */
const mutableSeed = (seed: Arg): boolean => {
  const t = flatType(seed.type);
  if (t === 'list' || t === 'set' || t === 'map') return true;
  const v = seed.value;
  return Array.isArray(v) || v instanceof Map || v instanceof Set
    || (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && !isOperatorArg(v));
};

/** Is `s` a `fold(seed, Operator)` whose seed is mutable? */
export const foldsIntoMutableSeed = (s: Step): boolean =>
  s.name === 'fold' && (s.args?.length ?? 0) >= 2 && mutableSeed(s.args[0]!) && isOperatorArg(s.args[1]!.value);

/**
 * The first `fold(<mutable seed>, Operator)` that may run ONCE PER PARENT TRAVERSER — anything but a
 * step of the root chain itself that no per-traverser host was spliced around — or `null` when every
 * such fold runs once. A non-null answer is a DECLINE (`compiler.ts`): the reference aliases the seed
 * across parents (see the module comment), which no lowering reproduces.
 */
export function perTraverserMutableFold(steps: readonly Step[], params: Record<string, any>): Step | null {
  let found: Step | null = null;
  eachChainDeep(steps, rawBodies(params), (chain) => {
    if (found) return;
    const nested = chain !== steps;
    found = chain.find((s) => foldsIntoMutableSeed(s) && (nested || ranPerTraverser(s as IRStep))) ?? null;
  });
  return found;
}
