Feature: mogwai addendum — a label filled at several chain positions holds every site's members

  # A side effect lives on the ROOT traversal, not on the step that wrote it: `AggregateStep`'s
  # constructor resolves `this.getTraversal().getSideEffects()` and registers the label with
  # `Operator.addAll` (vendor/tinkerpop/gremlin-core/.../step/sideEffect/AggregateStep.java:57), so
  # every site with the same label accumulates into one collection. `processAllStarts` drains a
  # site's traversers into a local `BulkSet` in encounter order and then merges that WHOLE set
  # (AggregateStep.java:124-153, Operator.java:178-196), so site 1's members precede site 2's.
  #
  # The official corpus covers the chain-position element form and asserts it UNORDERED. What it
  # does not cover, and what these pin, is the rest of the composition: sites whose member TYPES
  # differ (a tag disagreement is not a shape disagreement — the members meet at a self-describing
  # per-value type, exactly as two branch arms do), ADJACENT sites over one stream, and the site
  # ORDER itself, which no corpus scenario asserts anywhere. @gap:aggregate-multi-site marks it.
  #
  # A collection is a MULTISET: `BulkSet` bumps a repeated member's count in place rather than
  # dropping it (BulkSet.java:131), so a vertex contributed by two sites appears twice.

  @SpineRel
  @gap:aggregate-multi-site
  Scenario: g_V_hasLabelXpersonX_aggregateXaX_outXcreatedX_aggregateXaX_capXaX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").aggregate("a").out("created").aggregate("a").cap("a").unfold()
      """
    # Four persons, then their created software: marko→lop, josh→lop+ripple, peter→lop (vadas
    # creates nothing). Eight members with `lop` three times — the repeats are what prove nothing
    # was deduped and no site was lost.
    When iterated to list
    Then the result should be unordered
      | result |
      | v[marko] |
      | v[vadas] |
      | v[josh] |
      | v[peter] |
      | v[lop] |
      | v[lop] |
      | v[ripple] |
      | v[lop] |

  @SpineRel
  @gap:aggregate-multi-site
  Scenario: g_V_hasXname_markoX_aggregateXaX_byXnameX_outXknowsX_aggregateXaX_byXageX_capXaX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").aggregate("a").by("name").out("knows").aggregate("a").by("age").cap("a")
      """
    # The two sites' members are a String and two Integers. That is a TYPE disagreement, not a shape
    # one, so the members MEET at a per-value type and each states its own — the same answer two
    # branch arms of differing scalar type give, through the same `meetScalarTypes`/`withMergedVtype`
    # pair. Asserted ORDERED because the site order is the claim: marko's name (site 1) precedes the
    # ages (site 2), and within site 2 the encounter channel pins vadas before josh.
    When iterated to list
    Then the result should be ordered
      | result |
      | l[marko,d[27].i,d[32].i] |

  @SpineRel
  @gap:aggregate-multi-site
  Scenario: g_V_hasXname_markoX_aggregateXaX_byXnameX_outXknowsX_aggregateXaX_byXageX_capXaX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").aggregate("a").by("name").out("knows").aggregate("a").by("age").cap("a").unfold()
      """
    # The same collection re-entered as a stream: each member keeps its OWN type out to the wire,
    # which is what a per-value tag buys and what a single static tag would have flattened.
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | d[27].i |
      | d[32].i |

  @SpineRel
  @gap:aggregate-multi-site
  Scenario: g_unionXV_aggregateXxX__V_hasLabelXsoftwareX_aggregateXxXX_capXxX_unfold_dedup_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.union(__.V().hasLabel("person").aggregate("x"), __.V().hasLabel("software").aggregate("x")).cap("x").unfold().count()
      """
    # A SOURCE-position union: each arm is a whole ROOTED traversal re-entering the fold, and both
    # fill the same label. They must see one registry, because a side effect lives on the root
    # traversal — a rooted sub-chain given a fresh map cannot be read back at all, which is what
    # `cap("x")` declining used to prove. Four persons plus two software.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @SpineRel
  @gap:aggregate-multi-site
  Scenario: g_V_hasLabelXpersonX_aggregateXaX_byXnameX_aggregateXaX_byXageX_capXaX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").aggregate("a").by("name").aggregate("a").by("age").cap("a").unfold()
      """
    # Two sites at ADJACENT positions over the same four traversers — four names then four ages,
    # and every person has both properties so nothing is unproductive.
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | josh |
      | peter |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |
