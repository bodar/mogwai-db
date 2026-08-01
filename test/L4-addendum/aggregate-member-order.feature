Feature: mogwai addendum — a named side-effect's members keep the order they were collected in

  # A collection's member order is fully observable — the members ride inside the collected
  # traverser's own GraphBinary buffer, which is why `jsonbGroupArray` takes an order argument at
  # all. `aggregate('x').by(traversal)` collects one member per input traverser, so that order is
  # the INPUT order.
  #
  # The scalar-valued by() bakes it in when the list is built. The ELEMENT-valued one could not:
  # its side-effect is a RELATION whose rows are the members, read back by cap(), and it carried no
  # order channel at all — so cap() emitted them in whatever order SQLite scanned. The def now
  # names an order column, cap() declares it as the stream's encounter, and the wire applies it.
  # @gap:aggregate-member-order marks the family.

  @gap:aggregate-member-order
  Scenario: g_V_order_byXnameX_aggregateXxX_byXout_order_byXnameXX_capXxX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by("name").aggregate("x").by(__.out().order().by("name")).cap("x")
      """
    # Input order josh, lop, marko, peter, ripple, vadas; the by() keeps each one's FIRST
    # out-neighbour by name, and a vertex with no out contributes nothing (by() is unproductive
    # there). josh→lop, marko→josh, peter→lop, in that order.
    When iterated to list
    Then the result should be ordered
      | result |
      | l[v[lop],v[josh],v[lop]] |
