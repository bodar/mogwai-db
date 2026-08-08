# mogwai addendum — SET rendering of T.label, and the label-less vertex it makes ordinary.
#
# These were COPIED VERBATIM from gremlin-test (map/ElementMap.feature, map/ValueMap.feature), where
# they carry @MultiLabel @MultiLabelDefault, and they pinned a claim we no longer make: that the
# GRAPH's declared cardinality decides the rendering, so a multi-label graph renders `s[…]` without
# being asked.
#
# THAT CLAIM WAS WITHDRAWN WHEN STORAGE AND RENDERING WERE SPLIT (src/api.ts). Every mogwai-db vertex
# now carries a label SET, so "the graph's cardinality decides" would mean `s[…]` for everyone — which
# is a wire-shape change for every user of `elementMap()`, to express a presentation choice. So
# `labelRegime` defaults to `single`, which is also the REFERENCE's (`TraversalHelper
# .isMultilabelEnabled` reads the `with()` option and nothing else, `.orElse(false)`). We agree with
# upstream now rather than diverging from it, and `@MultiLabelDefault` describes a provider we no
# longer are — see docs/outstanding-work.md item 19b, whose premise this change removes.
#
# What survives is the BEHAVIOUR, asked for explicitly. Each scenario below now says
# `g.with("multilabel")`, and every assertion is unchanged — set rendering, the single-label vertex
# rendered as a one-element set, and the ZERO-label vertex rendered as `s[]`. That last one matters
# more than it did: a label-less vertex used to need a special graph and is now what a bare
# `g.addV()` produces.
#
# The two `g.with("singlelabel")` scenarios are kept as they are. They now assert the DEFAULT rather
# than an override, which costs nothing and keeps the pair readable side by side.
#
# The edge scenario (`g_E_elementMap_multi_label_default`) is still absent — elementMap() on edges
# needs the IN/OUT direction tokens, an unrelated gap.
@gap:multilabel-default @MultiLabel
Feature: Step - elementMap()/valueMap() default label rendering

  Scenario: g_withXmultilabelX_V_elementMap
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").addLabel("employee").property("name", "marko")
      """
    And the traversal of
      """
      g.with("multilabel").V().elementMap()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"t[id]": "v[marko].id", "t[label]": "s[person,employee]", "name": "marko"}] |

  Scenario: g_withXsinglelabelX_V_elementMap
    Given the zoo graph
    And the traversal of
      """
      g.with("singlelabel").V().has("name", "lagoon").elementMap("name", "biome")
      """
    When iterated to list
    Then the result should have a count of 1
    And the result should be of
      | result |
      | m[{"t[id]": "v[lagoon].id", "t[label]": "habitat", "name": "lagoon", "biome": "marine"}] |
      | m[{"t[id]": "v[lagoon].id", "t[label]": "aquatic", "name": "lagoon", "biome": "marine"}] |

  Scenario: g_withXmultilabelX_V_elementMap_single_label_vertex
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko")
      """
    And the traversal of
      """
      g.with("multilabel").V().elementMap()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"t[id]": "v[marko].id", "t[label]": "s[person]", "name": "marko"}] |

  Scenario: g_withXmultilabelX_V_elementMap_zero_label_vertex
    Given the empty graph
    And the graph initializer of
      """
      g.addV().property("name", "nobody")
      """
    And the traversal of
      """
      g.with("multilabel").V().elementMap()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"t[id]": "v[nobody].id", "t[label]": "s[]", "name": "nobody"}] |

  Scenario: g_withXmultilabelX_V_valueMap_withXtokensX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").addLabel("employee").property("name", "marko")
      """
    And the traversal of
      """
      g.with("multilabel").V().valueMap().with(WithOptions.tokens)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"t[id]": "v[marko].id", "t[label]": "s[person,employee]", "name": ["marko"]}] |

  Scenario: g_withXsinglelabelX_V_valueMap_withXtokensX
    Given the zoo graph
    And the traversal of
      """
      g.with("singlelabel").V().has("name", "lagoon").valueMap("name", "biome").with(WithOptions.tokens)
      """
    When iterated to list
    Then the result should have a count of 1
    And the result should be of
      | result |
      | m[{"t[id]": "v[lagoon].id", "t[label]": "habitat", "name": ["lagoon"], "biome": ["marine"]}] |
      | m[{"t[id]": "v[lagoon].id", "t[label]": "aquatic", "name": ["lagoon"], "biome": ["marine"]}] |

  Scenario: g_withXmultilabelX_V_valueMapXtrueX_zero_label_vertex
    Given the empty graph
    And the graph initializer of
      """
      g.addV().property("name", "nobody")
      """
    And the traversal of
      """
      g.with("multilabel").V().valueMap(true)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"t[id]": "v[nobody].id", "t[label]": "s[]", "name": ["nobody"]}] |

