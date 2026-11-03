Feature: mogwai addendum — Binary is a value class of its own, at any depth

  # A `Binary("…base64…")` literal or a GraphBinary `BINARY` parameter is a `ByteBuffer`
  # (`GenericLiteralVisitor.visitBinaryLiteral`,
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/language/grammar/GenericLiteralVisitor.java:587-595).
  # It rides as its bytes' hex TEXT tagged `binary` (`binaryCarrier`, src/gremlin/types.ts) — the way a
  # UUID rides as TEXT tagged `uuid` — so these pin that the tag, not the text, decides what it is: it
  # frames as `BINARY`, it never equals the String its carrier spells, a list member keeps its class, it
  # orders by its bytes, and a String-only step refuses it. Before, the literal answered its base64 text.

  Scenario: g_injectXBinaryXAQIDX_BinaryXAA_eqeqXX_fold_unfold
    Given the empty graph
    And the traversal of
      """
      g.inject(Binary("AQID"), Binary("AA==")).fold().unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | bin[AQID] |
      | bin[AA==] |

  Scenario: g_injectXlistXBinaryXAQIDX_1XX_unfold_isXtypeOfXGType_BINARYXX
    Given the empty graph
    And the traversal of
      """
      g.inject([Binary("AQID"), 1]).unfold().is(P.typeOf(GType.BINARY))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | bin[AQID] |

  Scenario: g_injectXBinaryXAQIDXX_isXeqX010203XX
    Given the empty graph
    And the traversal of
      """
      g.inject(Binary("AQID")).is(P.eq("010203"))
      """
    When iterated to list
    Then the result should be empty

  Scenario: g_VXdataX_hasXblob_010203X_count
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("blob", Binary("AQID"))
      """
    And the traversal of
      """
      g.V().has("blob", "010203").count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[0].l |

  Scenario: g_VXdataX_hasXblob_BinaryXAQIDXX_valuesXblobX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("blob", Binary("AQID")).addV("data").property("blob", Binary("/w=="))
      """
    And the traversal of
      """
      g.V().has("blob", Binary("AQID")).values("blob")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | bin[AQID] |

  Scenario: g_V_valuesXblobX_order_byXdescX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("blob", Binary("AQID")).addV("data").property("blob", Binary("/w==")).addV("data").property("blob", Binary("AA=="))
      """
    And the traversal of
      """
      g.V().values("blob").order().by(desc)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | bin[/w==] |
      | bin[AQID] |
      | bin[AA==] |

  Scenario: g_V_valuesXblobX_isXgtXBinaryXAQIDXXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("blob", Binary("AQID")).addV("data").property("blob", Binary("/w==")).addV("data").property("blob", Binary("AA=="))
      """
    And the traversal of
      """
      g.V().values("blob").is(P.gt(Binary("AQID")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | bin[/w==] |

  Scenario: g_V_valuesXblobX_dedup_count
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("blob", Binary("AQID")).addV("data").property("blob", Binary("AQID")).addV("data").property("blob", "010203")
      """
    And the traversal of
      """
      g.V().values("blob").dedup().count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[2].l |

  Scenario: g_E_valuesXbX_isXtypeOfXGType_BINARYXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("a").as("x").addV("b").addE("e").from("x").property("b", Binary("AQID"))
      """
    And the traversal of
      """
      g.E().values("b").is(P.typeOf(GType.BINARY))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | bin[AQID] |

  Scenario: g_injectXBinaryXAQIDXX_unionXidentity_constantXBinaryXAA_eqeqXXX_projectXbX_byXidentityX
    Given the empty graph
    And the traversal of
      """
      g.inject(Binary("AQID")).union(identity(), constant(Binary("AA=="))).project("b").by(identity())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"b":"bin[AQID]"}] |
      | m[{"b":"bin[AA==]"}] |

  Scenario: g_VXdataX_valuesXblobX_reverse
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("blob", Binary("AQID"))
      """
    And the traversal of
      """
      g.V().values("blob").reverse()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | bin[AQID] |

  Scenario: g_VXdataX_valuesXblobX_toUpper
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("blob", Binary("AQID"))
      """
    And the traversal of
      """
      g.V().values("blob").toUpper()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "can only take string as argument"

  Scenario: g_VXdataX_valuesXblobX_split
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("blob", Binary("AQID"))
      """
    And the traversal of
      """
      g.V().values("blob").split("0")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "can only take string as argument"

  Scenario: g_injectXBinaryXAQIDXX_asNumber
    Given the empty graph
    And the traversal of
      """
      g.inject(Binary("AQID")).asNumber()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Can't parse type HeapByteBuffer as number"

  Scenario: g_VXdataX_valuesXblobX_asNumber
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("blob", Binary("AQID"))
      """
    And the traversal of
      """
      g.V().values("blob").asNumber()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Can't parse type HeapByteBuffer as number"

  Scenario: g_injectXBinaryXAX_invalid
    Given the empty graph
    And the traversal of
      """
      g.inject(Binary("A"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "is not valid base64"
