Feature: mogwai addendum — a REDUCING branch arm beside a STREAMING one, in either choose form

  # `ChooseStep` is a `BranchStep`: its options are GLOBAL children, so at top level a `count()`/`fold()`
  # option reduces over every traverser routed to it, and an option no start reached emits nothing
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:130-134).
  # Under `local()` the whole choose runs once per start
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/LocalStep.java:80-88),
  # so the same reduction is scoped to the entering traverser.
  #
  # The keyed form ALWAYS has a streaming arm beside its written ones whenever its choice can be
  # unproductive: `ChooseStep`'s constructor installs an identity for an unwritten `Pick.unproductive`
  # (and `Pick.none`) (…/step/branch/ChooseStep.java:71-79), so `choose(values('age')).option(k, fold())…`
  # merges a reduced arm with a pass-through of the traverser. That merge declined — the reduced arm had
  # shed `bulk` and the pass-through had not — while `union`'s mixed merge already reconciled the two.
  # Both choose forms now ask the one reconciliation (`reconcileCollapsed`, src/compiler/rel/lower/branch.ts).
  #
  # `map()` shares `flatMap()`'s rejoin where its body has at most one result per traverser
  # (`atMostOnePerTraverser`, src/compiler/rel/lower/reduction.ts): `TraversalMapStep` is `applyAll` then
  # the FIRST result (…/step/map/TraversalMapStep.java), which IS every result there. The arity is read
  # off the IR's one arity vocabulary (`ONE_TO_ONE`, src/compiler/ir/step.ts) and the collapse set, so it
  # composes through `choose`/`coalesce`/`optional`/`local`/`map` arms; a fan-out body has no "first"
  # without a window, and stays declined.

  Scenario: the boolean form at top level — a GLOBAL count() then-arm beside a constant else-arm
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.hasLabel("person"), __.out("knows").count(), __.constant(0L))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[0].l |
      | d[0].l |

  Scenario: the keyed form with only the implicit pass-throughs beside one reducing option
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.label()).option("person", __.out().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | v[lop] |
      | v[ripple] |

  Scenario: map() over a boolean choose of two fold() arms is one list per start
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").map(__.choose(__.values("age").is(P.gt(30)), __.out().values("name").order().fold(), __.in().values("name").fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[lop,ripple] |
      | l[lop] |
      | l[] |
      | l[marko] |

  Scenario: map() over a keyed range option beside Pick.none, each arm a fold()
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").map(__.choose(__.values("age")).option(P.gt(30), __.out().values("name").order().fold()).option(Pick.none, __.in().values("name").fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[lop,ripple] |
      | l[lop] |
      | l[] |
      | l[marko] |

  Scenario: map() over a fold() then a local op keeps one result per start, and feeds a later dedup
    Given the modern graph
    And the traversal of
      """
      g.V().out().map(__.in().values("name").fold().dedup(Scope.local).count(Scope.local)).dedup()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[3].l |

  # A FAN-OUT map body takes its FIRST result — a per-start window with no order to read it by. It is not
  # the rejoin, so it declines.
  @Unsupported
  Scenario: map() over a fan-out body still declines
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.out()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  Scenario: a keyed option count() reduces over every start routed to it, Pick.none likewise
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(__.values("age")).option(29, __.out().count()).option(Pick.none, __.out().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | d[3].l |

  Scenario: a keyed option count() beside the implicit pass-through of an unmatched start
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(__.values("age")).option(29, __.out().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | v[vadas] |
      | v[josh] |
      | v[peter] |

  Scenario: a keyed option no start was routed to emits no seed
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(__.values("age")).option(29, __.out().count()).option(30, __.in().fold()).option(Pick.none, __.values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | vadas |
      | josh |
      | peter |

  Scenario: a keyed reducing choose over no starts is empty
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("nope").choose(__.values("age")).option(29, __.out().count()).option(Pick.none, __.out().count())
      """
    When iterated to list
    Then the result should be empty

  Scenario: under local() a keyed fold() option reduces per start, and an unproductive choice passes the vertex through
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.choose(__.values("age")).option(29, __.out().values("name").order().fold()).option(Pick.none, __.in().values("name").fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[josh,lop,vadas] |
      | l[marko] |
      | l[marko] |
      | l[] |
      | v[lop] |
      | v[ripple] |

  Scenario: under map() the same body answers what local() does, one result per start
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.choose(__.values("age")).option(29, __.out().values("name").order().fold()).option(Pick.none, __.in().values("name").fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[josh,lop,vadas] |
      | l[marko] |
      | l[marko] |
      | l[] |
      | v[lop] |
      | v[ripple] |

  Scenario: a per-start keyed reduction feeds a later count()
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.choose(__.values("age")).option(29, __.out().values("name").fold()).option(Pick.none, __.in().values("name").fold())).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: a keyed range option fold() beside a streaming Pick.none
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(__.values("age")).option(P.lt(30), __.values("name").order().fold()).option(Pick.none, __.values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,vadas] |
      | josh |
      | peter |

  Scenario: the boolean form — a count() then-arm beside a streaming else-arm
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(__.values("age").is(P.gt(30)), __.out().count(), __.values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | marko |
      | vadas |

  Scenario: the boolean form — a fold() then-arm beside the absent else's identity
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(__.values("age").is(P.gt(30)), __.values("name").order().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[josh,peter] |
      | v[marko] |
      | v[vadas] |

  # A per-start count() inside a local() rejoin keeps no per-start key yet, so beside the pass-through it
  # cannot merge; it DECLINES rather than count across every start. All-reducing options under local()
  # answer through the per-row CASE (`scalarChooseOptions`) and are unaffected.
  @Unsupported
  Scenario: under local() a keyed count() option beside the pass-through still declines
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").local(__.choose(__.values("age")).option(29, __.out().count()).option(Pick.none, __.out().count()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | d[0].l |
      | d[2].l |
      | d[1].l |
