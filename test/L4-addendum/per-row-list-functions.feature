Feature: mogwai addendum — a list function over a per-row-typed stream decides per row

  # `combine`/`intersect`/`difference`/`disjunct`/`merge`/`product`/`conjoin` convert the TRAVERSER first
  # (`ListFunction.convertTraverserToCollection`): a List or Set row runs the step, a null row raises
  # "Incoming traverser for <step> step can't be null.", and any other row (a Map included) raises
  # "<step> step can only take an array or an Iterable type for incoming traversers"
  # (`perRowListFunction`, src/compiler/rel/lower.ts). A list-valued stored property is the plausible case.

  Scenario: g_V_valuesXtagsX_intersectXb_cX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a", "b", "c"]).addV("p").property("tags", ["b"])
      """
    And the traversal of
      """
      g.V().values("tags").intersect(["b", "c"])
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[b,c] |
      | s[b] |

  Scenario: g_V_valuesXtagsX_combineXzX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a", "b", "c"]).addV("p").property("tags", ["b"])
      """
    And the traversal of
      """
      g.V().values("tags").combine(["z"])
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[a,b,c,z] |
      | l[b,z] |

  Scenario: g_V_valuesXtagsX_conjoinX_X
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a", "b", "c"]).addV("p").property("tags", ["b"])
      """
    And the traversal of
      """
      g.V().values("tags").conjoin("-")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a-b-c |
      | b |

  Scenario: g_V_valuesXtagsX_differenceXaX_countXlocalX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a", "b", "c"]).addV("p").property("tags", ["a"])
      """
    And the traversal of
      """
      g.V().values("tags").difference(["a"]).count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[0].l |

  Scenario: g_V_localXvaluesXtagsX_intersectXb_cXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a", "b", "c"]).addV("p").property("tags", ["b"])
      """
    And the traversal of
      """
      g.V().local(__.values("tags").intersect(["b", "c"]).unfold()).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[b,c,b] |

  Scenario: g_V_unionXvaluesXtagsX_intersectXbX_valuesXtagsX_intersectXcXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a", "b", "c"]).addV("p").property("tags", ["b"])
      """
    And the traversal of
      """
      g.V().union(__.values("tags").intersect(["b"]), __.values("tags").intersect(["c"])).count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[0].l |

  Scenario: g_V_valuesXtagsX_asXaX_combineXqX_selectXaX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a", "b", "c"])
      """
    And the traversal of
      """
      g.V().values("tags").as("a").combine(["q"]).select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[a,b,c] |

  Scenario: g_V_valuesXnopeX_intersectXaX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a"])
      """
    And the traversal of
      """
      g.V().values("nope").intersect(["a"])
      """
    When iterated to list
    Then the result should be empty

  Scenario: g_V_valuesXtagsX_intersectXaX_mixed_rows
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a"]).addV("p").property("tags", "a")
      """
    And the traversal of
      """
      g.V().values("tags").intersect(["a"])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "intersect step can only take an array or an Iterable type for incoming traversers"

  Scenario: g_V_valuesXtagsX_mergeXqX_map_row
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["k": 1])
      """
    And the traversal of
      """
      g.V().values("tags").merge(["q"])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "merge step expected provided argument to evaluate to a Map"

  Scenario: g_injectX1_nullX_conjoinX_X
    Given the empty graph
    And the traversal of
      """
      g.inject(null).conjoin("-").count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Incoming traverser for conjoin step can't be null"

  # A list function inside a by()/where() body over the per-row-typed scalar itself (a scalar host) reads
  # the same per-row decision as at top level.
  Scenario: g_V_valuesXtagsX_orderXbyXintersectXaX_countXlocalXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a", "b", "c"]).addV("p").property("tags", ["b", "z"])
      """
    And the traversal of
      """
      g.V().values("tags").order().by(__.intersect(["a"]).count(local)).conjoin("")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | bz |
      | abc |

  Scenario: g_V_valuesXtagsX_groupXbyXconjoinX_XX_byXcountX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a", "b", "c"]).addV("p").property("tags", ["b", "z"]).addV("p").property("tags", ["b", "z"])
      """
    And the traversal of
      """
      g.V().values("tags").group().by(__.conjoin("-")).by(count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a-b-c":"d[1].l","b-z":"d[2].l"}] |

  Scenario: g_V_valuesXtagsX_whereXintersectXaX_countXlocalX_isX1XX_conjoinX_X
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a", "b", "c"]).addV("p").property("tags", ["b", "z"])
      """
    And the traversal of
      """
      g.V().values("tags").where(__.intersect(["a"]).count(local).is(1)).conjoin("")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | abc |

  # The non-collection row raises inside the body too: the self is converted before the step runs.
  Scenario: g_V_valuesXtagsX_orderXbyXconjoinX_XX_scalar_row
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a", "b"]).addV("p").property("tags", "solo")
      """
    And the traversal of
      """
      g.V().values("tags").order().by(__.conjoin(""))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "conjoin step can only take an array or an Iterable type for incoming traversers"

  # A per-row-typed OPERAND (another list-valued property) is decided on its first result.
  Scenario: g_V_hasXname_xX_valuesXtagsX_intersectXV_hasXname_yX_valuesXtagsXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("name", "x").property("tags", ["a", "b", "c"]).addV("p").property("name", "y").property("tags", ["b", "z"])
      """
    And the traversal of
      """
      g.V().has("name", "x").values("tags").intersect(__.V().has("name", "y").values("tags"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[b] |

  # The incoming traverser is converted BEFORE the operand: a non-collection row raises its own message
  # even where the operand is itself not a collection; a collection row raises the operand's.
  Scenario: g_V_valuesXtagsX_intersectX1X_scalar_row
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", "solo")
      """
    And the traversal of
      """
      g.V().values("tags").intersect(1)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "intersect step can only take an array or an Iterable type for incoming traversers"

  Scenario: g_V_valuesXtagsX_intersectX1X_list_row
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a"])
      """
    And the traversal of
      """
      g.V().values("tags").intersect(1)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "intersect step can only take an array or an Iterable as an argument"

  Scenario: g_V_valuesXtagsX_mergeXconstantXqXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("tags", ["a", "b"])
      """
    And the traversal of
      """
      g.V().values("tags").merge(__.constant(["q"]))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[a,b,q] |
