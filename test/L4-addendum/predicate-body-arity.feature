Feature: mogwai addendum — 3-arg has(LABEL,k,v) inside a predicate body, and the non-productive by() drop

  # Two defects that CANCELLED each other, which is why neither showed up in L3 for so long.
  #
  # (1) The inline predicate leaf destructured `const [key, val] = body[0].args` regardless of arity,
  #     so a 3-arg has(LABEL, key, value) inside filter()/where()/not()/and()/or() was lowered as
  #     has(key=LABEL, value=key) — "the property named 'software' equals 'name'", never true. The arm
  #     became constant FALSE, and constant TRUE under not(). The top-level has() has always peeled the
  #     label prefix; only the inline leaf did not.
  #
  # (2) order().by(KEY) kept traversers lacking KEY. TinkerPop's default by() is NON-productive: those
  #     traversers are DROPPED (ProductiveByStrategy is the opt-in that keeps them, nulls first).
  #
  # On `g.V().or(hasLabel("person"),has("software","name","lop")).order().by("age")` the two exactly
  # cancelled — (1) dropped the software vertex at the or() for the wrong reason, which is where (2)
  # should have dropped it at the order() — so L3 recorded that scenario as PASSING while its
  # @WithProductiveByStrategy twin failed. Found by L5's fast-path differential, which saw (1) as a
  # disagreement between the inlined and generic predicate paths; (2) was invisible to the differential
  # (both configs agreed) and turned up only when the L3 delta contradicted the diagnosis.
  #
  # These scenarios pin each defect INDEPENDENTLY, so a future regression in one cannot be masked by
  # the other again.
  @gap:predicate-body-arity

  Scenario: g_V_filterXhasXsoftware_name_lopXX
    Given the modern graph
    And the traversal of
      """
      g.V().filter(__.has("software","name","lop")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |

  Scenario: g_V_whereXhasXsoftware_name_lopXX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.has("software","name","lop")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |

  # The not() form is the sharp one: an always-false arm becomes always-TRUE under negation, so this
  # scenario would have returned all six vertices.
  Scenario: g_V_notXhasXsoftware_name_lopXX
    Given the modern graph
    And the traversal of
      """
      g.V().not(__.has("software","name","lop")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | josh |
      | peter |
      | ripple |

  Scenario: g_V_andXhasXsoftware_name_lopX_hasLabelXsoftwareXX
    Given the modern graph
    And the traversal of
      """
      g.V().and(__.has("software","name","lop"),__.hasLabel("software")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |

  # A 3-arg has() whose LABEL does not match must still filter on the label, not ignore it.
  Scenario: g_V_filterXhasXperson_name_lopXX
    Given the modern graph
    And the traversal of
      """
      g.V().filter(__.has("person","name","lop")).values("name")
      """
    When iterated to list
    Then the result should be empty

  # (2) in isolation: lop and ripple have no age, so a non-productive by("age") drops both.
  Scenario: g_V_order_byXageX_values_name
    Given the modern graph
    And the traversal of
      """
      g.V().order().by("age").values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | vadas |
      | marko |
      | josh |
      | peter |

  # The drop applies per comparator on a MULTI-term order: a traverser missing any key has nothing to
  # compare on. Every vertex has a name; only the software ones have lang, so lang gates the result.
  Scenario: g_V_order_byXlangX_byXnameX_values_name
    Given the modern graph
    And the traversal of
      """
      g.V().order().by("lang").by("name").values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |
      | ripple |

  # NOTE: a nested `local(__.order().by(k))` is NOT covered here — that composition is unsupported
  # and fails closed ("local() child shape not yet supported by generic child lowering"), so there is
  # nothing to assert. The child-body drop IS wired (tail/child.ts, sharing the same policy) for the
  # child orders that DO lower — the per-parent ordering inside a where()/existence child.
