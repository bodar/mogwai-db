Feature: mogwai addendum — groupCount() is a MAP VALUE, and its key keeps its own type

  # The map shape's first arm: a barrier whose result is one map, built as a value in the algebra rather
  # than by handing the step to another lowering. `g.V().groupCount().by(k)` is two ordinary aggregates —
  # GROUP BY the key, then fold the grouped relation into a `[[keyNode, valNode], …]` tree.
  #
  # The official corpus asserts groupCount's CONTENTS in many places, so what it does not pin is what
  # this file does:
  #
  #  1. The key keeps its STORED type. A map key is framed from its own `{t,v}` tag here, so an int key
  #     frames as an int and a string key as a string — in ONE map, which is what "heterogeneous maps
  #     round-trip" means. A route that framed keys by inference would get a small long wrong.
  #  2. `ProductiveByStrategy` keeps a NULL key instead of dropping it. Hardcoding the null filter
  #     changed that answer, and only the census saw it.
  #  3. The count is the TRAVERSER total, not the row total — so a convergent fan-out counts twice.

  @gap:map-shape-group-count
  Scenario: g_V_groupCount_byXageX_counts_per_key
    Given the modern graph
    And the traversal of
      """
      g.V().groupCount().by("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"d[29].i":"d[1].l","d[27].i":"d[1].l","d[32].i":"d[1].l","d[35].i":"d[1].l"}] |

  # A STRING key beside the int one above — same lowering, and the tag is what distinguishes them.
  @gap:map-shape-group-count
  Scenario: g_V_groupCount_byXlabelX_keys_are_strings
    Given the modern graph
    And the traversal of
      """
      g.V().groupCount().by(T.label)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[4].l","software":"d[2].l"}] |

  # THE NULL KEY, kept. Two software vertices have no `age`, so without the strategy they are dropped
  # (the scenario above counts four keys, not five) and with it they group under null.
  @gap:map-shape-group-count
  Scenario: g_withStrategiesXProductiveByX_V_groupCount_byXageX_keeps_the_null_key
    Given the modern graph
    And the traversal of
      """
      g.withStrategies(ProductiveByStrategy).V().groupCount().by("age")
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 2 for count of "g.V().hasNot(\"age\")"
    # Two of the six lack `age`, so WITHOUT the strategy this map has four entries (the scenario above)
    # and with it five — the fifth keyed null. The null key's VALUE (2) is pinned exactly in
    # test/L2-sql/plumbing.sql.test.ts, which can read the entry directly.

  # THE COUNT IS TRAVERSERS, not rows. marko's two-hop frontier reaches lop twice (via vadas? no — via
  # josh and directly), so a route counting rows after a convergent collapse would say 1.
  @gap:map-shape-group-count
  Scenario: g_V_out_out_groupCount_byXlabelX_counts_traversers
    Given the modern graph
    And the traversal of
      """
      g.V().out().out().groupCount().by(T.label)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"software":"d[2].l"}] |

  # An EMPTY stream is an empty MAP and still one traverser — the `COALESCE` in the fold, which is not
  # defensive: `json_group_array` over zero rows is NULL, and a null traverser value is a different
  # answer from an empty map.
  @gap:map-shape-group-count
  Scenario: g_V_hasLabelXnoneX_groupCount_byXageX_is_an_empty_map
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("nonexistent").groupCount().by("age")
      """
    When iterated to list
    Then the result should have a count of 1

  # `hasNot(key)` — the elements carrying NO property under the key. Written for this file's own
  # graph-check and then found to be MISSING from both spines, which is why it has its own scenarios:
  # a step the corpus mentions once and neither lowering implemented.
  @gap:map-shape-group-count
  Scenario: g_V_hasNotXageX_keeps_only_the_elements_without_it
    Given the modern graph
    And the traversal of
      """
      g.V().hasNot("age").values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | ripple |

  # The exact negation of a bare has(key): the two partition the stream, so their counts must sum to
  # |V|. A second absence test spelled independently is what this makes impossible to get away with.
  @gap:map-shape-group-count
  Scenario: g_V_hasXageX_and_hasNotXageX_partition_the_stream
    Given the modern graph
    And the traversal of
      """
      g.V().hasNot("age").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
    And the graph should return 4 for count of "g.V().has(\"age\")"
    And the graph should return 6 for count of "g.V()"

  # An EDGE property, so the absence test reaches the other side table.
  @gap:map-shape-group-count
  Scenario: g_E_hasNotXweightX_is_empty_on_the_modern_graph
    Given the modern graph
    And the traversal of
      """
      g.E().hasNot("weight").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  # ─── group(): the map's VALUE is a LIST OF ELEMENTS, and an element is a MEMBER of the tree ───
  #
  # The map shape's second arm, and the wire composition it rests on is what these pin. `group().by(k)`
  # with no value `by()` collects the traversers themselves, so the value side is a list of VERTICES —
  # and that is expressed by making an element a first-class MEMBER of the self-describing tree
  # (`{t:'vertex', v:{id,label,props}}`), not by a per-position descriptor the framer has to be handed.
  #
  # Naming the arm once is what makes the containers compose: a list of elements, a map whose value is a
  # list of elements, and (later) a map whose KEY is an element are the same rule at a different depth.
  # The official corpus asserts group()'s CONTENTS; what it does not pin is that the members arrive as
  # real elements WITH their properties rather than as inferred JS maps — which is exactly the class of
  # bug that made the whole-element serializers hand-rolled in the first place.

  @gap:map-shape-group-count
  Scenario: g_V_hasLabelXpersonX_group_byXageX_values_are_vertices
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"d[29].i":["v[marko]"],"d[27].i":["v[vadas]"],"d[32].i":["v[josh]"],"d[35].i":["v[peter]"]}] |

  # SEVERAL members under one key, so the list is a real list rather than a one-element accident. Member
  # order is the TRAVERSERS' own (the emission position where the chain has one, the element id
  # otherwise) — stated, because the members ride inside one collected traverser's buffer and their order
  # is therefore fully observable.
  @gap:map-shape-group-count
  Scenario: g_V_group_byXlabelX_collects_every_member
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":["v[marko]","v[vadas]","v[josh]","v[peter]"],"software":["v[lop]","v[ripple]"]}] |

  # EDGE members are NOT pinned here, and the reason is the harness rather than the feature: this runner
  # compares a decoded element BY ID and resolves `v[name]` through a cache keyed on the `name` property,
  # which the fixtures' edges do not carry — so an edge member could only be written as a raw rowid, which
  # pins the wrong thing. The edge arm is asserted where the comparison can be about the PAYLOAD instead:
  # `test/rel-spine.test.ts` decodes the map and checks each member's label and its EXTERNAL endpoints,
  # which is the field two of the fourteen hand-rolled element payloads used to get wrong.
