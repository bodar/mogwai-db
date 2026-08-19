Feature: mogwai addendum — a coalesce/optional arm may REDUCE per traverser

  # `CoalesceStep extends FlatMapStep` and `OptionalStep extends AbstractStep` take ONE start at a
  # time unconditionally (vendor/tinkerpop/gremlin-core/.../branch/CoalesceStep.java:38), so a
  # reducing barrier in one of their arms genuinely reduces over THAT traverser's sub-stream — a
  # per-origin fold/count, one row per host. So a coalesce arm routes through the SAME child seam a
  # `local()`/`map()`/`by()` body already uses (`reductionArm`), rather than the global reduction a
  # bare `continueAs` would build.
  #
  # ⚠️ This is ONLY correct for coalesce/optional. `UnionStep`/`ChooseStep extends BranchStep`, whose
  # standardAlgorithm injects EVERY start at once when any option holds a Barrier
  # (BranchStep.java:87,143 — both CountGlobalStep and FoldStep extend ReducingBarrierStep), so THEIR
  # reducer arms reduce over the whole input — the batched/arm-major lowering pinned (still
  # @Unsupported) in element-branch-child.feature, NOT this.
  #
  # A SEEDED reducer (count/fold) ALWAYS fires, so it exhausts the coalesce and a later constant is a
  # dead fallback — the correct reading of `coalesce(<count>, <default>)`. @gap:coalesce-reduction-arm
  # marks the family for a possible gremlin-test PR.

  @gap:coalesce-reduction-arm
  Scenario: g_V_coalesceXinXknowsX_valuesXnameX_fold__constantXnoneXX
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.in("knows").values("name").fold(), __.constant("none"))
      """
    # fold() seeds [], so every vertex takes arm 0 and constant("none") is dead. Only vadas and josh
    # are known (by marko), so their fold is [marko]; every other vertex folds to the empty list.
    When iterated to list
    Then the result should be unordered
      | result |
      | l[] |
      | l[marko] |
      | l[] |
      | l[marko] |
      | l[] |
      | l[] |

  @gap:coalesce-reduction-arm
  Scenario: g_V_hasLabelXpersonX_coalesceXoutXknowsX_count__outXcreatedX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").coalesce(__.out("knows").count(), __.out("created").count())
      """
    # count() seeds 0, so arm 0 fires for every person and arm 1 is dead — the answer is each
    # person's out(knows) degree, per traverser (only marko has any).
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[0].l |
      | d[0].l |
      | d[0].l |

  @gap:coalesce-reduction-arm
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_coalesceXoutXknowsX_count__outXcreatedX_countX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("name").coalesce(__.out("knows").count(), __.out("created").count()).limit(2)
      """
    # The reduction arm is ONE row per host that carries the frozen fan-out position (`branchOrder`),
    # so a downstream positional `limit(2)` reads the traverser-major order. order() fixes the input
    # josh, marko, peter, vadas; their out(knows) counts are 0, 2, 0, 0, so the first two are josh's 0
    # and marko's 2 — NOT a global count, and NOT arm-major.
    When iterated to list
    Then the result should be ordered
      | result |
      | d[0].l |
      | d[2].l |

  @gap:coalesce-reduction-arm
  Scenario: g_V_hasLabelXpersonX_coalesceXoutXknowsX_count__constantXneg1XX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").coalesce(__.out("knows").count(), __.constant(-1))
      """
    # A count arm (result:'count', STATIC('long')) merges with a plain scalar: the meet is a per-row
    # tagged scalar (count→long, constant→int) rather than a decline. count() seeds 0 so it always
    # fires — the constant(-1) is a dead fallback and every result is the LONG count. `d[N].l` pins the
    # wire type: were the meet dropping the Long tag the framer would emit `d[N].i`.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[0].l |
      | d[0].l |
      | d[0].l |
