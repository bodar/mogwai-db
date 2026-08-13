Feature: mogwai addendum — a keyed grouping filled at several chain positions merges PER KEY

  # `group("a")`/`groupCount("a")` are SIDE EFFECTS, not barrier results: `GroupSideEffectStep` and
  # `GroupCountSideEffectStep` both extend `SideEffectBarrierStep`, which calls `sideEffect(traverser)`
  # and re-adds the traverser unchanged
  # (vendor/tinkerpop/gremlin-core/.../step/sideEffect/SideEffectBarrierStep.java:49-57). Each
  # contribution is a ONE-ENTRY map merged into the label with the step's own reducer —
  # `GroupCountBiOperator` sums per key, `GroupBiOperator` concatenates the value lists per key — and
  # `registerIfAbsent` means every position with the same label merges into ONE map
  # (GroupSideEffectStep.java:121-124, GroupCountSideEffectStep.java:49-57).
  #
  # So a label two chain positions fill holds BOTH sites' contributions, and the grouping cannot happen
  # where the step is — it happens over the UNION of every site's `(key, contribution)` rows, at the
  # `cap`. That is what `groupRows`/`groupMap` split `groupBarrier` for.
  #
  # ⚠️ **The official corpus has exactly one multi-site keyed scenario and it is unreachable** —
  # `GroupCount.feature:205-217` needs `select(Column.keys)` over an ELEMENT-keyed map, which is its own
  # gap. So these are the only place the merge is asserted at all. @gap:group-multi-site marks it.
  #
  # A `groupCount` site beside a `group` site is NOT one grouping and must be REFUSED rather than
  # answered by picking one site's recipe; the compiler raises `UnsupportedTraversal`, pinned in
  # `test/rel-spine.test.ts` where the throw can be asserted directly.

  @gap:group-multi-site
  Scenario: g_V_groupCountXaX_byXnameX_out_groupCountXaX_byXnameX_capXaX
    Given the modern graph
    And the traversal of
      """
      g.V().groupCount("a").by("name").out().groupCount("a").by("name").cap("a")
      """
    # Site 1 is all six vertices, each name once. Site 2 is `V().out()` — marko→lop/vadas/josh,
    # josh→lop/ripple, peter→lop — so `lop` three more times and `vadas`/`josh`/`ripple` one more each.
    # The counts SUM per key, which is `GroupCountBiOperator`; keeping either site alone would answer
    # all-ones or the out-degrees, and both are distinguishable from this.
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"marko":"d[1].l", "vadas":"d[2].l", "lop":"d[4].l", "josh":"d[2].l", "ripple":"d[2].l", "peter":"d[1].l"}] |

  @gap:group-multi-site
  Scenario: g_V_groupXaX_byXnameX_out_groupXaX_byXnameX_capXaX
    Given the modern graph
    And the traversal of
      """
      g.V().group("a").by("name").out().group("a").by("name").cap("a")
      """
    # The COLLECTING arm of the same merge: `GroupBiOperator` concatenates the value lists per key, so
    # every key holds its site-1 member followed by its site-2 members. With a KEY `by()` and no value
    # one, a collecting group's members are the TRAVERSERS — so the multiplicity is visible as repeated
    # vertices under one name, which a merge that kept only one site could not produce.
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"marko":"l[v[marko]]", "vadas":"l[v[vadas],v[vadas]]", "lop":"l[v[lop],v[lop],v[lop],v[lop]]", "josh":"l[v[josh],v[josh]]", "ripple":"l[v[ripple],v[ripple]]", "peter":"l[v[peter]]"}] |

  @gap:group-multi-site
  Scenario: g_V_groupCountXaX_byXlabelX_out_groupCountXaX_byXlabelX_capXaX
    Given the modern graph
    And the traversal of
      """
      g.V().groupCount("a").by(T.label).out().groupCount("a").by(T.label).cap("a")
      """
    # The same merge with a TOKEN key rather than a property one, because the key expression is what each
    # site projects into its own key column and the union has to agree about it. Site 1: 4 person, 2
    # software. Site 2 (`V().out()`): vadas+josh are person, lop×3+ripple are software.
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[6].l", "software":"d[6].l"}] |
