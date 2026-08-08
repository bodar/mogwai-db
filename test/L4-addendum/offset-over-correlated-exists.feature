Feature: mogwai addendum — a skip/range OFFSET survives a correlated-EXISTS filter in front of it

  # SQLite (measured on bun:sqlite 3.51.x AND the Durable Object runtime) SILENTLY DROPS an OFFSET
  # when the offset's own SELECT block has a single-table FROM and a POSITIVE correlated EXISTS in its
  # WHERE:
  #
  #   SELECT id FROM nodes n WHERE EXISTS (SELECT 1 FROM edges e WHERE e.src = n.id) LIMIT -1 OFFSET 1
  #
  # returns EVERY surviving row — a wrong ANSWER, not a reorder. A JOIN in the FROM (any movement)
  # dodges it, so `propertySeek` — which lifts a has()'s EXISTS into a join — masked the defect on the
  # one traversal L5 happened to record, while the whole where(…)/has(…)-then-skip/range family
  # answered wrong under the DEFAULT config. The differential could not see it (the bug is present in
  # BOTH spine positions of those traversals). The fix is generic: a MATERIALIZED-CTE fence between the
  # correlated filter and the offset, decided by `offsetDropsOverExists` in
  # `src/compiler/rel/lower.ts`. NOT EXISTS, an uncorrelated IN (SELECT …) and a scalar (SELECT …) > 0
  # do not trigger the SQLite bug and are left unfenced.
  #
  # Modern graph: has-an-out-edge = {marko, josh, peter} (id order); has-an-in-edge =
  # {vadas, lop, josh, ripple}. The OFFSET is pinned by the emission encounter, so the kept members
  # are deterministic — asserted `unordered` because the DROP is a MULTISET change, which is exactly
  # what an unordered assertion catches. @gap:offset-over-correlated-exists marks the family.

  @gap:offset-over-correlated-exists
  Scenario: g_V_whereXoutEX_skipX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.outE()).skip(1).values("name")
      """
    # {marko, josh, peter} in id order; skip(1) drops marko.
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |
      | peter |

  @gap:offset-over-correlated-exists
  Scenario: g_V_hasXage_gtX0XX_whereXoutEX_skipX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("age", P.gt(0)).where(__.outE()).skip(1).values("name")
      """
    # age>0 gives {marko, vadas, josh, peter}; the child keeps those with an out-edge
    # {marko, josh, peter}; skip(1) drops marko. This is the exact traversal `known.ts` recorded while
    # the defect was still open — here it is the fixed floor. `propertySeek` lifts the age has() into a
    # join, which is why this one answered correctly in production while its where()-only siblings did
    # not; the fence makes both spine positions agree.
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |
      | peter |

  @gap:offset-over-correlated-exists
  Scenario: g_V_whereXinEX_rangeX1_3X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.inE()).range(1, 3).values("name")
      """
    # A range's low bound is an OFFSET, so it hits the same bug. {vadas, lop, josh, ripple} in id
    # order; range(1, 3) keeps the members at positions 1 and 2.
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | josh |

  @gap:offset-over-correlated-exists
  Scenario: g_V_hasXage_gtX0XX_filterXoutEXcreatedXX_skipX2X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("age", P.gt(0)).filter(__.outE("created")).skip(2).values("name")
      """
    # The filter() arity of the same cause: age>0 keeps {marko, josh, peter} after the created-edge
    # child; skip(2) drops the first two.
    When iterated to list
    Then the result should be unordered
      | result |
      | peter |
