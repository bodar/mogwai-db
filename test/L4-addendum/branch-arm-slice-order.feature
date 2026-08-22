Feature: mogwai addendum — a drop-slice inside a branch-merge arm is deterministic

  # A slice that DROPS rows (limit/range/tail) inside a branch-merge arm (union/choose/coalesce/optional)
  # keeps the FIRST N traversers in the arm's stream, which is the INCOMING stream's emission order. That
  # order has to be PINNED, or which traverser survives is decided by whatever scan order the physical
  # plan happens to produce — and a fast path changes that order (propertySeek lifts a has()'s correlated
  # EXISTS into a JOIN, `src/compiler/rel/passes/semijoin.ts`), so the DEFAULT config and the generic
  # path answered different MULTISETS. L5 surfaced it (`test/L5-properties/known.ts`, commit ecc392f);
  # `computeDemandsEncounter` (`src/compiler/ir/analyze.ts`, BRANCH_MERGE_STEPS) now seeds the
  # emission-order encounter whenever a drop-slice appears inside a branch-merge arm — the flat scan
  # could not see the nested slice — so the stream feeding the branch is ordered and the arm's slice is
  # deterministic regardless of the scan order. An upstream order() already satisfied it.
  #
  # Modern graph (id order): marko(29), vadas(27), lop(software), josh(32), ripple(software), peter(35).
  # Asserted `unordered`: the DEFECT was a MULTISET change (a different survivor kept), which is exactly
  # what an unordered assertion catches. @gap:branch-arm-slice-order marks the family.

  @gap:branch-arm-slice-order
  Scenario: g_V_hasXage_lteX29XX_unionXhasXnameX_limitX1X__identityX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("age", P.lte(29)).union(__.has("name").limit(1), __.identity()).values("name")
      """
    # age<=29 = [marko, vadas] (id order); arm1 has(name).limit(1) keeps the FIRST = marko; arm2
    # identity keeps both. So marko x2, vadas x1 — and marko, not vadas, is the kept survivor.
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | marko |
      | vadas |

  @gap:branch-arm-slice-order
  Scenario: g_V_hasXage_lteX29XX_unionXlimitX1X__identityX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("age", P.lte(29)).union(__.limit(1), __.identity()).values("name")
      """
    # A bare limit(1) in the arm, no in-arm filter to hide behind: still deterministic — the first of
    # [marko, vadas] is marko.
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | marko |
      | vadas |

  @gap:branch-arm-slice-order
  Scenario: g_V_unionXhasXlangX_limitX1X__identityX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.has("lang").limit(1), __.identity()).values("name")
      """
    # No outer has(), so nothing reorders the source under propertySeek — but the arm slice is still
    # pinned to the source order: has(lang) = [lop, ripple] (id order), limit(1) keeps lop; identity
    # keeps all six. So lop x2 and every other name once.
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | lop |
      | lop |
      | josh |
      | ripple |
      | peter |

  @gap:branch-arm-slice-order
  Scenario: g_V_hasXage_lteX29XX_orderXX_unionXhasXnameX_limitX1X__identityX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("age", P.lte(29)).order().union(__.has("name").limit(1), __.identity()).values("name")
      """
    # An explicit order() before the branch already pins the incoming order, so the arm slice is
    # deterministic without the new seed — the same answer, from the other route.
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | marko |
      | vadas |
