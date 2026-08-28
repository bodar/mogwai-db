Feature: mogwai addendum — a map VALUE that is an element list re-enters element traversal

  # Stage 1 of the federate mapValues redesign surfaced a general gap: a group value that is a
  # LIST OF ELEMENTS (`by(__.out().fold())`) must re-enter the ELEMENT vocabulary when the tail
  # unfolds it and continues with `out()`/`values()`. Until the element-membered map value stored
  # ROWIDS (tagged `{kind:'elem'}`, like every other element list — `foldElements`/`unfoldList`),
  # `select(Column.values).unfold().out()` declined: the members were pre-expanded `{t:'vertex'}`
  # nodes, which have no rowid to re-enter on. Now the collecting arm keeps the rowid, so re-entry
  # routes through the ordinary element loop and composes at any depth.
  # Substrate: docs/archive/2026-08-21-map-value-shape-plan.md (line 164 — "an elem value still declines"),
  # docs/2026-08-26-federate-pushdown-design.md (Injection, Stage 1).
  @gap:map-value-element-reentry

  # DEPTH 1 — group().by(name).by(__.out().fold()) is a Map<name, List<vertex>>. select(values)
  # is a List<List<vertex>>; unfold() peels to one vertex list per person; a SECOND unfold happens
  # implicitly because select(values).unfold() over List<List> yields each inner list, then the
  # element re-entry needs the members. TinkerPop: select(values).unfold() over Map<K,List> emits
  # each List (UnfoldStep peels one level, Column.java:60), so this form unfolds ONCE to the per-key
  # lists — to reach the vertices themselves the test unfolds the value lists. Here the value by()
  # is `__.out()` (single-value, injected fold -> a list per key), and select(values).unfold()
  # lands the per-key vertex lists; .out() on each list is a decline unless the members re-enter as
  # elements. The oracle below flattens with a nested unfold to make the element re-entry explicit.
  Scenario: g_V_hasLabelXpersonX_group_byXnameX_byXout_foldX_selectXvaluesX_unfold_unfold_out
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.out().fold()).select(Column.values).unfold().unfold().out()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[ripple] |
      | v[lop] |

  # DEPTH 2 — the same, one element hop deeper then a value read, proving the re-entered stream is a
  # full element stream (out().values() composes), not a one-level shim.
  Scenario: g_V_hasLabelXpersonX_group_byXnameX_byXout_foldX_selectXvaluesX_unfold_unfold_out_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.out().fold()).select(Column.values).unfold().unfold().out().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | ripple |
      | lop |

  # AN ENTRY VALUE CROSSES ONE MORE MAP BOUNDARY in the nested group. Its retained list members are
  # still rowids in the relation, but the new map's typed-tree member must expand them to vertices.
  Scenario: g_V_hasLabelXpersonX_group_byXnameX_byXout_foldX_unfold_group_byXkeysX_byXvaluesX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.out().fold()).unfold().group().by(Column.keys).by(Column.values)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"josh":[["v[lop]","v[ripple]"]],"marko":[["v[vadas]","v[lop]","v[josh]"]],"peter":[["v[lop]"]],"vadas":[[]]}] |

  # The equivalent entry-side child read is a collecting member too, not an assignment scalar.
  # `Column.values` passes the live value unchanged (`vendor/tinkerpop/gremlin-core/src/main/java/
  # org/apache/tinkerpop/gremlin/structure/Column.java:57-68`), so it frames identically to the token form.
  Scenario: g_V_hasLabelXpersonX_group_byXnameX_byXout_foldX_unfold_group_byXkeysX_byXselect_valuesX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.out().fold()).unfold().group().by(Column.keys).by(select(Column.values))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"josh":[["v[lop]","v[ripple]"]],"marko":[["v[vadas]","v[lop]","v[josh]"]],"peter":[["v[lop]"]],"vadas":[[]]}] |
