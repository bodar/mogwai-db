Feature: mogwai addendum — a map's static key fact: the keys a row MAY hold

  # `select(k)` over a Map stream resolves `Scoping.getScopeValue`'s precedence — the traverser's own Map,
  # then the side effects, then the path labels
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135).
  # The compiler decides that on ONE compile-time fact per map stream (src/compiler/rel/framing.ts
  # `MapKeyFacts`): `keys`, the keys a row MAY hold (a too-narrow set skips a real entry). A branch merge
  # and an alias history UNION it (`meetMapKeyFacts`); a local entry slice keeps it as an upper bound. A key
  # outside it reads the next scope for every row. A key inside it beside a same-named side effect or label
  # DECLINES (§17 "Map scope"). There is no MUST set, so this holds even where every row does hold the key:
  # the collision is in the query text, and the user almost certainly meant one or the other.
  #
  # The decline says why. ONE classifier (`mapKeyCollision`, src/compiler/rel/lower.ts, beside
  # `namedBeyondMap`) names the collision for every map-first reader: `select`, `format`, `math`, a keyed
  # `dedup`. Its reason is appended to the generic "no lowering covers …" as a hint, and it is worded as a
  # MAY ("each Map may hold a key 'b'"), because the key fact is only what a row MAY hold. Each scenario
  # whose decline is that collision pins the reason with `And the decline should say "…"`.

  # A branch merge of map arms with DIFFERENT key sets: the merged stream may hold `b` (one arm does), so the
  # row lacking it reads the side effect. Before, the merge kept the FIRST arm's key set and read `7` twice.
  # Entry-or-side-effect per row is a collision the query text names, so these DECLINE (§17 "Map scope") —
  # and still pin the meet: a meet that lost `b` from `keys` would answer `7` for every row instead.
  @Unsupported
  Scenario: g_withSideEffectXb_7X_injectX1X_unionXconstantXa3X_constantXa1_b2XX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("b", 7).inject(1).union(__.constant(["a": 3]), __.constant(["a": 1, "b": 2])).select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |
      | d[2].i |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a side effect 'b' is also declared"

  @Unsupported
  Scenario: g_withSideEffectXb_7X_injectX1X_unionXconstantXa1_b2X_constantXa3XX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("b", 7).inject(1).union(__.constant(["a": 1, "b": 2]), __.constant(["a": 3])).select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |
      | d[7].i |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a side effect 'b' is also declared"

  @Unsupported
  Scenario: g_withSideEffectXb_7X_V_chooseXhasLabelXpersonX_constantXa1_b2X_constantXa3XX_selectXbX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("b", 7).V().choose(__.hasLabel("person"), __.constant(["a": 1, "b": 2]), __.constant(["a": 3])).select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |
      | d[2].i |
      | d[2].i |
      | d[2].i |
      | d[7].i |
      | d[7].i |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a side effect 'b' is also declared"

  # The merged facts ride an as() label too.
  @Unsupported
  Scenario: g_withSideEffectXb_7X_injectX1X_unionXconstantXa3X_constantXa1_b2XX_asXmX_selectXmX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("b", 7).inject(1).union(__.constant(["a": 3]), __.constant(["a": 1, "b": 2])).as("m").select("m").select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |
      | d[2].i |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a side effect 'b' is also declared"

  # The record-field twin: two record arms whose map-valued FIELD has different key sets. The meet recurses
  # through the record's fields, in either arm order.
  @Unsupported
  Scenario: g_withSideEffectXage_7X_V_hasLabelXpersonX_unionXprojectXmX_byXelementMapXnameXX_projectXmX_byXelementMapXname_ageXXX_selectXmX_selectXageX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("age", 7).V().hasLabel("person").union(__.project("m").by(__.elementMap("name")), __.project("m").by(__.elementMap("name", "age"))).select("m").select("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |
      | d[7].i |
      | d[7].i |
      | d[7].i |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |
    And the decline should say "is ambiguous here: each Map may hold a key 'age' and a side effect 'age' is also declared"

  @Unsupported
  Scenario: g_withSideEffectXage_7X_V_hasLabelXpersonX_unionXprojectXmX_byXelementMapXname_ageXX_projectXmX_byXelementMapXnameXXX_selectXmX_selectXageX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("age", 7).V().hasLabel("person").union(__.project("m").by(__.elementMap("name", "age")), __.project("m").by(__.elementMap("name"))).select("m").select("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |
      | d[7].i |
      | d[7].i |
      | d[7].i |
      | d[7].i |
    And the decline should say "is ambiguous here: each Map may hold a key 'age' and a side effect 'age' is also declared"

  # A label bound in arms with different key sets: its history MEETS the facts too. `{a:1}` lacks `b` and
  # nothing else names `b`, so that row drops.
  Scenario: g_injectX1X_unionXconstantXa1X_asXxX_constantXa2_b3X_asXxXX_selectXxX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.inject(1).union(__.constant(["a": 1]).as("x"), __.constant(["a": 2, "b": 3]).as("x")).select("x").select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].i |

  # Literals sharing a key set, beside a same-named label: a collision the query text names — declines.
  @Unsupported
  Scenario: g_injectXa1_b2X_a3_b4X_asXaX_selectXaX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1, "b": 2], ["a": 3, "b": 4]).as("a").select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[3].i |
    And the decline should say "is ambiguous here: each Map may hold a key 'a' and a path label 'a' is also bound"

  # A LOCAL ENTRY SLICE between a map literal and a same-named label: the slice keeps the key set as an
  # upper bound (it is not re-derived from the window), so the label collision declines.
  @Unsupported
  Scenario: g_injectXa1_b2X_a3_b4X_limitXlocal_1X_asXbX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1, "b": 2], ["a": 3, "b": 4]).limit(Scope.local, 1).as("b").select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"d[1].i"}] |
      | m[{"a":"d[3].i"}] |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a path label 'b' is also bound"

  @Unsupported
  Scenario: g_injectXa1_b2X_a3_b4X_tailXlocal_1X_asXaX_selectXaX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1, "b": 2], ["a": 3, "b": 4]).tail(Scope.local, 1).as("a").select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"b":"d[2].i"}] |
      | m[{"b":"d[4].i"}] |
    And the decline should say "is ambiguous here: each Map may hold a key 'a' and a path label 'a' is also bound"

  @Unsupported
  Scenario: g_V_asXbX_constantXa1_b2X_limitXlocal_1X_selectXbX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("b").constant(["a": 1, "b": 2]).limit(Scope.local, 1).select("b").values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | lop |
      | josh |
      | ripple |
      | peter |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a path label 'b' is also bound"

  @Unsupported
  Scenario: g_withSideEffectXm_a1X_injectX1X_selectXmX_limitXlocal_0X_asXaX_selectXaX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("m", ["a": 1]).inject(1).select("m").limit(Scope.local, 0).as("a").select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{}] |
    And the decline should say "is ambiguous here: each Map may hold a key 'a' and a path label 'a' is also bound"

  @Unsupported
  Scenario: g_injectXa1_b2X_rangeXlocal_1_2X_asXaX_selectXaX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1, "b": 2]).range(Scope.local, 1, 2).as("a").select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"b":"d[2].i"}] |
    And the decline should say "is ambiguous here: each Map may hold a key 'a' and a path label 'a' is also bound"

  @Unsupported
  Scenario: g_injectXa1_b2X_skipXlocal_1X_asXbX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1, "b": 2]).skip(Scope.local, 1).as("b").select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a path label 'b' is also bound"

  # The same fact decides the label read inside a child body (an enclosing label) and behind math().
  @Unsupported
  Scenario: g_V_asXbX_localXconstantXa1_b2X_limitXlocal_1X_selectXbXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("b").local(__.constant(["a": 1, "b": 2]).limit(Scope.local, 1).select("b")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a path label 'b' is also bound"

  @Unsupported
  Scenario: g_V_valuesXageX_asXbX_constantXa1_b2X_limitXlocal_1X_mathXbX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").as("b").constant(["a": 1, "b": 2]).limit(Scope.local, 1).math("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29.0].d |
      | d[27.0].d |
      | d[32.0].d |
      | d[35.0].d |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a path label 'b' is also bound"

  # A key some rows MAY hold behind a same-named label: the rows lacking it read the label, which is an
  # element-or-value stream this route cannot frame yet — so the query declines rather than drop them.
  @Unsupported
  Scenario: g_V_asXageX_elementMapXageX_selectXageX
    Given the modern graph
    And the traversal of
      """
      g.V().as("age").elementMap("age").select("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |
      | v[lop] |
      | v[ripple] |
    And the decline should say "is ambiguous here: each Map may hold a key 'age' and a path label 'age' is also bound"

  # Literals whose entry ORDERS differ: the slice keeps `b` as a key a row may hold, so the label select declines.
  @Unsupported
  Scenario: g_injectXa1_b2X_b3_a4X_limitXlocal_1X_asXbX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1, "b": 2], ["b": 3, "a": 4]).limit(Scope.local, 1).as("b").select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"d[1].i"}] |
      | d[3].i |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a path label 'b' is also bound"

  # EVERY map-first reader reads the facts through the one `mayHoldKey`, not the chain select alone. After
  # a merge `b` is a key some rows only MAY hold; `format('%{b}')` reads the path label `b` for a row lacking it
  # (`FormatStep` → `getNullableScopeValue`), and reading the entry would DROP that row — so it declines.
  @Unsupported
  Scenario: g_injectX10X_asXbX_unionXconstantXa3X_constantXa1_b2XX_formatXbX
    Given the empty graph
    And the traversal of
      """
      g.inject(10).as("b").union(__.constant(["a": 3]), __.constant(["a": 1, "b": 2])).format("%{b}")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | 10 |
      | 2 |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a path label 'b' is also bound"

  @Unsupported
  Scenario: g_V_asXbX_unionXconstantXa3X_constantXa1_b2XX_formatXbX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("b").union(__.constant(["a": 3]), __.constant(["a": 1, "b": 2])).format("%{b}").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[12].l |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a path label 'b' is also bound"

  # A key every row holds beside a same-named label still declines: the key fact is a MAY set only.
  @Unsupported
  Scenario: g_injectX10X_asXbX_unionXconstantXa3_b5X_constantXa1_b2XX_formatXa_bX
    Given the empty graph
    And the traversal of
      """
      g.inject(10).as("b").union(__.constant(["a": 3, "b": 5]), __.constant(["a": 1, "b": 2])).format("%{a}-%{b}")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | 3-5 |
      | 1-2 |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a path label 'b' is also bound"

  # A keyed dedup over a merged map stream: `{a:3}` keys on its label `b` (10) and `{a:1,b:10}` on its entry
  # (10), so the two collide (`DedupGlobalStep` keys on `getSafeScopeValue`). An entry and a VALUE label
  # side by side never collide, so this declines rather than keep the duplicate — in either arm order.
  @Unsupported
  Scenario: g_injectX10X_asXbX_unionXconstantXa3X_constantXa1_b10XX_dedupXbX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(10).as("b").union(__.constant(["a": 3]), __.constant(["a": 1, "b": 10])).dedup("b").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a path label 'b' is also bound"

  @Unsupported
  Scenario: g_injectX10X_asXbX_unionXconstantXa1_b10X_constantXa3XX_dedupXbX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(10).as("b").union(__.constant(["a": 1, "b": 10]), __.constant(["a": 3])).dedup("b").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a path label 'b' is also bound"

  # Every row holds `b`, but beside the label `b` the keyed dedup still declines (a MAY set only).
  @Unsupported
  Scenario: g_injectX10X_asXbX_unionXconstantXa3_b10X_constantXa1_b10XX_dedupXbX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(10).as("b").union(__.constant(["a": 3, "b": 10]), __.constant(["a": 1, "b": 10])).dedup("b").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
    And the decline should say "is ambiguous here: each Map may hold a key 'b' and a path label 'b' is also bound"

  # A by(select(k)) child body over a map host reads the same facts: the row lacking `b` reads the label.
  # It pins no reason: a project() over a stream of Maps declines before any key fact is read
  # (`g.inject(["a": 1]).project("x").by(__.select("a"))`, with no label, declines too).
  @Unsupported
  Scenario: g_injectX10X_asXbX_unionXconstantXa3X_constantXa1_b2XX_projectXxX_byXselectXbXX
    Given the empty graph
    And the traversal of
      """
      g.inject(10).as("b").union(__.constant(["a": 3]), __.constant(["a": 1, "b": 2])).project("x").by(__.select("b"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[10].i"}] |
      | m[{"x":"d[2].i"}] |

  # A label read behind a local slice of a record, after a keyed dedup: the slice keeps `y` as a key a row
  # may hold, so the label collision declines.
  @Unsupported
  Scenario: g_V_asXxX_out_asXyX_selectXx_yX_dedupXxX_limitXlocal_1X_selectXyX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("x").out().as("y").select("x", "y").dedup("x").limit(Scope.local, 1).select("y").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the decline should say "is ambiguous here: each Map may hold a key 'y' and a path label 'y' is also bound"

  # REALISTIC COLLISIONS — a path label named like a property key. `valueMap()` and `project()` (whose
  # `by('name')` may be unproductive, `ProjectStep.java:66`) MAY hold `name`, so which scope answers would
  # depend on the row. The reference reads each row's entry; the decline names both and suggests a rename.
  @Unsupported
  Scenario: g_V_asXnameX_valueMap_selectXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("name").valueMap().select("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko] |
      | l[vadas] |
      | l[lop] |
      | l[josh] |
      | l[ripple] |
      | l[peter] |
    And the decline should say "select(\"name\") is ambiguous here: each Map may hold a key 'name' and a path label 'name' is also bound, so which one is read would depend on the row — rename the label (as('name1')) or the key"

  @Unsupported
  Scenario: g_V_asXnameX_projectXname_ageX_byXnameX_byXageX_selectXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("name").project("name", "age").by("name").by("age").select("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | lop |
      | josh |
      | ripple |
      | peter |
    And the decline should say "select(\"name\") is ambiguous here: each Map may hold a key 'name' and a path label 'name' is also bound"

  # The same collision with a side-effect constant, and inside a local() body.
  @Unsupported
  Scenario: g_withSideEffectXa_1X_V_constantXa1X_selectXaX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", 1).V().constant(["a": 1]).select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |
    And the decline should say "select(\"a\") is ambiguous here: each Map may hold a key 'a' and a side effect 'a' is also declared, so which one is read would depend on the row — rename the side effect (withSideEffect('a1', …)) or the key"

  @Unsupported
  Scenario: g_V_asXnameX_localXvalueMap_selectXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().as("name").local(__.valueMap().select("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko] |
      | l[vadas] |
      | l[lop] |
      | l[josh] |
      | l[ripple] |
      | l[peter] |
    And the decline should say "select(\"name\") is ambiguous here: each Map may hold a key 'name' and a path label 'name' is also bound"
