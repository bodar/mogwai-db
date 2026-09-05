Feature: mogwai addendum — local() carries its body frame out, plain flatMap() sheds it

  # `local()` and plain `flatMap()` read IDENTICAL to a Gremlin user but DIVERGE on what a body-bound
  # label / path position does at the boundary, and the fork is in vendor/tinkerpop/gremlin-core:
  #
  #   - LocalStep.processNextStart returns localTraversal.nextTraverser() — the child's FULL
  #     Traverser.Admin, path + labels intact (branch/LocalStep.java:60-67 -> Traversal.java:593-595).
  #     So a label bound inside a local() body ESCAPES to parent scope, and local(out().out()).path()
  #     is [v, mid, end] — the body's minted positions ARE the answer.
  #   - Plain flatMap unwraps to a bare value (Traversal.next()) and rebuilds from the PRE-child head
  #     via head.split (map/FlatMapStep.java:42-52 -> util/DefaultTraversal.java:220-230 ->
  #     Traverser.java:185-195), so a body-bound label is DROPPED and intermediate path objects are
  #     HIDDEN (map/FlatMap.feature:56).
  #
  # union/choose/repeat are on local's full-traverser-forward side (their own remap is a later
  # increment). This file pins the asymmetry; the fan-out rejoin authority plan
  # (docs/2026-09-05-fan-out-rejoin-authority-plan.md) owns it.

  # ---- local() CARRIES: a body-bound label reaches an outer select alongside an outer label ----

  Scenario: g_V_asXaX_localXoutXcreatedX_asXbXX_selectXa_bX_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").local(__.out("created").as("b")).select("a","b").by("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"marko","b":"lop"}] |
      | m[{"a":"josh","b":"lop"}] |
      | m[{"a":"josh","b":"ripple"}] |
      | m[{"a":"peter","b":"lop"}] |

  # ---- local() CARRIES: body path positions are NOT hidden ([v, mid, end]) ----

  Scenario: g_V_hasXname_markoX_localXout_outX_path_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").local(__.out().out()).path().by("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[marko,josh,ripple] |
      | p[marko,josh,lop] |

  # ---- plain flatMap() SHEDS a body-bound label: the outer select is the EMPTY result, not a wrong
  #      binding and not a decline ----

  Scenario: g_V_flatMapXoutXcreatedX_asXbXX_selectXbX
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out("created").as("b")).select("b")
      """
    When iterated to list
    Then the result should be empty

  # ---- plain flatMap() HIDES intermediate path positions — DEFERRED (the hide-N-positions node,
  #      plan Phase C2). Fail-closed today; drops this tag when it lands. Expected pins the target
  #      ([v, end], mid hidden). ----

  @Unsupported
  Scenario: g_V_hasXname_markoX_flatMapXout_outX_path_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").flatMap(__.out().out()).path().by("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[marko,ripple] |
      | p[marko,lop] |
