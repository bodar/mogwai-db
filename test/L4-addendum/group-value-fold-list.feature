Feature: mogwai addendum — a group VALUE of `by(<pre>.fold())` is a LIST per partition

  # `by(<pre>.fold())` makes the group's value the pre-fold body FOLDED over the whole partition — a
  # list, not the single last value a barrier-less child produces. The connector's per-key pool
  # (`poolMembers`/`pooledGroup`, src/compiler/rel/lower/scoped.ts) lowers the body once over one key's
  # members, exactly as it does for `by(<pre>.count())`, then COLLECTS rather than reduces. Two things
  # the reference pins that a scalar reducer does not exercise, and both are here:
  #
  #  - A `fold()` is a reducing barrier that SEEDS `[]` and emits over an empty pool, so a partition
  #    whose members contribute nothing keeps its key with `l[]` — NOT a dropped key. The pool is
  #    decorrelated against the domain of distinct keys, so a seeded barrier keeps its seed for a key
  #    whose pool reduced to nothing (`[]`, not `[null]` and not a missing key).
  #  - The members are ELEMENTS, framed through the same `producedMemberNode` a value `by()` uses, so a
  #    folded vertex list rides as `{t:'vertex', v:{…}}` nodes the typed tree reads at any depth.
  #
  # `sideEffect/Group.feature`'s `g_V_hasXperson_name_withinXvadas_peterXX_group_by_byXout_foldX` is
  # the vendored twin; this pins the seed-and-element behaviour in isolation.

  @gap:group-value-fold-list
  Scenario: g_V_withinXvadas_peterX_group_by_byXout_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().has("person","name",P.within("vadas","peter")).group().by().by(__.out().fold())
      """
    # vadas has no out() — its pool is empty, so the FoldStep seed keeps the key with l[]. peter -> lop.
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[vadas]":[], "v[peter]":["v[lop]"]}] |

  @gap:group-value-fold-list
  Scenario: g_V_group_byXlabelX_byXvaluesXnameX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.values("name").fold())
      """
    # A scalar-valued fold: each partition's names collected into a list, member order the encounter.
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":["marko","vadas","josh","peter"],"software":["lop","ripple"]}] |

  # A COLLECTING value over an ELEMENT-IDENTITY key (`by()`), which the pooled arm — count as well as
  # fold — did not reach until the key was taken from the child rows' origin: each vertex is its own
  # partition, keyed by itself, valued by the fold/count of its out().
  @gap:group-value-fold-list
  Scenario: g_V_group_by_byXout_countX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by().by(__.out().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[marko]":3, "v[vadas]":0, "v[lop]":0, "v[josh]":2, "v[ripple]":0, "v[peter]":1}] |
