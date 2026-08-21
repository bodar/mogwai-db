Feature: mogwai addendum — a map VALUE that is a list carries its true shape

  # A `group().by(k).by(<valueTraversal>)` whose value traversal ends in `fold()` has a LIST value
  # (TinkerPop injects `fold()` into every non-reducing value traversal — GroupStep.java:61,
  # Grouping.java:92-101). `select(Column.values)` over a `Map<K,List>` is a LIST-OF-LISTS (Column.java:60),
  # `unfold()` peels ONE level to a list per key (UnfoldStep.java:47), and `order(Scope.local)` sorts each
  # of those lists (OrderLocalStep.java:73). Until the map-value shape carried the value's TRUE shape,
  # the stream reaching `order(Scope.local)` was framed as a scalar-with-vtype-list and the sort was a
  # silent no-op; now `valOf` is `{list}`, so the whole tail composes.
  # Substrate: docs/2026-08-21-map-value-shape-plan.md. These pin the composition at depth, not the count.
  @gap:map-value-list-shape

  # select(values).unfold().order(local): each group's folded out-labels, sorted per list. group().by()
  # keys by the vertex identity, so one entry per vertex; the software vertices and vadas have no out.
  Scenario: g_V_group_by_byXout_label_foldX_selectXvaluesX_unfold_orderXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by().by(__.out().label().fold()).select(Column.values).unfold().order(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[person,person,software] |
      | l[software,software] |
      | l[software] |
      | l[] |
      | l[] |
      | l[] |

  # select(<key>).unfold(): a single list value at a key unfolds to its members — the value is a list
  # stream now, not a scalar carrying a JSON blob.
  Scenario: g_V_hasLabelXpersonX_group_byXnameX_byXout_label_foldX_selectXmarkoX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.out().label().fold()).select("marko").unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | person |
      | person |
      | software |

  # A vertex valueMap() value is ALWAYS a List (one ArrayList per key, PropertyMapStep.java:246), so the
  # same select(values).unfold().order(local).conjoin composition works over a valueMap — here the crew
  # graph's list-cardinality `location` property (Conjoin.feature's crew scenario).
  Scenario: g_V_valueMapXlocationX_selectXvaluesX_unfold_orderXlocalX_conjoinX1X
    Given the crew graph
    And the traversal of
      """
      g.V().valueMap("location").select(values).unfold().order(Scope.local).conjoin("1")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | brussels1san diego1santa cruz1santa fe |
      | centreville1dulles1purcellville |
      | baltimore1bremen1oakland1seattle |
      | aachen1kaiserslautern1spremberg |

  # ELEMENT KEYS: select(Column.keys) of an identity-keyed group (groupCount) is a SET of the grouped
  # vertices — each a self-describing {t:'vertex'} node framed through the mixed→typedNode path, not the
  # lossy scalar-list framer. unfold() yields the four person vertices.
  Scenario: g_V_hasLabelXpersonX_groupCount_selectXkeysX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").groupCount().select(Column.keys).unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[marko] |
      | v[vadas] |
      | v[josh] |
      | v[peter] |

  # MAP-VALUED map: a group whose value is a project() is a Map<K,Map>. select(Column.values).unfold()
  # peels to each inner MAP (re-entering mapTail), so select("x") reads the inner field — the ages. Before
  # the map valOf carried its true shape this silently mis-shaped the inner map as a scalar ([{}]).
  Scenario: g_V_hasLabelXpersonX_group_byXnameX_byXprojectXxX_byXageXX_selectXvaluesX_unfold_selectXxX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.project("x").by(__.values("age"))).select(Column.values).unfold().select("x")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |

  # conjoin over the unfolded, sorted per-key list — a list→string reduction composed on top.
  Scenario: g_V_group_by_byXout_label_foldX_selectXvaluesX_unfold_orderXlocalX_conjoinXdashX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by().by(__.out().label().fold()).select(Column.values).unfold().order(Scope.local).conjoin("-")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | person-person-software |
      | software-software |
      | software |
      |  |
      |  |
      |  |
