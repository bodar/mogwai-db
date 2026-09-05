Feature: mogwai addendum — keyed dedup(label) is shape-agnostic, and a LIST label keys on its content

  # dedup(a) reads label a's Pop.last scope value and compares it with java.util.List content-equality
  # (`vendor/tinkerpop/gremlin-core/.../step/filter/DedupGlobalStep.java:75-88`) — DedupGlobalStep<S>
  # is generic in the stream shape S. The keyed dispatch used to run only on the element and record
  # tails, so a keyed dedup over a bound LIST or scalar declined though dedupByLabels was built; it is
  # now the one shared keyedDedup dispatch every tail wires. A LIST label keys on its canonical json()
  # (two identical arrays share one minified text); a MAP label stays declined (object json() text is
  # key-order sensitive, a Java LinkedHashMap is not).

  # ---- a LIST-valued label: two equal arrays collapse, a third stays ----

  @gap:list-alias-dedup
  Scenario: inject_int_list_alias_dedup_count
    Given the empty graph
    And the traversal of
      """
      g.inject([1,2],[1,2],[3]).as("a").dedup("a").count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[2].l |

  @gap:list-alias-dedup
  Scenario: inject_string_list_alias_dedup_count
    Given the empty graph
    And the traversal of
      """
      g.inject(["x","y"],["x","y"],["z"]).as("a").dedup("a").count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[2].l |

  # ---- the same dispatch now reaches a SCALAR-valued label too (was equally unreachable) ----

  @gap:list-alias-dedup
  Scenario: values_scalar_alias_dedup_count
    Given the modern graph
    And the traversal of
      """
      g.V().values("lang").as("a").dedup("a").count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[1].l |
