Feature: mogwai addendum — a SOURCE g.union(…) whose arms do not re-source runs over the one starter traverser

  # `UnionStep` with `isStart` generates ONE starter traverser (bulk 1, path dropped), hands it to every
  # arm, and skips any arm output that is still the starter
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/UnionStep.java:71-92).
  # An arm that OPENS with a map that never emits its input — `constant(c)` — therefore emits once, and
  # the whole step is the chain-position union over a one-row relation: `g.union(a, b)` answers what
  # `g.inject(x).union(a, b)` does, single arms, reduction arms, the scalar meet and variants included.
  # `g.union()` has no arm and emits nothing.
  #
  # An arm whose first step could hand the starter back (identity, a filter, `as()`, `sack()`, a nested
  # branch) DECLINES: the reference skips that output at run time, and the compile-time refusal is the
  # fail-closed answer. So does an arm that re-sources beside a starter arm — the same channel-agreement
  # gap the chain-position union has.

  Scenario: g_unionXX_count
    Given the modern graph
    And the traversal of
      """
      g.union().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  Scenario: g_unionXX_fold
    Given the modern graph
    And the traversal of
      """
      g.union().fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[] |

  Scenario: g_unionXconstantX1X_constantX2_0XX_fold
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1), __.constant(2.0d)).fold()
      """
    # The two arms meet at a per-row type: an int and a double, each its own class.
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[1].i,d[2.0].d] |

  Scenario: g_unionXconstantX1XX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  Scenario: g_unionXconstantXmapX_constantXmapXX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant([a:1]), __.constant([b:2]))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"d[1].i"}] |
      | m[{"b":"d[2].i"}] |

  Scenario: g_unionXconstantX1X_fold__constantX2XX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).fold(), __.constant(2))
      """
    # A reduction arm beside a streaming one: a list and a scalar in one stream.
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[1].i] |
      | d[2].i |

  Scenario: g_unionXconstantX1X_count__constantX2X_countX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).count(), __.constant(2).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |

  Scenario: g_withSackX1X_unionXconstantX1X_sackXsumX_sack__constantX5XX
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).union(__.constant(1).sack(Operator.sum).sack(), __.constant(5))
      """
    # The starter is seeded with the sack like any source traverser: 1 + 1.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |
      | d[5].i |

  Scenario: g_unionXconstantX2X_constantX1XX_fold
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(2), __.constant(1)).fold()
      """
    # One starter, so arm order is the emission order.
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[2].i,d[1].i] |

  Scenario: g_unionXconstantX1X_V_name__X
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).V().values("name")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_VX1X_localXunionXconstantX1X_constantX2XX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.union(__.constant(1), __.constant(2)).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[1].i,d[2].i] |

  Scenario: g_unionXconstantX1X_constantX2XX_asXxX_selectXxX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1), __.constant(2)).as("x").select("x")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[2].i |

  @Unsupported
  Scenario: g_unionXidentityX
    Given the modern graph
    And the traversal of
      """
      g.union(__.identity())
      """
    # The identity arm hands the starter back, which the reference skips: empty.
    When iterated to list
    Then the result should be empty

  @Unsupported
  Scenario: g_unionXconstantX1X_VX1X_nameX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1), __.V(1).values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | marko |

  # A label an ARM binds is on the traverser that arm emits (`UnionStep` forwards the arm's traverser,
  # path and all), so a read downstream sees it — exactly as `g.inject(0).union(…)` does.
  Scenario: g_unionXconstantX1X_constantX2X_asXaXX_selectXaX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1), __.constant(2).as("a")).select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  Scenario: g_unionXconstantX1X_asXaX_constantX2X_asXaXX_selectXlast_aX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).as("a"), __.constant(2).as("a")).select(Pop.last, "a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[2].i |

  Scenario: g_unionXconstantX1X_asXaXX_constantX5X_selectXaX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).as("a")).constant(5).select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  Scenario: g_unionXconstantX1X_asXaX_V_nameXmarkoX__constantX1X_asXaX_V_nameXvadasXX_selectXaX_count
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).as("a").V().has("name", "marko"), __.constant(1).as("a").V().has("name", "vadas")).select("a").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  Scenario: g_unionXconstantX1X_asXaX_constantX2XX_unionXselectXaX_constantX3XX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).as("a"), __.constant(2)).union(__.select("a"), __.constant(3))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[3].i |
      | d[3].i |

  # A label only SOME rows bind is a presence test in a filter body: `select('a')` emits nothing where
  # `a` is absent (`SelectOneStep`), so `where` keeps the bound row and `not` the other.
  Scenario: g_unionXconstantX1X_asXaX_constantX2XX_whereXselectXaXX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).as("a"), __.constant(2)).where(__.select("a"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  Scenario: g_unionXconstantX1X_asXaX_constantX2XX_notXselectXaXX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).as("a"), __.constant(2)).not(__.select("a"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  Scenario: g_VXmarkoX_unionXidentity_asXaX_outX_whereXselectXaX_hasXage_gtX20XXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.identity().as("a"), __.out()).where(__.select("a").has("age", P.gt(20))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_VXmarkoX_unionXidentity_asXaX_outX_notXselectXaX_hasXage_gtX40XXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.identity().as("a"), __.out()).not(__.select("a").has("age", P.gt(40))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |

  # A ROOTED arm is lowered whole and carries no alias channel out, so a downstream read of a label it
  # bound DECLINES (the reference answers marko and vadas) rather than answer the unbound key's empty.
  @Unsupported
  Scenario: g_unionXV_nameXmarkoX_asXaX__V_nameXvadasX_asXaXX_selectXaX_name
    Given the modern graph
    And the traversal of
      """
      g.union(__.V().has("name", "marko").as("a"), __.V().has("name", "vadas").as("a")).select("a").values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |

  # A label only SOME rows bind, read in a MAP/LOCAL/FLATMAP body: `select('a')` emits nothing where `a`
  # is absent (`SelectOneStep`), and `TraversalMapStep` drops a traverser whose child yields nothing — so
  # the unbound row contributes neither a row nor a null. A tail past the select is gated the same way.
  Scenario: g_unionXconstantX1X_asXaX_constantX2XX_mapXselectXaXX_count
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).as("a"), __.constant(2)).map(__.select("a")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_unionXconstantX1X_asXaX_constantX2XX_localXselectXaXX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).as("a"), __.constant(2)).local(__.select("a"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  Scenario: g_unionXconstantX1X_asXaX_constantX2XX_flatMapXselectXaXX_fold
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).as("a"), __.constant(2)).flatMap(__.select("a")).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[1].i] |

  Scenario: g_unionXconstantX1X_asXaX_V_nameXmarkoX__constantX2X_V_nameXvadasXX_mapXselectXaXX_count
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).as("a").V().has("name", "marko"), __.constant(2).V().has("name", "vadas")).map(__.select("a")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_VXmarkoX_unionXidentity_asXaX_outX_mapXselectXaXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.identity().as("a"), __.out()).map(__.select("a")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_injectX0X_unionXconstantX1X_asXaX_constantX2XX_mapXselectXaX_constantX5XX
    Given the modern graph
    And the traversal of
      """
      g.inject(0).union(__.constant(1).as("a"), __.constant(2)).map(__.select("a").constant(5))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |

  Scenario: g_injectX0X_unionXconstantX1X_asXaX_constantX2XX_mapXselectXaX_mathX_plus1XX
    Given the modern graph
    And the traversal of
      """
      g.inject(0).union(__.constant(1).as("a"), __.constant(2)).map(__.select("a").math("_ + 1"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].d |

  Scenario: g_VXmarkoX_unionXidentity_asXaX_outX_mapXselectXaX_labelX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.identity().as("a"), __.out()).map(__.select("a").label())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | person |

  Scenario: g_injectX0X_unionXconstantX1X_asXaX_constantX2XX_projectXxX_byXselectXaX_constantX5XX
    Given the modern graph
    And the traversal of
      """
      g.inject(0).union(__.constant(1).as("a"), __.constant(2)).project("x").by(__.select("a").constant(5))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[5].i"}] |
      | m[{}] |

  Scenario: g_V_optionalXout_asXaXX_mapXselectXaXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).map(__.select("a")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  # The same family in a FILTER body whose select is followed by a tail that ignores its subject: the
  # leg is gated on the label's presence under either polarity.
  Scenario: g_V_optionalXout_asXaXX_whereXselectXaX_labelX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).where(__.select("a").label()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_optionalXout_asXaXX_notXselectXaX_labelX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).not(__.select("a").label()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  Scenario: g_injectX0X_unionXconstantX1X_asXaX_constantX2XX_notXselectXaX_constantX1XX
    Given the modern graph
    And the traversal of
      """
      g.inject(0).union(__.constant(1).as("a"), __.constant(2)).not(__.select("a").constant(1))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  # A SEEDED reducing tail after a partially-bound select (the parked defects 1/2 of the first landing):
  # an absent key makes `SelectOneStep` emit nothing, and the reducer still emits its SEED over that
  # empty input (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/ReducingBarrierStep.java)
  # — 0 for `count`, `[]` for `fold`. The presence authority empties the rerooted body's INPUT
  # (`hostPresence`/`gatedByHost`), never its output, so every consumer sees the seed.
  Scenario: g_VXmarkoX_unionXidentity_asXaX_outX_mapXselectXaX_out_countX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.identity().as("a"), __.out()).map(__.select("a").out().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | d[0].l |
      | d[0].l |
      | d[0].l |

  Scenario: g_VXmarkoX_unionXidentity_asXaX_outX_whereXselectXaX_name_count_isX0XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.identity().as("a"), __.out()).where(__.select("a").values("name").count().is(0)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  Scenario: g_V_optionalXout_asXaXX_whereXselectXaX_name_count_isX0XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).where(__.select("a").values("name").count().is(0)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  Scenario: g_V_optionalXout_asXaXX_whereXselectXaX_out_count_isX0XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).where(__.select("a").out().count().is(0)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[8].l |

  Scenario: g_V_optionalXout_asXaXX_notXselectXaX_out_count_isX0XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).not(__.select("a").out().count().is(0)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_V_optionalXout_asXaXX_mapXselectXaX_name_countX_isX0X_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).map(__.select("a").values("name").count()).is(0).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  Scenario: g_V_optionalXout_asXaXX_mapXselectXaX_name_foldX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).map(__.select("a").values("name").fold()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9].l |

  Scenario: g_V_optionalXout_asXaXX_orderXbyXselectXaX_out_countXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).order().by(__.select("a").out().count()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9].l |

  Scenario: g_V_optionalXout_asXaXX_groupXbyXselectXaX_out_countX_byXcountXX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).group().by(__.select("a").out().count()).by(__.count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"d[0].l":"d[8].l","d[2].l":"d[1].l"}] |

  Scenario: g_V_optionalXout_asXaXX_projectXxX_byXselectXaX_out_countXX_selectXxX_isX0X_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).project("x").by(__.select("a").out().count()).select("x").is(0).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[8].l |

  Scenario: g_V_chooseXhasLabelXpersonX_asXaX_identityX_mapXselectXaX_out_countX_count
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.hasLabel("person"), __.as("a"), __.identity()).map(__.select("a").out().count()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  # A label bound inside a STARTER arm and read downstream answers exactly what the `inject(0)` oracle
  # does: the starter's own value is never observed.
  Scenario: g_injectX0X_unionXconstantX1X_constantX2X_asXaXX_selectXaX
    Given the modern graph
    And the traversal of
      """
      g.inject(0).union(__.constant(1), __.constant(2).as("a")).select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  Scenario: g_unionXconstantX1X_asXaX_constantX2X_asXaXX_selectXaX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).as("a"), __.constant(2).as("a")).select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[2].i |

  # `ProjectStep` omits a key whose by() child is unproductive.
  Scenario: g_unionXconstantX1X_asXaX_constantX2XX_projectXxX_byXselectXaXX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).as("a"), __.constant(2)).project("x").by(__.select("a"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[1].i"}] |
      | m[{}] |

  Scenario: g_unionXconstantX1X_asXaX_constantX2X_asXbXX_selectXa_bX
    Given the modern graph
    And the traversal of
      """
      g.union(__.constant(1).as("a"), __.constant(2).as("b")).select("a", "b")
      """
    When iterated to list
    Then the result should be empty

  # A ROOTED arm that ENDS in `match()` emits the binding MAP, so a downstream `select()` of a match
  # variable reads that map's key — the map scope wins over the path (`Scoping.getScopeValue`,
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java).
  Scenario: g_unionXV_nameXmarkoX_matchXasXxX_out_asXyXXX_selectXyX_name
    Given the modern graph
    And the traversal of
      """
      g.union(__.V().has("name", "marko").match(__.as("x").out().as("y"))).select("y").values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
      | lop |

  # A downstream string that is a VALUE, not a scope key, is no label read: a rooted arm's label is not
  # observed by `constant('a')` or `has('name','a')`.
  Scenario: g_unionXV_nameXmarkoX_asXaXX_constantXaX
    Given the modern graph
    And the traversal of
      """
      g.union(__.V().has("name", "marko").as("a")).constant("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |

  Scenario: g_unionXV_asXaXX_hasXname_aX_count
    Given the modern graph
    And the traversal of
      """
      g.union(__.V().as("a"), __.V().as("a")).has("name", "a").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |
