Feature: mogwai addendum — order() (GLOBAL) over a STREAM OF LISTS (JS ORDERABILITY barrier)

  # A bare GLOBAL order() (identity comparator, no by()) over a stream whose TRAVERSERS are lists sorts the
  # STREAM by TinkerPop's ORDERABILITY — the total order that compares two lists element-wise and recurses
  # into nested collections (GremlinValueComparator.ORDERABILITY). recursion-free SQL cannot express that,
  # so it runs as the SAME sync value-transform barrier order(Scope.local)/reverse()/split() use, only the
  # transform reads the WHOLE stream at once (orderStreamValue): a SQL head reads one list per traverser, a
  # batched JS sort reorders the array, and the sorted position becomes the emission order (orderability.ts
  # / order-dedup-local.ts). A SCALAR stream (values('age').order()) stays in SQL — SQLite orders scalars
  # by storage class — so this fires ONLY for a list stream. @gap:stream-order.

  @gap:stream-order
  Scenario: g_injectXlistsX_order
    Given the modern graph
    And the traversal of
      """
      g.inject([3,1],[2,2],[1,9]).order()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[9].i] |
      | l[d[2].i,d[2].i] |
      | l[d[3].i,d[1].i] |

  # Shorter-as-prefix sorts first — the element-wise compare falls through to length (iterableComparator).
  @gap:stream-order
  Scenario: g_injectXunevenX_order_shorter_prefix_first
    Given the modern graph
    And the traversal of
      """
      g.inject([1,2,3],[1,2]).order()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[2].i] |
      | l[d[1].i,d[2].i,d[3].i] |

  # The sorted stream unfolds to its members, an EARLIER list's members before a LATER one's — the re-
  # injected stream carries its position as an encounter channel so unfold() does not sort by the inner
  # member ordinal alone (the split()/reverse() re-inject fix shares this).
  @gap:stream-order
  Scenario: g_injectXlistsX_order_unfold
    Given the modern graph
    And the traversal of
      """
      g.inject([3,1],[2,2]).order().unfold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[2].i |
      | d[2].i |
      | d[3].i |
      | d[1].i |

  # A MAP stream (a valueMap() head) orders by ORDERABILITY's map rule — the sorted ENTRY-SET compared
  # element-wise, each entry by key then value (mapComparator). A single-key name map therefore sorts by
  # the name value: josh < marko < peter < vadas (scan order is marko, vadas, josh, peter).
  @gap:stream-order
  Scenario: g_V_hasLabelXpersonX_valueMapXnameX_order
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").valueMap("name").order()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"name":"l[josh]"}] |
      | m[{"name":"l[marko]"}] |
      | m[{"name":"l[peter]"}] |
      | m[{"name":"l[vadas]"}] |

  # Two-key maps sort by AGE first: the entry-set sorts to [(age,…),(name,…)] (key "age" < "name"), so the
  # leading entry the maps compare on is age — 27, 29, 32, 35.
  @gap:stream-order
  Scenario: g_V_hasLabelXpersonX_valueMapXname_ageX_order_by_age
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").valueMap("name","age").order()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"name":"l[vadas]","age":"l[d[27].i]"}] |
      | m[{"name":"l[marko]","age":"l[d[29].i]"}] |
      | m[{"name":"l[josh]","age":"l[d[32].i]"}] |
      | m[{"name":"l[peter]","age":"l[d[35].i]"}] |

  # An ELEMENT-membered list STREAM — unfold a Map<K,List<vertex>>'s values into a stream of vertex-lists,
  # then order() the whole stream. Like the Scope.local barrier, element members are carried as rowids and
  # re-source at the edge, so the sorted stream re-enters the graph. The assertion is the order-independent
  # name multiset after unfold/read (reference-safe: order()'s stream sort compares vertex-lists element-
  # wise by id, but each inner list's order is out()'s, unspecified in the reference); the exact sorted
  # structure is regression-locked in test/compiler/nested-element-order.exec.test.ts.
  @gap:stream-order
  Scenario: g_V_group_byName_byXoutFoldX_selectValues_unfold_order_unfold_name
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.out().fold()).select(Column.values).unfold().order().unfold().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | lop |
      | josh |
      | lop |
      | lop |
      | ripple |
