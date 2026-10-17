Feature: mogwai addendum — order() by a key SQL cannot compare (ORDERABILITY ranked in JS)

  # TinkerPop 4's `Order.asc`/`desc` compare through GremlinValueComparator.ORDERABILITY
  # (vendor/tinkerpop/gremlin-core/.../traversal/Order.java:85-88) — a total order that RECURSES into a
  # collection: a list compares element-wise, shorter-as-prefix first (`iterableComparator`). A `by()` whose
  # key is a LIST therefore has no SQL ORDER BY; the order is a ranked-order barrier — the head reads every
  # traverser's key, JS dense-ranks the keys, the resume joins each traverser to its rank
  # (src/compiler/rel/ranked-order.ts). The TRAVERSER is never re-injected, so it comes back as itself
  # (an element, not its key) and a later step reads it as usual. Corpus witness: Order.feature's
  # g_V_hasLabelXhabitatX_order_byXlabels_order_foldX (zoo graph), whose `labels().order()` key body is a
  # separate gap — these pin the ranking with keys that lower today. @gap:ranked-order.

  # `values('age').fold()` is `[]` for software (fold seeds an empty list) and `[age]` for a person, so the
  # empty lists sort FIRST (a prefix of everything) and the second `by('name')` breaks their tie.
  @gap:ranked-order
  Scenario: g_V_order_byXvaluesXageX_foldX_byXnameX_name
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(__.values("age").fold()).by("name").values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |
      | ripple |
      | vadas |
      | marko |
      | josh |
      | peter |

  # Each `by()` keeps its OWN direction (`OrderGlobalStep`'s MultiComparator): the list key descends, the
  # tie-breaking name still ascends.
  @gap:ranked-order
  Scenario: g_V_order_byXvaluesXageX_fold_descX_byXnameX_name
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(__.values("age").fold(), desc).by("name").values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | peter |
      | josh |
      | marko |
      | vadas |
      | lop |
      | ripple |

  # A barrier AFTER the ranked order (`reverse()` over the names) is reached: the resume re-plans the whole
  # chain under the ranking, so the later barrier's head lowers through it.
  @gap:ranked-order
  Scenario: g_V_order_byXvaluesXageX_foldX_byXnameX_name_reverse
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(__.values("age").fold()).by("name").values("name").reverse()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | pol |
      | elppir |
      | sadav |
      | okram |
      | hsoj |
      | retep |

  # ---- order(Scope.local) over ONE MAP's entries ----
  #
  # `OrderLocalStep.map`'s Map arm sorts `entrySet()` and re-inserts into a LinkedHashMap
  # (vendor/tinkerpop/gremlin-core/.../step/map/OrderLocalStep.java:77-82); `by(Column.values)`/`by(Column.keys)`
  # read the entry's side. Corpus witness: Order.feature g_V_hasLabelXpersonX_group_byXnameX_byXoutE_weight_sumX_orderXlocalX_byXvaluesX.
  # `unfold()` exposes the re-sorted entry order as stream order.

  @gap:ranked-order
  Scenario: g_V_group_byXlabelX_byXcountX_orderXlocalX_byXvaluesX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.count()).order(Scope.local).by(Column.values).unfold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"software":"d[2].l"}] |
      | m[{"person":"d[4].l"}] |

  @gap:ranked-order
  Scenario: g_V_hasLabelXpersonX_group_byXnameX_byXageX_orderXlocalX_byXkeys_descX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.values("age").sum()).order(Scope.local).by(Column.keys, desc).unfold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"vadas":"d[27].l"}] |
      | m[{"peter":"d[35].l"}] |
      | m[{"marko":"d[29].l"}] |
      | m[{"josh":"d[32].l"}] |

  # Two local orders in a row — the second is a barrier in the first's resume tail, reached by re-planning
  # the tail rooted at the re-injected maps. The LAST sort decides.
  @gap:ranked-order
  Scenario: g_V_hasLabelXpersonX_group_byXnameX_byXageX_orderXlocalX_byXvalues_descX_orderXlocalX_byXkeysX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.values("age").sum()).order(Scope.local).by(Column.values, desc).order(Scope.local).by(Column.keys).unfold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"josh":"d[32].l"}] |
      | m[{"marko":"d[29].l"}] |
      | m[{"peter":"d[35].l"}] |
      | m[{"vadas":"d[27].l"}] |

  # ---- a by() over a RECORD that re-roots through one of its fields ----
  #
  # `select('v')` inside a `by()` over a `select('v','s')` record reads the record's FIELD first — the
  # traverser's own Map scope beats the path labels (`Scoping.getScopeValue`,
  # vendor/tinkerpop/gremlin-core/.../step/Scoping.java:119-131) — and the body continues against the
  # vertex the field holds. Corpus witness: Order.feature
  # g_V_asXvX_mapXbothE_weight_foldX_sumXlocalX_asXsX_selectXv_sX_order_byXselectXsX_descX_byXselectXvX_nameX.
  @gap:ranked-order
  Scenario: g_V_asXvX_age_asXsX_selectXv_sX_order_byXselectXvX_nameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("v").values("age").as("s").select("v","s").order().by(__.select("v").values("name"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"v":"v[josh]","s":"d[32].i"}] |
      | m[{"v":"v[marko]","s":"d[29].i"}] |
      | m[{"v":"v[peter]","s":"d[35].i"}] |
      | m[{"v":"v[vadas]","s":"d[27].i"}] |

  # ---- a by() key whose fold reads only the HOST ----
  #
  # `label().fold()` is a one-row body spelled entirely out of the host row, so SQL would evaluate its
  # aggregate in the OUTER query and collapse the whole stream into one list (one traverser out of six).
  # FoldStep reduces its OWN sub-traversal per traverser — each key is `[label]` — so all six survive,
  # each label's rank tie-broken by name.
  @gap:ranked-order
  Scenario: g_V_order_byXlabel_foldX_byXnameX_name
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(__.label().fold()).by("name").values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | marko |
      | peter |
      | vadas |
      | lop |
      | ripple |

  @gap:ranked-order
  Scenario: g_V_order_byXid_fold_descX_name
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(__.id().fold(), desc).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | peter |
      | ripple |
      | josh |
      | lop |
      | vadas |
      | marko |

  # The same substrate under `groupCount()`: one `[label]` key per vertex, counted per label.
  Scenario: g_V_groupCount_byXlabel_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().groupCount().by(__.label().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"l[person]":"d[4].l","l[software]":"d[2].l"}] |
