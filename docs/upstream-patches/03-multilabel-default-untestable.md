# Upstream: no provider can declare a multi-label DEFAULT, so `@MultiLabelDefault` is untestable

**Target:** `apache/tinkerpop` (`master`). **Status:** written up, not yet raised.
**Kind:** a `gremlin-core` API gap + its three GLV harness consequences — an ISSUE first, not a PR.
**Ours:** `docs/outstanding-work.md` item 19b.

## The observation

`gremlin-test` ships 10 scenarios tagged `@MultiLabelDefault` (in `map/ElementMap.feature` and
`map/ValueMap.feature`). **Every GLV skips all of them:**

| GLV | mechanism |
|---|---|
| gremlin-js | `Before({tags: "@MultiLabelDefault"}, () => 'skipped')` — `test/cucumber/world.js` |
| gremlin-go | `~@MultiLabelDefault` in the godog tag filter — `driver/cucumber/cucumberSteps_test.go` |
| gremlin-python | `context.ignore = "MultiLabelDefault" in tagset` — `tests/feature/feature_steps.py` |

gremlin-go states the reason outright:

> `// The GLV suite does not test against a graph that defaults to multi-label output, skipping via Pending Error`

Their `@SingleLabelDefault` twins — the same initializers and the same traversals, differing only in
the expected `T.label` shape — are NOT skipped.

## Why it cannot be fixed in the harnesses alone

Because there is no such graph to point at, and no way to configure one.
`TraversalHelper.isMultilabelEnabled` is the sole decision:

```java
public static boolean isMultilabelEnabled(final Traversal.Admin<?, ?> traversal) {
    return traversal.getStrategies().getStrategy(OptionsStrategy.class)
            .map(os -> os.getOptions().containsKey(WithOptions.MULTILABEL_KEY))
            .orElse(false);
}
```

`.orElse(false)` — the default is **always single-label**, for every graph, regardless of its
declared `LabelCardinality`. So `gremlin-server/conf/tinkergraph-multilabel.properties` setting
`gremlin.tinkergraph.vertexLabelCardinality=ZERO_OR_MORE` gets a graph that STORES multiple labels
and still RENDERS one by default. `@MultiLabelDefault` describes a provider the reference
implementation cannot be configured into being.

This looks like unfinished work rather than a decision: multi-label landed in `bc2d939562`
(TINKERPOP-3261) with the scenarios, the tag, and all three skips already in it.

## Suggested shape (for discussion, not a patch)

Give the default a provider-declared source, then point the scenarios at a graph that declares it:

1. **`gremlin-core`** — let the graph supply the fallback, e.g.
   `.orElse(graphDefaultsToMultiLabel(traversal))`, read from `Graph.Features.VertexFeatures`
   beside `getLabelCardinality()`. The explicit `with("multilabel")`/`with("singlelabel")` options
   keep priority and stay mutually exclusive.
2. **`tinkergraph-gremlin`** — a property (`gremlin.tinkergraph.defaultLabelOutput=MULTI|SINGLE`),
   defaulting to SINGLE so nothing changes for existing graphs.
3. **`gremlin-server`** — a test-server traversal source declaring it.
4. **The three GLVs** — drop the skips and route `@MultiLabelDefault` at that source.

Worth confirming with the committers whether the intended design is instead that the default should
simply FOLLOW `LabelCardinality` — that would be a smaller change (steps 1 and 3–4 only) and is what
the scenario names imply.

## Why we care, and what we can offer

mogwai-db already implements the multi-label default: our `labelRegime` (`src/api.ts`) falls back to
the graph's declared cardinality when neither option is set, so we answer all 10 scenarios today —
verified by probe (`T.label` frames as `s[person,employee]`) — and cannot be asked. We are, as far as
we know, the provider those scenarios were written for, so we can validate any shape upstream picks
against a real implementation.

Precedent: `apache/tinkerpop#3511` (the `gremlin/io` package export) came from this project and was
merged.

**One caveat to raise honestly in the issue:** our fallback is a deliberate divergence from the
reference today. If upstream decides the default should stay single-label unconditionally, then
`@SingleLabelDefault` is the correct declaration and the 10 scenarios should be deleted rather than
made runnable — that is a fine outcome too, and either way the current state (10 scenarios no
implementation can execute) is the one thing that should not persist.
