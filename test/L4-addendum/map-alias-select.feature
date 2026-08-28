Feature: mogwai addendum — a MAP bound to an as() label, read back with select()

  # G4 (map-support finishing plan): a map traverser (project()/valueMap()/group()/select(k…))
  # bound to an as() label, then read back with select(label). The map's pairs blob is stored in
  # the alias history like a list's, its keyOf/valOf + STATIC KEY SET riding on the alias entry so
  # select(label) re-enters mapTail with the right vocabulary. A nested select(label).select(k)
  # resolves k against the map's compile-time key set — TinkerPop's Scoping precedence is map-first
  # (Scoping.java:119-134: containsKey → side-effect → label), so a key NOT in the static set cannot
  # be a map key and the alias re-entry is unambiguous. @gap:map-alias marks the family.

  @gap:map-alias
  Scenario: g_V_projectXn_aX_asXmX_selectXmX_selectXnX
    Given the modern graph
    And the traversal of
      """
      g.V().has("person","name","marko").project("n","a").by("name").by("age").as("m").select("m").select("n")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |

  @gap:map-alias
  Scenario: g_V_projectXn_aX_asXmX_selectXmX_selectXaX
    Given the modern graph
    And the traversal of
      """
      g.V().has("person","name","marko").project("n","a").by("name").by("age").as("m").select("m").select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |

  # A bare terminal select(m) materializes the whole map — the record round-trips through the alias.
  @gap:map-alias
  Scenario: g_V_projectXn_aX_asXmX_selectXmX
    Given the modern graph
    And the traversal of
      """
      g.V().has("person","name","marko").project("n","a").by("name").by("age").as("m").select("m")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"n":"marko","a":"d[29].i"}] |

  # valueMap(k…) binds too — its explicit key set is known, so select(m).select(name) resolves.
  @gap:map-alias
  Scenario: g_V_hasLabelXsoftwareX_valueMapXnameX_asXmX_selectXmX_selectXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").valueMap("name").as("m").select("m").select("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[lop] |
      | l[ripple] |

  # PRECEDENCE / fail-closed: when the alias name IS also a possible map key (project("n").as("n")),
  # TinkerPop returns the MAP value (containsKey wins). We cannot express the heterogeneous union, so
  # we DECLINE rather than answer the alias — a fail-closed gap, never a wrong answer. And valueMap()
  # all-keys has an unknown key set, so a live-alias select over it declines too.
  @gap:map-alias
  @Unsupported
  Scenario: g_V_projectXnX_asXnX_selectXnX_ambiguous_declines
    Given the modern graph
    And the traversal of
      """
      g.V().has("person","name","marko").project("n").by("name").as("n").select("n")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
