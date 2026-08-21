Feature: mogwai addendum — concat(<traversal>) is the TraversalUtil.apply child-value contract

  # `concat()` with TRAVERSAL arguments used to SILENTLY DROP them: the leaf filtered its args with
  # `typeof a === 'string'`, so `concat(__.select("a"))` compiled as a bare `concat()` and returned
  # the receiver unchanged. Right arity, right shape, wrong value — the exact failure mode
  # test/census/README.md exists to catch, and it had five wrong goldens banked against it. The tell
  # in the artifact: `concat(__.inject("c"))` recorded a digest BYTE-IDENTICAL to bare `concat()`.
  #
  # These scenarios pin the SEMANTICS, which are not guessable from the string form. Authority is
  # `ConcatStep.java` + `TraversalUtil.apply`/`prepare` + `StartStep.processNextStart` (TinkerPop
  # master), cross-checked against upstream's own Concat.feature:
  #
  #   · ConcatStep extends ScalarMapStep, whose processNextStart is
  #     `traverser.split(map(traverser), this)` — strictly ONE row out per row in. And `prepare()`
  #     sets `setBulk(1L)`. So a traversal argument can neither DROP nor MULTIPLY the parent
  #     traverser. This is why the rejoin is a LEFT JOIN at 'first' cardinality, and why it differs
  #     from format() (a MapStep using TraversalUtil.produce, which DOES filter → INNER JOIN).
  #   · `apply` calls `traversal.next()` — only the child's FIRST result is used, never all of them.
  #   · The child's INPUT is the current traverser (prepare splits it in as the child's start).
  #
  # Divergence, deliberate and recorded: TinkerPop RAISES IllegalArgumentException on an
  # unproductive child; the LEFT JOIN yields NULL, which concat_ws then skips. That errs toward a
  # short/null answer rather than fabricating a value TinkerPop would have rejected.
  @gap:concat-traversal

  # THE TRAP. `inject()` as a concat argument does NOT contribute its literal. InjectStep extends
  # StartStep, and StartStep.processNextStart APPENDS its injections to the starts queue — while
  # prepare() has ALREADY added the split traverser. So `next()` returns the traverser's own value
  # and the literals are never reached. Hence "aa"/"bb", not "ac"/"bc". Upstream de-special-cased
  # this on purpose (CHANGELOG: "use TraversalUtil.apply on it as with any other child traversals").
  @Unsupported
  Scenario: g_injectXa_bX_concatXinjectXcXX_doubles_the_traverser
    Given the empty graph
    And the traversal of
      """
      g.inject("a", "b").concat(__.inject("c"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | aa |
      | bb |

  # Same rule with a LIST literal: still the traverser's own value, so "aa" and never "a[b,c]".
  @Unsupported
  Scenario: g_injectXaX_concatXinjectXlistXX_doubles_the_traverser
    Given the empty graph
    And the traversal of
      """
      g.inject("a").concat(__.inject(["b","c"]))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | aa |

  # A label-carried child: select("a") re-roots on the alias bound earlier in the SAME traverser,
  # so each person gets THEIR OWN name appended. The pre-fix answer was "Mr." four times over
  # (one distinct value); the correct answer is four distinct values. Now LOWERED — the concat
  # operand resolves through the child seam as a correlated scalar (`scalarChild`).
  Scenario: g_V_valuesXnameX_asXaX_constantXMrX_concatXselectXaXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("name").as("a").constant("Mr.").concat(__.select("a"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | Mr.marko |
      | Mr.vadas |
      | Mr.josh |
      | Mr.peter |

  # A string concat() and a traversal concat() are SEPARATE steps (the grammar's two productions are
  # mutually exclusive — `concat(" x ", __.select("a"))` is a parse error), so they chain. Now LOWERED —
  # the operand is a correlated scalar, guarded so an empty read raises rather than silently skips (all
  # software carry lang, so the guard is inert and it succeeds).
  Scenario: g_V_asXaX_valuesXnameX_concatX_usesX_concatXselectXaXvaluesXlangXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").as("a").values("name").concat(" uses ").concat(__.select("a").values("lang"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop uses java |
      | ripple uses java |

  # Composes inside a map() body while a path is tracked: both labels resolve against the SAME
  # traverser. The two 2-hop paths are marko->josh->lop and marko->josh->ripple, so this is
  # marko+lop and marko+ripple. Pre-fix it collapsed to "marko" twice (one distinct value).
  @Unsupported
  Scenario: g_withPath_V_asXaX_out_out_asXbX_mapXselectXaX_concatXselectXbXXX
    Given the modern graph
    And the traversal of
      """
      g.withPath().V().as("a").out().out().as("b").map(__.select("a").values("name").concat(__.select("b").values("name")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | markolop |
      | markoripple |

  # A constant() child is the simplest resolvable body, and it must NOT filter: every one of the six
  # vertices keeps its traverser (the LEFT JOIN), so this is a per-value suffix over the whole stream.
  @Unsupported
  Scenario: g_V_valuesXnameX_concatXconstantXXXX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").concat(__.constant("X"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | markoX |
      | vadasX |
      | joshX |
      | peterX |
      | lopX |
      | rippleX |

  # Multiple traversal arguments concatenate in ARGUMENT order (ConcatStep.map appends each child's
  # result in order), one resolved value each.
  @Unsupported
  Scenario: g_V_valuesXnameX_concatXconstantXXX_constantXYXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").values("name").concat(__.constant("-"), __.constant("!"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop-! |
      | ripple-! |

  # The STRING form is untouched by all of the above, including its null rules: a null receiver and
  # a null argument are each skipped, and the result is null only when EVERY part is null.
  Scenario: g_injectXnull_aX_concatXnull_bX_skips_nulls
    Given the empty graph
    And the traversal of
      """
      g.inject(null, "a").concat(null, "b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | b |
      | ab |
