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
  # ---- project().unfold() → per-field Map.Entry stream (symmetry with valueMap) ----

  # A project-produced record unfolds to one Map.Entry per field, exactly as valueMap does. The
  # record COLLAPSES to a map (recordToMap) and re-enters mapTail's own unfold vocabulary, so its
  # key is the {t:'string'} node every map producer uses (never a bare string — that would not be
  # valid JSON for the entry-key framer). GraphQL to-one object fields as an entry stream.
  @gap:map-unfold
  Scenario: g_V_hasLabelXpersonX_limitX1X_projectXn_aX_byXnameX_byXageX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").limit(1).project("n","a").by("name").by("age").unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"n":"marko"}] |
      | m[{"a":"d[29].i"}] |

  # Entry-level select(keys) after a project unfold reads each field name.
  @gap:map-unfold
  Scenario: g_V_hasLabelXpersonX_limitX1X_projectXn_aX_unfold_selectXkeysX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").limit(1).project("n","a").by("name").by("age").unfold().select(keys)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | n |
      | a |

  # A project field whose by() body folds to a LIST unfolds with the element list expanded — the
  # value side re-enters listTail, so the vertices frame as vertices (not raw rowids).
  @gap:map-unfold
  Scenario: g_V_hasLabelXpersonX_limitX1X_projectXn_oX_byXnameX_byXoutFoldX_unfold_selectXvaluesX
    Given the modern graph
    And the traversal of
      """
      g.V().has("person","name","marko").project("n","o").by("name").by(__.out().count()).unfold().select(values)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | d[3].l |

  # ---- Commit A: valueMap().unfold() → per-element Map.Entry stream ----

  # The canonical driver (map/Unfold.feature g_V_valueMap_unfold_mapXselectXkeysXX): each
  # vertex's valueMap is exploded to its entries, then select(keys) reads each entry's key.
  @gap:map-unfold
  @Unsupported
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

  # ---- G2: a DOUBLE-GROUP of an element-list value — the nested shape now expands ----

  # `group().by(k).by(__.out().fold()).unfold().group().by(Column.keys)` re-groups the unfolded entries
  # with NO value-by, so each new member is the entry's own `{t:'list', v:[rowids]}` value. The value is
  # a LIST-OF-LISTS with the vertices expanded: the group recipe carries the entry's own valOf (`memberOf`)
  # and routes it through the ALREADY-recursive `listNodeExpr`, the same "the member IS the value's shape"
  # identity `by(Column.values)` uses — so this frames vertices, not raw rowids
  # (docs/archive/2026-08-28-map-support-finishing-plan.md §G2). Each key's value is a single-member outer list
  # whose one member is that key's out-neighbours list.
  @gap:map-unfold
  Scenario: g_V_group_byXnameX_byXoutFoldX_unfold_group_byXkeysX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").has("name","marko").group().by("name").by(__.out().fold()).unfold().group().by(Column.keys)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"marko":"l[l[v[vadas],v[lop],v[josh]]]"}] |

  # ---- Commit C: is(typeOf(MAP)) over a STORED map property → MapStream retype ----

  # A stored map property, retyped by is(typeOf(MAP)), frames whole (terminal) and its
  # followers (count(local)/select(values)/unfold) reuse the blob substrate.
  @gap:map-unfold
  @Unsupported
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
  @Unsupported
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
  @Unsupported
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
  @Unsupported
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
  @Unsupported
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
  @Unsupported
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
