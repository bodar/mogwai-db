Feature: mogwai addendum — positional determinism (canonical emission order, Stage B)

  # limit/range/skip/tail/fold after a fan-out pick or order a DETERMINISTIC subset. Without a
  # threaded emission order they relied on incidental SQLite row order; a demand pre-pass now
  # seeds a canonical `encounter` (rowid at the source, refined at each fan-out; superseded by
  # order()), and these consumers ORDER BY it. The official corpus rarely pins the exact subset
  # a bare slice returns, so these fix the composition. @gap:emission-order marks the family.

  @gap:emission-order
  Scenario: g_V_valuesXageX_order_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").order().limit(2)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[27].i |
      | d[29].i |

  @gap:emission-order
  Scenario: g_V_valuesXageX_order_tailX2X
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").order().tail(2)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |
      | d[35].i |

  @gap:emission-order
  Scenario: g_V_valuesXageX_order_skipX2X
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").order().skip(2)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |
      | d[35].i |

  @gap:emission-order
  Scenario: g_V_valuesXageX_orderXdescX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").order().by(desc).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[35].i,d[32].i,d[29].i,d[27].i] |

  # union emits arm 0 fully before arm 1 FOR ONE INPUT TRAVERSER, which is what this scenario has
  # (`g.V(4)`) — so the pin is correct, but the justification it used to carry ("TinkerPop's
  # contract", unqualified) is not. Verified in gremlin-core: `BranchStep.standardAlgorithm` injects
  # ONE start and drains each arm for it unless `hasBarrier` is set, so with several traversers the
  # reference is traverser-major, arm-minor, and we are arm-major GLOBALLY. That divergence is real
  # and was fixed by the branch-arm plan's T4 — the multi-traverser cases live in
  # branch-traverser-major.feature, where the slice falls on a traverser boundary. Keep this one
  # single-traverser: it is pinning the branch-merge encounter re-mint, not the merge's key.
  # josh(4): out={lop,ripple} (arm 0), in={marko} (arm 1); limit(2) is the two out-neighbours, never
  # marko. Guards the branch-merge encounter re-mint.
  @gap:emission-order
  Scenario: g_V4_unionXout_inX_limitX2X_name
    Given the modern graph
    And the traversal of
      """
      g.V(4).union(__.out(), __.in()).limit(2).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | ripple |

  # ---- the ROOT half of emission order (outstanding-work item 26) ----
  #
  # An `encounter` threaded all the way to the root still had to survive the root PROJECTION, and
  # for nine of eleven shapes it did not: every root drops the carried columns (they are internal)
  # and all but `materializeScalarRoot` dropped the ORDER BY with them. So the scenarios above held
  # only because they end in a scalar; the same prefix ending in a property, a list or a map
  # returned whatever order SQLite's scan produced. `rootOrder` (tail/materialize.ts) is now the one
  # place that decides it, gated by the shared `cardinalityOf` so a group (one whole result) and a
  # grouped path (one row per position) stay out.
  #
  # These are `ordered` assertions and they earn it: they FAIL under `mise run test:perturbed`
  # without the fix, which is the only way this class of defect is visible at all.

  # The ELEMENT-list branch of the same root builder: its members expand to full payloads, which is
  # a different projection from the scalar-list branch below but the same dropped ORDER BY.
  @gap:emission-order
  Scenario: g_V_orderXbyXnameXX_localXoutXcreatedX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by("name").local(__.out("created").fold())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[v[lop],v[ripple]] |
      | l[] |
      | l[v[lop]] |
      | l[v[lop]] |
      | l[] |
      | l[] |

  @gap:emission-order
  Scenario: g_V_orderXbyXnameXX_localXoutXcreatedX_valuesXnameX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by("name").local(__.out("created").values("name").order().fold())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[lop,ripple] |
      | l[] |
      | l[lop] |
      | l[lop] |
      | l[] |
      | l[] |
