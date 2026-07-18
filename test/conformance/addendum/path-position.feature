Feature: mogwai addendum — path() position scoping and per-position children

  # Valid path() traversals the official corpus doesn't consistently cover: from()/to()
  # label scoping, per-position by(T.token), and per-position by(__.traversal) children
  # lowered through the generic scalar child seam (the same seam select/dedup/order use).
  # @gap:path-position marks the family for a possible gremlin-test PR.

  @gap:path-position
  Scenario: g_V_asXaX_out_asXbX_out_asXcX_path_fromXbX_toXcX_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().as("b").out().as("c").path().from("b").to("c").by("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[josh,ripple] |
      | p[josh,lop] |

  @gap:path-position
  Scenario: g_V_out_path_byXTlabelX
    Given the modern graph
    And the traversal of
      """
      g.V().out().path().by(T.label)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[person,person] |
      | p[person,person] |
      | p[person,software] |
      | p[person,software] |
      | p[person,software] |
      | p[person,software] |

  @gap:path-position
  Scenario: g_V_out_path_byXvaluesXnameX_toUpperX
    Given the modern graph
    And the traversal of
      """
      g.V().out().path().by(__.values("name").toUpper())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[MARKO,VADAS] |
      | p[MARKO,JOSH] |
      | p[MARKO,LOP] |
      | p[JOSH,RIPPLE] |
      | p[JOSH,LOP] |
      | p[PETER,LOP] |

  @gap:path-position
  Scenario: g_V_out_path_byXout_countX
    Given the modern graph
    And the traversal of
      """
      g.V().out().path().by(__.out().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[d[3].i,d[0].i] |
      | p[d[3].i,d[0].i] |
      | p[d[3].i,d[2].i] |
      | p[d[2].i,d[0].i] |
      | p[d[2].i,d[0].i] |
      | p[d[1].i,d[0].i] |

  @gap:path-position
  Scenario: g_V_out_out_path_byXnameX_from_to_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().as("b").out().as("c").path().from("a").to("b").by("name").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
