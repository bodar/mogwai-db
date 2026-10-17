Feature: mogwai addendum — a per-traverser body's global order() sorts ONE start's results

  # `FlatMapStep`/`LocalStep` take one start, emit every result of its body, then take the next
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FlatMapStep.java:42-52,
  # .../step/branch/LocalStep.java:80-88), so the host's output is START-major and the body's `order()`
  # orders within one start. The body's sort was minted over every start at once, interleaving them —
  # `flatMap(out().values('name').order()).fold()` answered the six names globally sorted.
  # `originMajor` (src/compiler/rel/lower/reduction.ts) re-ranks the rejoin by (start, body order).

  Scenario: g_V_flatMapXout_valuesXnameX_orderX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out().values("name").order()).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[josh,lop,vadas,lop,ripple,lop] |

  Scenario: g_V_flatMapXout_valuesXnameX_order_byXdescXX_limitX4X
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out().values("name").order().by(Order.desc)).limit(4)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | vadas |
      | lop |
      | josh |
      | ripple |
