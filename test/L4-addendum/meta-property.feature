Feature: mogwai addendum — meta-properties (a VertexProperty's own properties)

  # A VertexProperty IS an Element, so the element property vocabulary asks about ITS properties — the
  # meta-properties: `has(k[, P])`/`hasNot(k)` test them (`HasContainer.test` reads
  # `element.properties(key)` — vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/HasContainer.java),
  # `values(k…)` streams them and `by('k')` reads the first. Answers are derived from the crew graph's
  # `location` meta-properties (vendor/tinkerpop/gremlin-test/.../tinkerpop-crew-v3.json): every location
  # has a `startTime`, every one but the current has an `endTime`.

  Scenario: g_V_hasXname_stephenX_propertiesXlocationX_hasXstartTime_gteX2000XX_value
    Given the crew graph
    And the traversal of
      """
      g.V().has("name","stephen").properties("location").has("startTime",P.gte(2000)).value()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | dulles |
      | purcellville |

  Scenario: g_V_propertiesXlocationX_hasNotXendTimeX_value
    Given the crew graph
    And the traversal of
      """
      g.V().properties("location").hasNot("endTime").value()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | santa fe |
      | purcellville |
      | seattle |
      | aachen |

  Scenario: g_V_hasXname_markoX_propertiesXlocationX_hasXendTimeX_count
    Given the crew graph
    And the traversal of
      """
      g.V().has("name","marko").properties("location").has("endTime").count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[3].l |

  # A meta value keeps its type: an int `startTime` is not the string "1990".
  Scenario: g_V_hasXname_stephenX_propertiesXlocationX_hasXstartTime_1990stringX
    Given the crew graph
    And the traversal of
      """
      g.V().has("name","stephen").properties("location").has("startTime","1990")
      """
    When iterated to list
    Then the result should be empty

  Scenario: g_V_hasXname_stephenX_propertiesXlocationX_notXhasXendTimeXX_value
    Given the crew graph
    And the traversal of
      """
      g.V().has("name","stephen").properties("location").not(__.has("endTime")).value()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | purcellville |

  Scenario: g_V_hasXname_stephenX_propertiesXlocationX_valuesXstartTimeX
    Given the crew graph
    And the traversal of
      """
      g.V().has("name","stephen").properties("location").values("startTime")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1990].i |
      | d[2000].i |
      | d[2006].i |

  Scenario: g_V_hasXname_danielX_propertiesXlocationX_values
    Given the crew graph
    And the traversal of
      """
      g.V().has("name","daniel").properties("location").values()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1982].i |
      | d[2005].i |
      | d[2005].i |
      | d[2009].i |
      | d[2009].i |

  Scenario: g_V_hasXname_markoX_propertiesXlocationX_orderXX_byXstartTimeX_value
    Given the crew graph
    And the traversal of
      """
      g.V().has("name","marko").properties("location").order().by("startTime").value()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | san diego |
      | santa cruz |
      | brussels |
      | santa fe |

  # An unproductive `by()` drops the traverser: the current location has no `endTime`.
  Scenario: g_V_hasXname_stephenX_propertiesXlocationX_orderXX_byXendTime_descX_value
    Given the crew graph
    And the traversal of
      """
      g.V().has("name","stephen").properties("location").order().by("endTime",Order.desc).value()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | dulles |
      | centreville |

  # An unproductive `by()` in a `project` drops its KEY, not the traverser.
  Scenario: g_V_hasXname_stephenX_propertiesXlocationX_projectXw_s_eX_byXvalueX_byXstartTimeX_byXvaluesXendTimeXX
    Given the crew graph
    And the traversal of
      """
      g.V().has("name","stephen").properties("location").project("w","s","e").by(__.value()).by("startTime").by(__.values("endTime"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"w":"centreville","s":"d[1990].i","e":"d[2000].i"}] |
      | m[{"w":"dulles","s":"d[2000].i","e":"d[2006].i"}] |
      | m[{"w":"purcellville","s":"d[2006].i"}] |

  Scenario: g_V_hasXname_stephenX_propertiesXlocationX_whereXvaluesXstartTimeX_isXgtX1995XXX_value
    Given the crew graph
    And the traversal of
      """
      g.V().has("name","stephen").properties("location").where(__.values("startTime").is(P.gt(1995))).value()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | dulles |
      | purcellville |

  Scenario: g_V_propertiesXlocationX_hasXendTime_lteX2005XX_groupCountXX_byXendTimeX
    Given the crew graph
    And the traversal of
      """
      g.V().properties("location").has("endTime",P.lte(2005)).groupCount().by("endTime")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"d[2000].i":"d[1].l","d[2001].i":"d[1].l","d[2004].i":"d[1].l","d[2005].i":"d[2].l"}] |
