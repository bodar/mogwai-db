Feature: mogwai addendum — a project() record is the traverser's MAP, the first scope select() reads

  # `Scoping.getScopeValue` returns `map.get(key)` for a key the traverser's own Map contains BEFORE it
  # asks the side effects or the path, ignoring the Pop
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135).
  # A `project()` record IS that Map, so every select() arity — multi-key (SelectStep.java:68-80), a Pop,
  # a by()-modulated SelectOneStep (SelectOneStep.java:61-71) — reads its FIELDS first. These all answered
  # the EMPTY result: only a bare single-key select consulted the fields; everything else looked for path
  # labels, found none, and dropped the traverser.
  #
  # And a record's map holds its element fields as ELEMENT nodes: decoding one into the scalar vocabulary
  # framed the vertex as a JSON string, or failed to parse (an internal error L5 drew). The map's value
  # side is now stated by ONE authority (`recordValOf`, src/compiler/rel/record.ts), and a reader that would
  # decode an element node declines. Each @Unsupported scenario carries the reference answer.

  Scenario: g_VX1X_projectXx_yX_byXconstantX1XX_byXconstantX2XX_selectXx_yX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x","y").by(__.constant(1)).by(__.constant(2)).select("x","y")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":1,"y":2}] |

  # The map read ignores the Pop: a map key has no history.
  Scenario: g_VX1X_projectXx_yX_byXconstantX1XX_byXconstantX2XX_selectXall_yX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x","y").by(__.constant(1)).by(__.constant(2)).select(Pop.all, "y")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  Scenario: g_VX1X_projectXx_yX_byXconstantX1XX_byXconstantX2XX_selectXyX_byXconstantX5XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x","y").by(__.constant(1)).by(__.constant(2)).select("y").by(__.constant(5))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |

  # A by() that yields a NULL is ABSENT (presence is value nullness), so the record lacks "y" and the
  # select drops the traverser (a documented divergence: the reference keeps a present-null key).
  Scenario: g_VX1X_projectXx_yX_byXconstantX1XX_byXconstantXlist_nullX_unfold_sumX_selectXx_yX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x","y").by(__.constant(1)).by(__.constant([null]).unfold().sum()).select("x","y")
      """
    When iterated to list
    Then the result should be empty

  # A field and a path label in one select: the field from the map, the label from the path.
  Scenario: g_VX1X_asXzX_projectXa_bX_byXidentityX_byXnameX_selectXa_zX
    Given the modern graph
    And the traversal of
      """
      g.V(1).as("z").project("a","b").by(__.identity()).by("name").select("a","z")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"v[marko]","z":"v[marko]"}] |

  # The map is consulted before the side effects.
  Scenario: g_withSideEffectXa_5X_VX1X_projectXa_bX_byXconstantX1XX_byXnameX_selectXa_bX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a",5).V(1).project("a","b").by(__.constant(1)).by("name").select("a","b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":1,"b":"marko"}] |

  Scenario: g_V_projectXa_bX_byXageX_byXnameX_selectXaX_byXisXgtX30XXX
    Given the modern graph
    And the traversal of
      """
      g.V().project("a","b").by(__.values("age")).by("name").select("a").by(__.is(P.gt(30)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |
      | d[35].i |

  # An ELEMENT field read back out of the record's MAP (after fold/unfold) is the vertex, not its JSON.
  @Unsupported
  Scenario: g_VX1X_projectXa_bX_byXidentityX_byXidentityX_fold_unfold_selectXbX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("a","b").by(__.identity()).by(__.identity()).fold().unfold().select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[marko] |

  # The L5 draw (seed 0x84ce2d9) that surfaced the internal error.
  @Unsupported
  Scenario: g_VX1X_projectXa_bX_byXidentityX_byXlocalXidentityXX_dedup_fold_orderXlocalX_unfold_selectXbX_fold
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("a","b").by(__.identity()).by(__.local(__.identity())).dedup().fold().order(Scope.local).unfold().select("b").fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[v[marko]] |

  @Unsupported
  Scenario: g_VX1X_projectXa_bX_byXidentityX_byXnameX_unfold_selectXvaluesX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("a","b").by(__.identity()).by("name").unfold().select(Column.values)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[marko] |
      | marko |

  @Unsupported
  Scenario: g_VX1X_unionXprojectXaX_byXidentityX__projectXbX_byXnameXX_selectXaX
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.project("a").by(__.identity()), __.project("b").by("name")).select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[marko] |

  # The record's map still FRAMES every element node by its own tag.
  Scenario: g_VX1X_projectXa_bX_byXidentityX_byXnameX_fold_unfold
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("a","b").by(__.identity()).by("name").fold().unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"v[marko]","b":"marko"}] |

  # A pooled group's MAP members re-enter as MAPS (the root encoding a `{kind:'map'}` list member means),
  # so a key read after unfolding the value reads the member's key. Was `[]`: the members re-entered as
  # per-row scalars, which no select() can see into.
  Scenario: g_V_group_byXlabelX_byXprojectXaX_byXnameX_foldX_selectXsoftwareX_unfold_selectXaX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.project("a").by("name").fold()).select("software").unfold().select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | ripple |

  Scenario: g_V_group_byXlabelX_byXvalueMapXnameX_foldX_selectXsoftwareX_unfold_selectXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.valueMap("name").fold()).select("software").unfold().select("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[lop] |
      | l[ripple] |

  # A per-row-typed value may be a Map at run time, and then it is the first scope: the alias map cannot
  # prove the EMPTY answer, so the read declines (was `[]`).
  @Unsupported
  Scenario: g_VX1X_projectXaX_byXprojectXbX_byXnameXX_fold_unfold_selectXaX_selectXbX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("a").by(__.project("b").by("name")).fold().unfold().select("a").select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |

  # THE TRAVERSER'S OWN MAP WINS. A key the Map holds is read from the Map, never from a same-named side
  # effect or path label; a key the Map LACKS drops the row, even where a side effect or path label of
  # that name exists. The reference falls through to those scopes per row (Scoping.java:120-131) — a
  # deliberate divergence (docs/feature-support-matrix.md): "select k from this map" reads this map.
  Scenario: g_VX1X_out_asXxX_projectXxX_byXageX_selectXxX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().as("x").project("x").by("age").select("x")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[27].i |
      | d[32].i |

  Scenario: g_VX1X_out_asXxX_projectXx_nX_byXageX_byXnameX_selectXx_nX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().as("x").project("x","n").by("age").by("name").select("x","n")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[27].i","n":"vadas"}] |
      | m[{"x":"d[32].i","n":"josh"}] |

  Scenario: g_withSideEffectXx_7X_VX1X_projectXxX_byXnopeX_selectXxX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("x",7).V(1).project("x").by("nope").select("x")
      """
    When iterated to list
    Then the result should be empty

  Scenario: g_withSideEffectXx_7X_VX1X_out_projectXxX_byXageX_formatXxX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("x",7).V(1).out().project("x").by("age").format("%{x}")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | 27 |
      | 32 |

  Scenario: g_withSideEffectXage_7X_VX1X_out_elementMapXageX_selectXageX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("age",7).V(1).out().elementMap("age").select("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[27].i |
      | d[32].i |

  Scenario: g_VX1X_groupXaX_byXconstantXbXX_byXnameX_barrier_selectXaX_selectXaX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group("a").by(__.constant("b")).by(__.values("name")).barrier().select("a").select("a")
      """
    When iterated to list
    Then the result should be empty

  # math() reads a PRESENT field, never the side effect behind it (`mapScopeMayHold`): [8,8] was wrong.
  Scenario: g_withSideEffectXx_7X_VX1X_out_hasLabelXpersonX_projectXxX_byXageX_mathXx_plus_1X
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("x",7).V(1).out().hasLabel("person").project("x").by("age").math("x + 1")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[28].d |
      | d[33].d |

  # A where()/keyed dedup() scope key naming a FIELD reads the field. The alias readers read the path
  # label, so the where() declines (it compared the as() vertices, answering 0); the keyed dedup() reads
  # the field itself (it answered 3 over the vertices).
  @Unsupported
  Scenario: g_V_asXaX_out_asXbX_projectXa_bX_byXconstantX1XX_byXconstantX1XX_whereXa_eqXbXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().as("b").project("a","b").by(__.constant(1)).by(__.constant(1)).where("a", P.eq("b")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_asXaX_out_asXbX_projectXa_bX_byXconstantX1XX_byXconstantX1XX_dedupXaX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().as("b").project("a","b").by(__.constant(1)).by(__.constant(1)).dedup("a").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  # Where NO other scope binds the name, the absent key is still the KeyNotFoundException drop.
  Scenario: g_VX1X_out_projectXxX_byXageX_selectXxX_byXconstantX1XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().project("x").by("age").select("x").by(__.constant(1))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[1].i |

  Scenario: g_VX1X_out_projectXx_nX_byXageX_byXnameX_selectXx_nX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().project("x","n").by("age").by("name").select("x","n")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[27].i","n":"vadas"}] |
      | m[{"x":"d[32].i","n":"josh"}] |

  Scenario: g_VX1X_out_projectXxX_byXageX_formatXxX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().project("x").by("age").format("%{x}")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | 27 |
      | 32 |
