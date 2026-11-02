Feature: mogwai addendum — a write over a shared input, read on after

  # A write program splices the bindings of SEPARATELY named plans — the input rows' plan and the
  # read that continues after the write. `name` (`src/rel/passes/name.ts`) used to number each plan's
  # CTEs from its own private `r0`, so any input with a shared subexpression (`both()` is the union of
  # `out()` and `in()` over one start) collided with the continuation's first CTE and the user got a
  # bare internal `duplicate Plan binding 'r0'`. Binding names now come from the compile's one minter.
  #
  # Each scenario asserts the ANSWER, not only that it runs: `both()` over modern is 12 traversers, so
  # 12 elements are written, one per traverser.

  @gap:write-program-binding-names
  Scenario: g_V_both_addVXxX_label_groupCount
    Given the modern graph
    And the traversal of
      """
      g.V().both().addV("x").label().groupCount()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[12].l"}] |

  # The label is a per-traverser traversal over the SHARED input: one vertex per neighbour occurrence.
  @gap:write-program-binding-names
  Scenario: g_V_both_addVXvaluesXnameXX_groupCount_byXlabelX
    Given the modern graph
    And the traversal of
      """
      g.V().both().addV(__.values("name")).groupCount().by(T.label)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"marko":"d[3].l","josh":"d[3].l","lop":"d[3].l","vadas":"d[1].l","peter":"d[1].l","ripple":"d[1].l"}] |

  @gap:write-program-binding-names
  Scenario: g_V_both_addVXxX_label_dedup
    Given the modern graph
    And the traversal of
      """
      g.V().both().addV("x").label().dedup()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | x |

  # A new vertex has no `k`, so the continuation is empty — and still not an internal error.
  @gap:write-program-binding-names
  Scenario: g_V_both_addVXxX_valuesXkX_dedup
    Given the modern graph
    And the traversal of
      """
      g.V().both().addV("x").values("k").dedup()
      """
    When iterated to list
    Then the result should be empty

  # An element-preserving write over the same shared input: the traversers are the 12 neighbours.
  @gap:write-program-binding-names
  Scenario: g_V_both_propertyXk_1X_label_groupCount
    Given the modern graph
    And the traversal of
      """
      g.V().both().property("k", 1).label().groupCount()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[8].l","software":"d[4].l"}] |

  @gap:write-program-binding-names
  Scenario: g_V_unionXout_inX_addVXxX_label_groupCount
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.out(), __.in()).addV("x").label().groupCount()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[12].l"}] |

  # A label carried across the write, read from the shared input after it.
  @gap:write-program-binding-names
  Scenario: g_V_both_asXaX_addVXxX_propertyXn_selectXaX_valuesXnameXX_valuesXnX_groupCount
    Given the modern graph
    And the traversal of
      """
      g.V().both().as("a").addV("x").property("n", __.select("a").values("name")).values("n").groupCount()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"marko":"d[3].l","josh":"d[3].l","lop":"d[3].l","vadas":"d[1].l","peter":"d[1].l","ripple":"d[1].l"}] |

  # A bounded repeat over the shared input: 30 two-step walks, 30 vertices written.
  @gap:write-program-binding-names
  Scenario: g_V_repeatXbothX_timesX2X_addVXzX_count
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.both()).times(2).addV("z").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[30].l |
