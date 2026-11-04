Feature: mogwai addendum — V(<traversal>) unpacks a collection-valued id result per row

  # `GraphStep.resolveTraversalIds` unpacks a Collection result one level, whatever produced it
  # (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java:229-247`).
  # A list-valued stored property read by `values(k)` is ONE per-row-typed stream whose rows may be a List
  # on one row and a String on the next, so the unpack is decided per row (`collectionMembersOrSelf`,
  # src/compiler/rel/list.ts): a List/Set row contributes its members, any other row is itself an id, an
  # empty collection contributes nothing. Each member routes by its own type, as any id does: a String
  # names a uid, a Number the rowid of a vertex without one. The graph gives "b" rowid 1, the vertex
  # holding the list rowid 2 and the "r" vertex rowid 3.

  Background:
    Given the empty graph
    And the graph initializer of
      """
      g.addV("q").property(T.id, "b").addV("p").property("refs", ["b", 3]).property("one", "b").addV("r").property("refs", [])
      """

  @gap:traversal-ids
  Scenario: g_V_hasLabelXpX_VXvaluesXrefsXX_label
    And the traversal of
      """
      g.V().hasLabel("p").V(__.values("refs")).label()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | q |
      | r |

  @gap:traversal-ids
  Scenario: g_V_hasLabelXpX_valuesXrefsX_VXidentityX_label
    And the traversal of
      """
      g.V().hasLabel("p").values("refs").V(__.identity()).label()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | q |
      | r |

  @gap:traversal-ids
  Scenario: g_V_hasLabelXpX_VXpropertiesXrefsX_valueX_label
    And the traversal of
      """
      g.V().hasLabel("p").V(__.properties("refs").value()).label()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | q |
      | r |

  # The members keep the collection's own order, so a fold after the lookup reads them in it.
  @gap:traversal-ids
  Scenario: g_V_hasLabelXpX_localXVXvaluesXrefsXX_label_foldX
    And the traversal of
      """
      g.V().hasLabel("p").local(__.V(__.values("refs")).label().fold())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[q,r] |

  # Rows of one stream: a List row unpacks, a scalar row is one id, an empty List row gives nothing.
  @gap:traversal-ids
  Scenario: g_V_VXvaluesXrefs_oneXX_label_mixed_rows
    And the traversal of
      """
      g.V().V(__.values("refs", "one")).label()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | q |
      | r |
      | q |

  @gap:traversal-ids
  Scenario: g_V_hasLabelXrX_VXvaluesXrefsXX_empty_list
    And the traversal of
      """
      g.V().hasLabel("r").V(__.values("refs"))
      """
    When iterated to list
    Then the result should be empty
