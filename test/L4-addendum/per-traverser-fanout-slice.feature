Feature: mogwai addendum — a per-origin slice scopes to the TRAVERSER, not the element it reached

  # `local`/`flatMap` apply their body to EACH traverser independently (TinkerPop's LocalStep/
  # FlatMapStep), and `match` localizes a barrier pattern body into a per-traverser TraversalFlatMapStep
  # (`vendor/tinkerpop/gremlin-core/.../MatchStep.java:156-166`). So a slice/dedup inside such a body is
  # scoped to the ENTERING traverser. We first partitioned the per-origin window by the ELEMENT the
  # traverser reached — a rowid that REPEATS when two traversers land on the same element (`both()`
  # revisits, two `x` create one `a`) — which collapsed those traversers into one and dropped their
  # slices. The origin is now a per-ROW identity (a fresh number per binding row / per fan-out row), so
  # each traverser keeps its own slice. @gap:per-traverser-fanout-slice marks the family.

  @gap:per-traverser-fanout-slice
  Scenario: g_V_both_localXout_limitX1XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().both().local(__.out().limit(1)).count()
      """
    # `both()` produces 16 traversers; each runs `out().limit(1)` INDEPENDENTLY, contributing
    # min(1, out-degree) of the element it landed on. Traversers landing on a vertex WITH out-edges:
    # marko (reached 3× — from vadas/josh/lop), josh (3× — from marko/ripple/lop), peter (1× — from lop);
    # vadas/lop/ripple have no out-edges. So 3 + 3 + 1 = 7 — NOT 3, which is what partitioning by the
    # element id gave (marko/josh/peter each collapsed to a single slice). The count is deterministic
    # whichever out-edge each `limit(1)` picks, so this is perturbation-stable.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].l |

  @gap:per-traverser-fanout-slice
  Scenario: g_V_matchXx_out_created_a__a_inE_created_order_by_weight_limit_outV_bX_select_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().match(__.as("x").out("created").as("a"), __.as("a").inE("created").order().by("weight").limit(1).outV().as("b")).select("x","a","b").by("name")
      """
    # `a` is bound by the first pattern, so the SAME `a` (lop) rides on THREE binding rows — marko, josh
    # and peter each created lop. The second pattern's `limit(1)` (the lowest-weight in-edge of `a`, then
    # its outV) must apply to EACH of those rows, not once for lop. lop's lowest-weight in-edge is
    # peter-created->lop (0.2); ripple's only in-edge is josh (1.0). A partition by the alias id kept one
    # lop row and answered 2; the per-binding-row origin keeps all three and answers 4. `order().by`
    # pins the pick, so the rows are deterministic.
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"marko","a":"lop","b":"peter"}] |
      | m[{"x":"josh","a":"lop","b":"peter"}] |
      | m[{"x":"peter","a":"lop","b":"peter"}] |
      | m[{"x":"josh","a":"ripple","b":"josh"}] |
