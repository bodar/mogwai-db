Feature: mogwai addendum — a predicate operand resolves through the traverser's SCOPE

  # `P.gt(<traversal>)` resolves its operand against the CURRENT traverser and takes its FIRST result
  # (`P.resolve` → `tv.next()`, vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/
  # gremlin/process/traversal/P.java:328-373). Until now the operand seam (`nestedFirstValue`) could
  # reach a ROOTED operand (`__.V(x)…`) and a CORRELATED value (`__.values(k)`), but not a read of the
  # traverser's SCOPE — a live alias or the sack — because the child host it built carried no `row`.
  # Threading the alias/sack scope onto that host (the operand-seam twin of a by()/map() body's
  # `selectRerootHost`) makes both resolve.
  @gap:predicate-operand-scope

  # A select('a') OPERAND reads the aliased START's value for the current traverser: keep each
  # neighbour OLDER than the vertex it was reached from. Only marko(29)->josh(32) qualifies — vadas is
  # younger, and the software neighbours carry no age. Pre-fix the whole traversal declined.
  Scenario: g_V_hasLabelXpersonX_asXaX_out_hasXage_gtXselectXaX_valuesXageXXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").as("a").out().has("age", P.gt(__.select("a").values("age")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[josh] |

  # A sack() OPERAND compares the traverser's property against the (constant) sack value — identical to
  # the literal P.gt(29) it was seeded with, so josh(32) and peter(35) survive.
  Scenario: g_withSackX29X_V_hasXage_gtXsackXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.withSack(29).V().has("age", P.gt(__.sack())).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |
      | peter |

  # A ROOTED operand ending in order() takes the ORDERED first (`P.resolve` → `tv.next()` over the
  # sorted stream). marko knows {vadas, josh}; order()ed by name that is [josh, vadas], so the first is
  # "josh" and has("name", "josh") keeps josh. The pick MUST honour the operand's order() — a scalar
  # subquery that projected only `v` let `prune` drop the encounter channel, taking a scan-order value
  # (an arbitrary neighbour), which read as a non-deterministic result. `nestedFirstValue` now ORDER BYs
  # the encounter and LIMIT 1s, so the pick is deterministic and order-faithful.
  Scenario: g_V_hasXname_VX1X_outXknowsX_valuesXnameX_orderX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", __.V(1).out("knows").values("name").order())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[josh] |
