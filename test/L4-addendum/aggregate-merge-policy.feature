Feature: mogwai addendum — a declared merge policy composes with everything a collection already does

  # `withSideEffect(k, seed, Operator.x)` registers a SUPPLIER and a REDUCER against the label
  # (vendor/tinkerpop/gremlin-core/.../util/DefaultTraversalSideEffects.java:96-103), and
  # `sideEffects.add(k, v)` is `set(k, getReducer(k).apply(get(k), v))` (:88-91) — a seeded LEFT FOLD
  # over the members in order. `AggregateStep.processAllStarts` (:131-151) decides what "a member" is
  # for that fold: `addAll` and `assign` receive a site's whole `BulkSet`, everything else receives one
  # member at a time.
  #
  # The official corpus (sideEffect/Aggregate.feature:279-563) covers exactly one composition per
  # operator: `g.V().aggregate("a").by("age").cap("a")` over `gmodern`, global and `local`. What it
  # never asks is whether the policy still holds once anything else about the collection changes —
  # which is the question that matters, because the policy is spent at the READ and everything a
  # collection can be is decided before it gets there. So these pin the compositions:
  #
  #   * MULTI-SITE — N registration positions filling one label. The seed is spent ONCE, not per site.
  #   * a collection NOTHING reached — the answer is the seed, which is `get(k)` over a side effect
  #     nothing added to, and NOT an empty list.
  #   * a `by()` whose body is a nested TRAVERSAL rather than a property key.
  #   * a SCALAR host (`values("name")`) rather than an element host with a `by()`.
  #   * the seed's own items DISAGREEING about their type, which is the meet one level below the
  #     stream's.
  #   * `cap("a")` continuing into a list tail (`unfold()`), which only `addAll` can do.
  #
  # @gap:aggregate-merge-policy marks the family for a possible gremlin-test PR.

  @gap:aggregate-merge-policy
  Scenario: g_withSideEffectXa_0_sumX_V_aggregateXaX_byXageX_aggregateXaX_byXageX_capXaX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", 0, Operator.sum).V().aggregate("a").by("age").aggregate("a").by("age").cap("a")
      """
    # TWO sites over one stream, so the four ages are contributed twice: 0 + 2×(29+27+32+35) = 246.
    # The seed is the LABEL's, not the site's — one `withSideEffect` declaration however many
    # positions read it — so 123 rather than 246 would mean the seed had been spent per site.
    When iterated to list
    Then the result should be unordered
      | result   |
      | d[246].i |

  @gap:aggregate-merge-policy
  Scenario: g_withSideEffectXa_7_minX_V_limitX0X_aggregateXaX_byXageX_capXaX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", 7, Operator.min).V().limit(0).aggregate("a").by("age").cap("a")
      """
    # NOTHING reaches the aggregate, so nothing is ever added and `cap` reads the registered
    # supplier's value straight back. The default policy's answer here is `[]`; a declared one's is
    # the seed, and the difference is the whole point of the supplier being registered rather than
    # the collection starting empty.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |

  @gap:aggregate-merge-policy
  Scenario: g_withSideEffectXa_0_sumX_V_aggregateXaX_byXoutEXcreatedX_countXX_capXaX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", 0, Operator.sum).V().aggregate("a").by(__.outE("created").count()).cap("a")
      """
    # A `by()` whose body is a correlated nested traversal, not a property key. Four `created` edges
    # in `gmodern` (marko→lop, josh→lop, josh→ripple, peter→lop), and every vertex contributes a
    # count — including the three that create nothing, whose `0` a reducing barrier still emits. So
    # the members are 1,0,0,2,0,1 and the fold is 4.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |

  @gap:aggregate-merge-policy
  Scenario: g_withSideEffectXa_zzz_minX_V_valuesXnameX_aggregateXaX_capXaX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", "zzz", Operator.min).V().values("name").aggregate("a").cap("a")
      """
    # `Operator.min` is `NumberHelper.min(Comparable, Comparable)`, not the numeric overload, so it
    # orders STRINGS too — and the host here is a scalar stream with no `by()` at all, where the
    # members are the values themselves. Alphabetically `josh` < `lop` < `marko` < `peter` <
    # `ripple` < `vadas` < `zzz`.
    When iterated to list
    Then the result should be unordered
      | result |
      | josh   |

  @gap:aggregate-merge-policy
  Scenario: g_withSideEffectXa_x_1_addAllX_V_valuesXnameX_aggregateXaX_capXaX_unfold
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", ["x",1i], Operator.addAll).V().values("name").aggregate("a").cap("a").unfold()
      """
    # `addAll` APPENDS, so the seed's items come first and the collection is the seed followed by
    # every member — which makes the seed one more SITE rather than a value to fold. The two items
    # also disagree about their own type, which is the per-value meet one level below the stream's:
    # a String beside an Integer beside six member Strings, each framed as what it is.
    When iterated to list
    Then the result should be unordered
      | result |
      | x      |
      | d[1].i |
      | marko  |
      | vadas  |
      | lop    |
      | josh   |
      | ripple |
      | peter  |

  @gap:aggregate-merge-policy
  Scenario: g_withSideEffectXa_setXmarkoXX_V_both_valuesXnameX_aggregateXaX_capXaX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", {"marko"}).V().both().values("name").aggregate("a").cap("a")
      """
    # A CONSTANT `withSideEffect` on an aggregated label is a merge policy too, with the operator
    # `AggregateStep`'s own constructor registers: `registerIfAbsent` keeps whichever SUPPLIER was
    # registered first and fills in only a MISSING reducer
    # (DefaultTraversalSideEffects.java:110-119), and AggregateStep registers
    # `(BulkSetSupplier, Operator.addAll)` (AggregateStep.java:57). So the seed is `{"marko"}` and the
    # merge is `addAll` — no `Operator` written anywhere in the traversal.
    #
    # The seed being a SET is what revokes the collection's multiset licence: `addAll(a, b)` is
    # `a.addAll(b)`, so every contribution is offered to `Set.add` and a repeat changes nothing.
    # `both()` reaches every name several times over and `marko` is also the seed's own item, so a
    # LIST answer here would have twelve members. The official corpus covers the inline-`{…}` shape at
    # `Aggregate.feature:171-180`; what it does not cover is a set seed at a GLOBAL barrier (its two
    # are both `local(aggregate(…))`), which is this.
    When iterated to list
    Then the result should be unordered
      | result                                     |
      | s[marko,vadas,lop,josh,ripple,peter]       |

  @gap:aggregate-merge-policy
  Scenario: g_withSideEffectXa_emptyList_addAllX_V_aggregateXaX_byXageX_capXaX_unfold
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", [], Operator.addAll).V().aggregate("a").by("age").cap("a").unfold()
      """
    # An EMPTY seed adds nothing, so the answer is the members alone — the absence of a site, not a
    # site of no rows. It is worth pinning because it is the one seed shape a relational lowering
    # cannot spell as rows at all (`VALUES` has no empty form).
    When iterated to list
    Then the result should be unordered
      | result   |
      | d[29].i  |
      | d[27].i  |
      | d[32].i  |
      | d[35].i  |
