Feature: mogwai addendum — a COLLECTION property value stores as one typed tree and indexes per leaf

  # A list/map/set property value is stored as a self-describing typed `{t,v}` tree in the value column:
  # its JSON TEXT crosses the seam and SQLite builds the blob (`jsonb(<text>)`), because a raw array or
  # Map bind throws at that seam. Its FTS text is one row per nested LEAF, not one row for the value.
  #
  # The official corpus writes collection properties and then reads them back through `valueMap()`, so
  # a route that stored the right tree the wrong WAY still passes: the read recovers `json(value)` for
  # those vtypes either way. What it does not pin is the encoding itself, or the index. Both are pinned
  # here, and both are the things that differ between "wrapped in jsonb" and "bound as text".
  #
  # The `set` cardinality case is the sharp one: an equal value already present must be MATCHED, not
  # appended. That comparison reads the value column, so it has to spell the value exactly as the
  # insert did — a form that differed between the two would silently duplicate.

  # Read BACK through the traversal, because `has(key, <collection>)` is a pre-existing gap on BOTH
  # spines (a collection reaches the bind layer raw and it refuses) — so a graph-check using it would
  # assert nothing about this change and fail for an unrelated reason.
  @gap:property-collection-value
  Scenario: g_addV_property_list_value_round_trips_as_a_list
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property("list", ["a", "b", "c"])
      """
    And the traversal of
      """
      g.V().values("list")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[a,b,c] |

  @gap:property-collection-value
  Scenario: g_addV_property_map_value_round_trips_as_a_map
    Given the empty graph
    And the traversal of
      """
      g.addV("data").property("map", ["city": "NYC", "country": "USA"])
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().values(\"map\")"

  # A COLLECTION and a SCALAR on one element, because they take different bind forms in the same
  # statement set and a shared `stored` reading would have applied one form to both.
  @gap:property-collection-value
  Scenario: g_addV_property_scalar_then_collection_on_one_element
    Given the empty graph
    And the traversal of
      """
      g.addV("data").property("name", "test").property("list", [1, 2, 3])
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"name\",\"test\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"test\").values(\"list\")"

  # TWO elements each with their own collection: the second write must not read the first's row as
  # "already present".
  @gap:property-collection-value
  Scenario: g_addV_property_list_twice_writes_two_elements
    Given the empty graph
    And the traversal of
      """
      g.addV("data").property("list", [1]).
        addV("data").property("list", [1, 2, 3])
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 2 for count of "g.V()"
    And the graph should return 2 for count of "g.V().properties(\"list\")"

  # THE SET CARDINALITY over a collection value — the same list written twice under `set` is ONE
  # property, which only holds if the presence test spells the value the way the insert did.
  @gap:property-collection-value
  Scenario: g_addV_property_set_cardinality_collection_value_dedups
    Given the empty graph
    And the graph initializer of
      """
      g.addV("data").property(Cardinality.set, "list", ["a", "b"])
      """
    And the traversal of
      """
      g.V().property(Cardinality.set, "list", ["a", "b"])
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().properties(\"list\")"

  # A META-PROPERTY lands in the property row's own `meta` column as a JSONB object — the same
  # `jsonb(<text>)` question as a collection value, a different column. Pinned with a LIST cardinality
  # because that is the case where two values of one key each carry their own meta, so a route that
  # attached meta to the wrong row is visible.
  @gap:property-collection-value
  @Unsupported
  Scenario: g_addV_property_list_with_meta_keeps_meta_per_value
    Given the empty graph
    And the traversal of
      """
      g.addV().property("name","bob").
        property(Cardinality.list, "location", "ny", "startTime", 2014, "endTime", 2016).
        property(Cardinality.list, "location", "va", "startTime", 2016)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 2 for count of "g.V().properties(\"location\")"
    And the graph should return 1 for count of "g.V().properties(\"location\").has(\"startTime\", 2014)"
    And the graph should return 1 for count of "g.V().properties(\"location\").has(\"startTime\", 2016)"
    And the graph should return 1 for count of "g.V().properties(\"location\").has(\"endTime\", 2016)"

  # A null value with meta args is a REMOVAL and the meta is not part of the answer — `ElementHelper`
  # removes before it looks at either meta or the cardinality, so asking about meta first made this
  # decline for a reason that does not apply to it.
  @gap:property-collection-value
  Scenario: g_addV_property_null_with_meta_args_is_still_a_removal
    Given the empty graph
    And the traversal of
      """
      g.addV("person").property("name","marko").property("friendWeight", null, "acl", null)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\")"
    And the graph should return 0 for count of "g.V().properties(\"friendWeight\")"
