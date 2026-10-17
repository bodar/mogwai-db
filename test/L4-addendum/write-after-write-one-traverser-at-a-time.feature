Feature: mogwai addendum — a write after a write: which lands last on a shared element is the per-traverser order

  # The lazy pipeline hands traverser 1 through EVERY later step before traverser 2 reaches an earlier one
  # (no NoOpBarrierStep on a labelled path, after a short id source, or after a first flat-map,
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/LazyBarrierStrategy.java:93-130;
  # AddPropertyStep mutates per traverser, .../step/sideEffect/AddPropertyStep.java:94). So when a later write
  # step reaches fewer traversers than an earlier one writing the same key (or label, or a drop of it) of one
  # shared element, the EARLIER step's write by traverser 2 lands last. One statement per step writes every
  # traverser at the earlier step first, and would leave the later step's value. Each scenario states the
  # reference answer and must refuse (`writeAfterWrite`, src/compiler/rel/write.ts) — the trailing ones are the
  # shapes that ordering cannot change, which keep answering.

  @gap:write-after-write-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2X_asXaX_VX1X_propertyXsingle_w_5X_filterXselectXaX_isX1XX_propertyXsingle_w_9X_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2).as("a").V(1).property(Cardinality.single,"w",5).filter(__.select("a").is(1)).property(Cardinality.single,"w",9).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
    And the graph should return 1 for count of "g.V(1).has(\"w\",5)"

  @gap:write-after-write-one-traverser-at-a-time
  @Unsupported
  Scenario: g_VX1_2X_asXaX_VX1X_propertyXsingle_w_5X_selectXaX_hasIdX1X_VX1X_propertyXsingle_w_9X_count
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).as("a").V(1).property(Cardinality.single,"w",5).select("a").hasId(1).V(1).property(Cardinality.single,"w",9).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
    And the graph should return 1 for count of "g.V(1).has(\"w\",5)"

  # A drop of the key, terminal: traverser 2 writes w again after traverser 1 dropped it.
  @gap:write-after-write-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2X_asXaX_VX1X_propertyXsingle_w_5X_filterXselectXaX_isX1XX_propertiesXwX_drop
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2).as("a").V(1).property(Cardinality.single,"w",5).filter(__.select("a").is(1)).properties("w").drop()
      """
    When iterated to list
    Then the result should be empty
    And the graph should return 1 for count of "g.V(1).has(\"w\",5)"

  # Two label mutations: traverser 2 adds the label back after traverser 1 dropped it.
  @gap:write-after-write-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2X_asXaX_VX1X_addLabelXqX_filterXselectXaX_isX1XX_dropLabelXqX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2).as("a").V(1).addLabel("q").filter(__.select("a").is(1)).dropLabel("q").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
    And the graph should return 1 for count of "g.V(1).hasLabel(\"q\")"

  # ONE traverser through the earlier write: it lands before every later one, whatever fans out after it.
  @gap:write-after-write-one-traverser-at-a-time
  Scenario: g_VX1X_propertyXsingle_w_5X_out_propertyXsingle_w_9X_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).property(Cardinality.single,"w",5).out().property(Cardinality.single,"w",9).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.V(1).has(\"w\",5)"
    And the graph should return 3 for count of "g.V().has(\"w\",9)"

  # Different keys: the two writes cannot overwrite one another.
  @gap:write-after-write-one-traverser-at-a-time
  Scenario: g_injectX1_2X_asXaX_VX1X_propertyXsingle_w_5X_filterXselectXaX_isX1XX_propertyXsingle_z_9X_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2).as("a").V(1).property(Cardinality.single,"w",5).filter(__.select("a").is(1)).property(Cardinality.single,"z",9).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
    And the graph should return 1 for count of "g.V(1).has(\"w\",5).has(\"z\",9)"

  # One RUN of property() steps: every traverser writes the whole run before the next, in step order.
  @gap:write-after-write-one-traverser-at-a-time
  Scenario: g_injectX1_2X_VX1X_propertyXsingle_w_5X_propertyXsingle_w_9X_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2).V(1).property(Cardinality.single,"w",5).property(Cardinality.single,"w",9).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
    And the graph should return 1 for count of "g.V(1).has(\"w\",9)"
