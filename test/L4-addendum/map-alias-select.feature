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

  # PRECEDENCE: when the alias name IS also a possible map key (project("n").as("n")), TinkerPop returns
  # the MAP value where the map holds the key (containsKey wins). The map's own scope wins here too; a row
  # whose map lacked the key would drop (a deliberate divergence — the reference falls through to the alias).
  @gap:map-alias
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

  # A keyed dedup(k) over a map whose keys are DATA reads, per row, the map's value where it holds k and
  # the path label where it does not (`Scoping.getScopeValue`); a map lacking k with no label behind it
  # keys on null, which is productive without a by() (`DedupGlobalStep.java:80-88`).
  Scenario: g_V_asXaX_valueMap_dedupXaX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").valueMap().dedup("a").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_asXlangX_valueMap_dedupXlangX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("lang").valueMap().dedup("lang").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].l |

  Scenario: g_V_valueMap_dedupXlangX_count
    Given the modern graph
    And the traversal of
      """
      g.V().valueMap().dedup("lang").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  Scenario: g_V_group_byXlabelX_dedupXpersonX_count
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).dedup("person").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
