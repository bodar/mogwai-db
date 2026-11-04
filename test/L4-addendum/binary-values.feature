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

  # A literal String SET meets a Binary whose carrier it spells no more than one String does: `yg==` is
  # 0xCA, carried as "CA", and `EA==` is 0x10, carried as "10". The set's type guard is hoisted off its
  # `IN` list (`hoistedStringSet`) — these pin that the hoist drops no String and admits no Binary, for
  # `within` and its complement, at the source and after a hop into the values.
  Scenario: g_VXcodesX_hasXcode_withinXCA_USXX_valuesXcodeX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("d").property("code", Binary("yg==")).addV("d").property("code", "CA").addV("d").property("code", "US").addV("d").property("code", "GB")
      """
    And the traversal of
      """
      g.V().has("code", within("CA","US")).values("code")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | CA |
      | US |

  Scenario: g_VXcodesX_hasXcode_withoutXCA_USXX_valuesXcodeX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("d").property("code", Binary("yg==")).addV("d").property("code", "CA").addV("d").property("code", "US").addV("d").property("code", "GB")
      """
    And the traversal of
      """
      g.V().has("code", without("CA","US")).values("code")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | bin[yg==] |
      | GB |

  Scenario: g_VXcodesX_unionXvaluesXcodeX_isXwithinXCA_USXX_valuesXcodeX_isXwithinX10_20XXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("d").property("code", Binary("yg==")).addV("d").property("code", "CA").addV("d").property("code", Binary("EA==")).addV("d").property("code", "10").addV("d").property("code", 10).addV("d").property("code", "20")
      """
    And the traversal of
      """
      g.V().union(values("code").is(within("CA","US")), values("code").is(within("10","20")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | CA |
      | 10 |
      | 20 |

  Scenario: g_VXcodesX_whereXvaluesXcodeX_isXwithoutX10_20XXX_valuesXcodeX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("d").property("code", Binary("EA==")).addV("d").property("code", "10").addV("d").property("code", 10).addV("d").property("code", "20")
      """
    And the traversal of
      """
      g.V().where(values("code").is(without("10","20"))).values("code")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | bin[EA==] |
      | d[10].i |

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

  # A MERGE SEARCH is `has(k, v)` per entry (`MergeVertexStep`/`MergeEdgeStep` → `searchVerticesTraversal`,
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeStep.java),
  # so a Binary (or UUID) entry must match the element it names — the search reads the entry's declared
  # type exactly as a written `has()` does. Without it every upsert keyed on such a value wrote a duplicate.
  Scenario: g_mergeVXblob_BinaryXAQIDXX_matches_existing
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("blob", Binary("AQID")).property("name", "a").addV("data").property("blob", Binary("AQID")).property("name", "b")
      """
    And the traversal of
      """
      g.mergeV(["blob": Binary("AQID")]).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |
      | b |
    And the graph should return 2 for count of "g.V()"

  Scenario: g_mergeVXblob_BinaryXygXX_twice_creates_once
    Given the empty graph
    And the traversal of
      """
      g.mergeV(["blob": Binary("yg==")]).mergeV(["blob": Binary("yg==")]).values("blob")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | bin[yg==] |
    And the graph should return 1 for count of "g.V()"

  Scenario: g_injectX1_2X_mergeVXblob_BinaryXAQIDXX_count
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("blob", Binary("AQID"))
      """
    And the traversal of
      """
      g.inject(1, 2).mergeV(["blob": Binary("AQID")]).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[2].l |
    And the graph should return 1 for count of "g.V()"

  Scenario: g_mergeVXu_UUIDX_matches_existing
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("u", UUID("f47af10b-58cc-4372-a567-0f02b2f3d479")).property("name", "a")
      """
    And the traversal of
      """
      g.mergeV(["u": UUID("f47af10b-58cc-4372-a567-0f02b2f3d479")]).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |
    And the graph should return 1 for count of "g.V()"

  # A `Cardinality` wrapper carries its value's type: the merge both SEARCHES for and WRITES the Binary/UUID,
  # never the String its carrier spells.
  Scenario: g_mergeVXblob_singleXBinaryXAQIDXXX_matches_existing
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("blob", Binary("AQID")).property("u", UUID("f47af10b-58cc-4372-a567-0f02b2f3d479"))
      """
    And the traversal of
      """
      g.mergeV(["blob": Cardinality.single(Binary("AQID")), "u": Cardinality.list(UUID("f47af10b-58cc-4372-a567-0f02b2f3d479"))]).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[1].l |
    And the graph should return 1 for count of "g.V()"

  Scenario: g_mergeVXblob_setXBinaryXAQIEXXX_writes_a_Binary
    Given the empty graph
    And the traversal of
      """
      g.mergeV(["blob": Cardinality.set(Binary("AQIE"))]).values("blob").is(P.typeOf(GType.BINARY))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | bin[AQIE] |

  Scenario: g_mergeEXk_1_2_eb_BinaryXygXX_matches_existing
    Given the modern graph
    And the graph initializer of
      """
      g.V(1).addE("k").to(__.V(2)).property("eb", Binary("yg=="))
      """
    And the traversal of
      """
      g.mergeE([(T.label): "k", (Direction.OUT): 1, (Direction.IN): 2, "eb": Binary("yg==")]).values("eb")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | bin[yg==] |
    And the graph should return 7 for count of "g.E()"

  # A `Cardinality` wrapper carries its value's type INSIDE itself, never on the wrapper: a map handed to
  # `inject()` keeps the wrapper whole, so a merge DRIVER reading that map must write the UNWRAPPED value
  # (`MergeVertexStep` unwraps the CardinalityValueTraversal —
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeVertexStep.java).
  # Typing the wrapper by its value once wrote the wrapper's JSON under an int/double tag here. The driver
  # path does not unwrap yet, so these REFUSE; the reference answers below are what they must say when it does.
  @Unsupported
  Scenario: g_injectXmap_age_singleX1XX_mergeV_valuesXageX
    Given the empty graph
    And the traversal of
      """
      g.inject([(T.label): "person", "name": "x", "age": Cardinality.single(1)]).mergeV().values("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  @Unsupported
  Scenario: g_injectXmap_q_3X_Xmap_r_singleX4XX_mergeV_valuesXageX
    Given the empty graph
    And the traversal of
      """
      g.inject(["name": "q", "age": 3], ["name": "r", "age": Cardinality.single(4)]).mergeV().values("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].i |
      | d[4].i |

  @Unsupported
  Scenario: g_injectXmap_knows_1_2_w_singleX0_5dXX_mergeE_valuesXwX
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label): "knows", (Direction.OUT): 1, (Direction.IN): 2, "w": Cardinality.single(0.5d)]).mergeE().values("w")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0.5].d |
