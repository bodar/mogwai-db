# mogwai addendum — the multi-label DEFAULT rendering of T.label.
#
# These are COPIED VERBATIM from gremlin-test (map/ElementMap.feature, map/ValueMap.feature),
# where they carry @MultiLabel @MultiLabelDefault. Every GLV skips that tag, so upstream ships
# them and no implementation can execute them: TraversalHelper.isMultilabelEnabled reads the
# source-level with() option and nothing else (`.orElse(false)`), so the reference default is
# always single-label and there is no graph-level knob. See docs/outstanding-work.md item 19b and
# docs/upstream-patches/03-multilabel-default-untestable.md.
#
# We DO implement the behaviour, so L4 is where it becomes floor rather than an untested claim.
# They are unmodified so the @gap family harvests straight back into a gremlin-test PR — which is
# the whole point of L4 being real Gherkin.
#
# TWO of the eleven are deliberately NOT here, and the reason is a real semantic difference rather
# than a gap: `g_V_elementMap_single_label_only_graph_multi_label_default` and its valueMap twin run
# on the MODERN graph — a single-label graph — and expect `s[person]`, i.e. a set even where the
# graph can only ever hold one label. Our default follows the GRAPH's declared cardinality
# (`labelRegime`, src/api.ts): a multi-label graph renders a set, a single-label graph renders a
# plain string. That is the rule our own upstream proposal argues for, and it keeps
# `g.V().elementMap()` on an ordinary graph looking the way TinkerPop 3 users expect. Recording the
# divergence here rather than bending either side.
#
# The edge scenario (`g_E_elementMap_multi_label_default`) is also absent — elementMap() on edges
# needs the IN/OUT direction tokens, an unrelated gap.
@gap:multilabel-default @MultiLabel
Feature: Step - elementMap()/valueMap() default label rendering

  Scenario: g_V_elementMap_multi_label_default
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").addLabel("employee").property("name", "marko")
      """
    And the traversal of
      """
      g.V().elementMap()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"t[id]": "v[marko].id", "t[label]": "s[person,employee]", "name": "marko"}] |

  Scenario: g_withXsinglelabelX_V_elementMap_multi_label_default
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

  Scenario: g_V_elementMap_single_label_vertex_multi_label_default
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko")
      """
    And the traversal of
      """
      g.V().elementMap()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"t[id]": "v[marko].id", "t[label]": "s[person]", "name": "marko"}] |

  Scenario: g_V_elementMap_zero_label_vertex_multi_label_default
    Given the empty graph
    And the graph initializer of
      """
      g.addV().property("name", "nobody")
      """
    And the traversal of
      """
      g.V().elementMap()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"t[id]": "v[nobody].id", "t[label]": "s[]", "name": "nobody"}] |

  Scenario: g_V_valueMap_withXtokensX_multi_label_default
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").addLabel("employee").property("name", "marko")
      """
    And the traversal of
      """
      g.V().valueMap().with(WithOptions.tokens)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"t[id]": "v[marko].id", "t[label]": "s[person,employee]", "name": ["marko"]}] |

  Scenario: g_withXsinglelabelX_V_valueMap_withXtokensX_multi_label_default
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

  Scenario: g_V_valueMapXtrueX_zero_label_vertex_multi_label_default
    Given the empty graph
    And the graph initializer of
      """
      g.addV().property("name", "nobody")
      """
    And the traversal of
      """
      g.V().valueMap(true)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"t[id]": "v[nobody].id", "t[label]": "s[]", "name": ["nobody"]}] |

