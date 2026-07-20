Feature: mogwai addendum — Map.Entry relational unfold (is(typeOf(MAP)) family)

  # unfold() over a Map (group()/groupCount()/valueMap()/a stored map property via
  # is(typeOf(MAP))) explodes it into a stream of Map.Entry values. On GraphBinary v4 an
  # entry has no dedicated DataType — TinkerPop's MapEntrySerializer transforms it into a
  # one-entry Map (TINKERPOP-3104, "A Note on Maps"), so each entry frames as a size-1 MAP.
  # The official corpus only ever consumes these entries via select(Column.*) / map(select),
  # never materializes a bare entry — these scenarios pin the terminal + consumer shapes.
  # @gap:map-unfold marks the family for a gremlin-test PR.

  # ---- Commit B: bare terminal Map.Entry (group / groupCount unfold) ----

  @gap:map-unfold
  Scenario: g_V_groupCount_byXlabelX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().groupCount().by(T.label).unfold()
      """
    When iterated to list
    Then the result should be unordered
      # count frames as a typed GraphBinary long; the JS client decodes a small long as a
      # Number (d[..].l would assert BigInt — see the notation note in l4.test.ts).
      | result |
      | m[{"person":"d[4].i"}] |
      | m[{"software":"d[2].i"}] |

  @gap:map-unfold
  Scenario: g_V_group_byXlabelX_byXnameX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by("name").unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[marko,vadas,josh,peter]"}] |
      | m[{"software":"l[lop,ripple]"}] |

  # group().by(k).by(reducer) unfolded → one entry per key, value a scalar reduction.
  @gap:map-unfold
  Scenario: g_V_group_byXlabelX_byXcountX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.count()).unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[4].i"}] |
      | m[{"software":"d[2].i"}] |
  # ---- Commit A: valueMap().unfold() → per-element Map.Entry stream ----

  # The canonical driver (map/Unfold.feature g_V_valueMap_unfold_mapXselectXkeysXX): each
  # vertex's valueMap is exploded to its entries, then select(keys) reads each entry's key.
  @gap:map-unfold
  Scenario: g_V_valueMap_unfold_mapXselectXkeysXX
    Given the modern graph
    And the traversal of
      """
      g.V().valueMap().unfold().map(__.select(keys))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | name |
      | age  |
      | name |
      | age  |
      | name |
      | lang |
      | lang |
      | name |
      | age  |
      | name |
      | name |
      | age  |

  # Entry-level select(values) reads each entry's value (a valueMap value is a list).
  @gap:map-unfold
  Scenario: g_V_hasLabelXsoftwareX_valueMap_unfold_selectXvaluesX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").valueMap("name").unfold().select(values)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[lop] |
      | l[ripple] |

  # A bare terminal valueMap().unfold() materializes each entry as a size-1 MAP.
  @gap:map-unfold
  Scenario: g_V_hasLabelXsoftwareX_valueMapXnameX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").valueMap("name").unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"name":"l[lop]"}] |
      | m[{"name":"l[ripple]"}] |

  # ---- Commit C: is(typeOf(MAP)) over a STORED map property → MapStream retype ----

  # A stored map property, retyped by is(typeOf(MAP)), frames whole (terminal) and its
  # followers (count(local)/select(values)/unfold) reuse the blob substrate.
  @gap:map-unfold
  Scenario: g_V_valuesXmX_isXtypeOfXGType_MAPXX
    Given the mapdata graph
    And the traversal of
      """
      g.V().values("m").is(typeOf(GType.MAP))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"d[1].i","b":"d[2].i","c":"d[3].i"}] |

  @gap:map-unfold
  Scenario: g_V_valuesXmX_isXtypeOfXGType_MAPXX_countXlocalX
    Given the mapdata graph
    And the traversal of
      """
      g.V().values("m").is(typeOf(GType.MAP)).count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  @gap:map-unfold
  Scenario: g_V_valuesXmX_isXtypeOfXGType_MAPXX_selectXvaluesX
    Given the mapdata graph
    And the traversal of
      """
      g.V().values("m").is(typeOf(GType.MAP)).select(values)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[1].i,d[2].i,d[3].i] |

  @gap:map-unfold
  Scenario: g_V_valuesXmX_isXtypeOfXGType_MAPXX_selectXkeysX
    Given the mapdata graph
    And the traversal of
      """
      g.V().values("m").is(typeOf(GType.MAP)).select(keys)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[a,b,c] |

  # unfold() explodes the stored map into per-entry size-1 MAPs.
  @gap:map-unfold
  Scenario: g_V_valuesXmX_isXtypeOfXGType_MAPXX_unfold
    Given the mapdata graph
    And the traversal of
      """
      g.V().values("m").is(typeOf(GType.MAP)).unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"d[1].i"}] |
      | m[{"b":"d[2].i"}] |
      | m[{"c":"d[3].i"}] |

  # unfold().select(keys) reads each entry's key.
  @gap:map-unfold
  Scenario: g_V_valuesXmX_isXtypeOfXGType_MAPXX_unfold_selectXkeysX
    Given the mapdata graph
    And the traversal of
      """
      g.V().values("m").is(typeOf(GType.MAP)).unfold().select(keys)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |
      | b |
      | c |
