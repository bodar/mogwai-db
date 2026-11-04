Feature: mogwai addendum — merge() over a Map is a per-traverser putAll

  # `MergeStep.map` (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/
  # traversal/step/map/MergeStep.java:76-88) takes its OWN arm for a Map traverser before any collection
  # conversion: `new HashMap(incoming).putAll(operand)`, so the argument wins a shared key, and an operand
  # that is not a Map raises "expected provided argument to evaluate to a Map". The corpus pins only the
  # top-level forms (Merge.feature); these pin the putAll key rule and the shape at depth — a record
  # (`project()`), a shared key, a chained merge, inside `local()`, after `as()/select()`, in a `union` arm,
  # a list-valued `valueMap()` operand, and the unproductive operand's `TraversalUtil.apply` raise.

  Scenario: g_VX1X_projectXname_ageX_mergeXage_zX_argument_wins_a_shared_key
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").project("name","age").by("name").by("age").merge(["age":99i,"z":1i])
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"name":"marko","age":99,"z":1}] |

  Scenario: g_VX1X_elementMapXnameX_mergeXnameX_mergeXname_qX_chains
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").elementMap("name").merge(["name":"X"]).merge(["name":"Y","q":2i])
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"t[id]":"v[marko].id","t[label]":"person","name":"Y","q":2}] |

  Scenario: g_V_hasLabelXsoftwareX_localXelementMap_mergeXxXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").local(__.elementMap().merge(["x":1i]))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"t[id]":"v[lop].id","t[label]":"software","name":"lop","lang":"java","x":1}] |
      | m[{"t[id]":"v[ripple].id","t[label]":"software","name":"ripple","lang":"java","x":1}] |

  Scenario: g_V_hasLabelXsoftwareX_projectXnX_byXnameX_asXaX_selectXaX_mergeXxX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").project("n").by("name").as("a").select("a").merge(["x":1i])
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"n":"lop","x":1}] |
      | m[{"n":"ripple","x":1}] |

  Scenario: g_VX1X_unionXelementMapXnameX_mergeXxX__elementMapXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").union(__.elementMap("name").merge(["x":1i]), __.elementMap("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"t[id]":"v[marko].id","t[label]":"person","name":"marko","x":1}] |
      | m[{"t[id]":"v[marko].id","t[label]":"person","name":"marko"}] |

  Scenario: g_VX1X_valueMap_mergeXV_hasXname_vadasX_valueMapX_list_values
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").valueMap().merge(__.V().has("name","vadas").valueMap("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"name":["vadas"],"age":[29]}] |

  Scenario: g_VX1X_elementMap_mergeXemptyX_is_the_incoming_map
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").valueMap().merge([:])
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"name":["marko"],"age":[29]}] |

  Scenario: g_V_hasLabelXpersonX_elementMap_mergeXV_hasXname_lopX_elementMapX_selectXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").elementMap().merge(__.V().has("name","lop").elementMap()).select("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | lop |
      | lop |
      | lop |

  # `TraversalUtil.apply` throws when the operand produces nothing — never a silent no-op merge.
  Scenario: g_VX1X_elementMap_mergeXVX99X_elementMapX_does_not_map_to_a_value
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").elementMap().merge(__.V(99999).elementMap())
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "does not map to a value"

  Scenario: g_V_elementMap_mergeXV_countX_not_a_map
    Given the modern graph
    And the traversal of
      """
      g.V().elementMap().merge(__.V().count())
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "merge step expected provided argument to evaluate to a Map, encountered"

  Scenario: g_V_projectXnX_byXnameX_mergeXlistX_not_a_map
    Given the modern graph
    And the traversal of
      """
      g.V().project("n").by("name").merge(["a","b"])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "merge step expected provided argument to evaluate to a Map, encountered"
