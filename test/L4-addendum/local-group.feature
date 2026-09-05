Feature: mogwai addendum — group()/groupCount() in local() is scoped PER ORIGIN, and SEEDS empty {}

  # `local(__.out().group().by(k))` groups the ENTERING traverser's sub-stream, one MAP per entering
  # vertex — LocalStep drains one start and reset()s the barrier
  # (vendor/tinkerpop/gremlin-core/.../branch/LocalStep.java:59-97). A GLOBAL group would pool every
  # vertex's out-neighbours into one map and answer it for each.
  #
  # `groupMap`'s per-origin path (map.ts) CONSULTS `origin` as an extra GROUP BY key at BOTH stages
  # (`GROUP BY [origin, key]`, then the fold-to-map `GROUP BY [origin]`) — `origin` is 'undefined' group
  # policy, so it rides as a plain column, never a passenger, re-declared as the channel on the output.
  # And `group()` is SEEDED: an empty sub-stream is the empty map {} (GroupStep's supplier), which a bare
  # GROUP BY drops — so the map LEFT JOINs the origin DOMAIN (ChainCtx.originDomain) and COALESCEs the
  # misses to {}. Fan-out rejoin authority plan (docs/2026-09-05-fan-out-rejoin-authority-plan.md §7 C3, family 2).

  # ---- groupCount by lang per vertex: only software neighbours have lang; edgeless vertices SEED {} ----

  Scenario: g_V_localXout_groupCount_byXlangXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().groupCount().by("lang"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"java":"d[1].l"}] |
      | m[{"java":"d[2].l"}] |
      | m[{"java":"d[1].l"}] |
      | m[{}] |
      | m[{}] |
      | m[{}] |

  # ---- the sharpest distinguisher: groupCount by name per PERSON — one map each, empty for vadas ----

  Scenario: g_V_hasLabelXpersonX_localXout_groupCount_byXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").local(__.out().groupCount().by("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"josh":"d[1].l","lop":"d[1].l","vadas":"d[1].l"}] |
      | m[{"lop":"d[1].l","ripple":"d[1].l"}] |
      | m[{"lop":"d[1].l"}] |
      | m[{}] |

  # ---- the COLLECTING form: group().by(lang).by(name) per vertex, list-valued, empties SEED {} ----

  Scenario: g_V_localXout_groupXbyXlangX_byXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().group().by("lang").by("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"java":["lop"]}] |
      | m[{"java":["lop","ripple"]}] |
      | m[{"java":["lop"]}] |
      | m[{}] |
      | m[{}] |
      | m[{}] |
