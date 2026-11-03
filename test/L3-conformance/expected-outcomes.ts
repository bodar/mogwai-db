// THE EXPECTED-OUTCOME LEDGER — every in-scope L3 scenario that fails, named, with WHY.
//
// The ratchet (`l3-state.json`) says WHICH scenarios fail; it never said whether a failure is a gap we
// mean to close, a decision we made, or a wrong answer we know about. This file says so for each one,
// so "L3 is at N" stops being a number with an unexplained remainder: every scenario is either OUT OF
// SCOPE (`tags.ts` — a declared wall, a runner skip, an upstream IgnoreError, a GLV-lossy translation:
// the harness cannot adjudicate it) or IN SCOPE and passing, or IN SCOPE, failing and LEDGERED here.
//
// ── The four kinds, and the one rule that keeps them honest ───────────────────────────────────────
//
//   divergence — a deliberate difference with its line in `docs/feature-support-matrix.md` §17.
//   wall       — a declared capability we do not have (a format, a provider default, an inert strategy).
//   decline    — a clear `UnsupportedTraversal` for a capability `docs/outstanding-work.md` names.
//   defect     — a KNOWN WRONG ANSWER, carrying its `docs/outstanding-work.md` ID.
//
// **A wrong answer is NEVER a `decline` or a `divergence`.** Ledgering one as either would launder a
// defect into an "expected outcome", which is the failure this file exists to prevent rather than to
// enable. Three checks make that structural rather than a promise:
//
//   - every reason CITES its authority and `l3-state.test.ts` reads the cited file: a divergence's
//     text must be a row of §17, a defect's `(id)` must be an item of outstanding-work §1;
//   - every L3 run proves each `decline` really DECLINED (`declinesThatAnswered`, over the telemetry
//     the run just captured): a decline that turns into an answer — right or wrong — fails loudly, and
//     is re-filed as a pass (delete it here) or a defect;
//   - the ledger must EQUAL the failing set, by multiplicity (`auditLedger`): a new failure cannot hide
//     unledgered, and a fixed scenario cannot stay ledgered — so the commit that fixes a scenario
//     deletes its name here, in the same diff.
//
// Seeded from `l3-state.json`'s `failed` list joined to the scenario-stamped telemetry of one run; the
// decline families are worklist hints (the decline MESSAGE is the precise reason), the other kinds are
// diagnosed one by one.

/** What kind of expected outcome a ledgered failure is — see the header. */
export type OutcomeKind = 'divergence' | 'wall' | 'decline' | 'defect';

/** One reason, and the document that authorizes it: `cite` is [repo-relative path, text that must
 *  occur in it]. */
export interface Reason {
  readonly kind: OutcomeKind;
  readonly why: string;
  readonly cite: readonly [path: string, text: string];
}

export const REASONS = {
  // ── wall ──
  'nan-literal': { kind: 'wall', why: 'a NaN literal in a value position (`inject(NaN)`) declines: SQLite stores NaN as NULL', cite: ['docs/feature-support-matrix.md', '| `NaN` values |'] },
  'io-gryo-graphml': { kind: 'wall', why: '`io()` reads typed GraphSON only; Gryo is JVM serialization and GraphML cannot carry our value types', cite: ['docs/feature-support-matrix.md', '🚫 GraphML, Gryo'] },
  'connective-strategy': { kind: 'wall', why: 'ConnectiveStrategy\'s infix `and()`/`or()` folding is always applied, so `withoutStrategies(ConnectiveStrategy)` is refused', cite: ['docs/feature-support-matrix.md', 'always on, so disabling it is rejected'] },
  'graph-computer-inert': { kind: 'wall', why: 'every traversal runs compiled; `VertexProgramStrategy` and `VertexProgramRestrictionStrategy` are inert, so there is no vertex program to refuse', cite: ['docs/feature-support-matrix.md', '`VertexProgramRestrictionStrategy`, `HaltedTraverserStrategy`, `VertexProgramStrategy`'] },
  'vertex-property-ids': { kind: 'wall', why: 'vertex-property ids are assigned by the graph, so a loaded file\'s ids (`@UserSuppliedVertexPropertyIds`) are not kept', cite: ['docs/feature-support-matrix.md', 'Vertex-property ids are assigned by the graph'] },
  'list-default-cardinality': { kind: 'wall', why: 'an undeclared `property(k, v)` APPENDS (the default cardinality is list); this scenario assumes a `single` default', cite: ['src/api.ts', 'export const DEFAULT_VERTEX_CARDINALITY: VertexCardinality = \'list\';'] },
  // ── divergence ──
  'string-id-distinct': { kind: 'divergence', why: 'a String id is not the integer id it spells (`V(\'1\')` is not `V(1)`)', cite: ['docs/feature-support-matrix.md', '| String vs integer element id |'] },
  'merge-type-error-text': { kind: 'divergence', why: '`merge()` raises the same type error in our own words', cite: ['docs/feature-support-matrix.md', '| `merge()` type-error text |'] },
  'oncreate-override': { kind: 'divergence', why: 'an onCreate map that changes a merge key is refused when the query compiles (eager error timing), though here the edge exists and onCreate never runs', cite: ['docs/feature-support-matrix.md', '| Error timing |'] },
  // ── defect ──
  'binary-as-string': { kind: 'defect', why: 'a `Binary(…)` literal answers its base64 text, not a binary value', cite: ['docs/outstanding-work.md', '(l3-binary)'] },
  'call-traversal-params': { kind: 'defect', why: '`call(service, map, traversal)` ignores the traversal\'s parameter map', cite: ['docs/outstanding-work.md', '(l3-call-trav-params)'] },
  'multilabel-edge-label': { kind: 'defect', why: '`with(\'multilabel\')` frames an edge\'s own label as a String, not a Set', cite: ['docs/outstanding-work.md', '(l3-multilabel-edge-label)'] },
  't-token-order': { kind: 'defect', why: '`order(local).by(keys)` sorts `T.id`/`T.label` keys after every String instead of by name', cite: ['docs/outstanding-work.md', '(l3-t-token-order)'] },
  'map-merge': { kind: 'defect', why: 'a `merge()` over an incoming Map raises a type error instead of merging', cite: ['docs/outstanding-work.md', '(l3-map-merge)'] },
  // ── decline ──
  'subgraph-strategy': { kind: 'decline', why: '`SubgraphStrategy` with an `or()` edge criterion or a `vertexProperties` criterion', cite: ['docs/outstanding-work.md', '`SubgraphStrategy(edges: __.or(…))`'] },
  'partition-upsert': { kind: 'decline', why: 'a partition-aware `mergeV`/`mergeE`', cite: ['docs/outstanding-work.md', 'PartitionStrategy-aware upsert'] },
  'strategy-residue': { kind: 'decline', why: 'a semantic strategy with no rule yet (`ElementIdStrategy`, `ReferenceElementStrategy`)', cite: ['docs/outstanding-work.md', '**Strategies**'] },
  'tree-step': { kind: 'decline', why: '`tree()`', cite: ['docs/outstanding-work.md', '**Step vocabulary (matrix-fill).** `tree`'] },
  'subgraph-step': { kind: 'decline', why: '`subgraph(\'sg\')`', cite: ['docs/outstanding-work.md', '`subgraph(\'sg\')`'] },
  'to-direction-step': { kind: 'decline', why: '`to(Direction, …)` / `toE(Direction, …)`', cite: ['docs/outstanding-work.md', '**Step vocabulary (matrix-fill).**'] },
  'local-scope-scalar': { kind: 'decline', why: 'a `Scope.local` reducer over a scalar value', cite: ['docs/outstanding-work.md', '`mean/sum(Scope.local)` over a value list'] },
  'inject-residue': { kind: 'decline', why: '`inject()` with a set literal, or a keyed `select(traversal)` over injected values', cite: ['docs/outstanding-work.md', 'inject list/set residue'] },
  'set-op-operand': { kind: 'decline', why: 'a set-op/`merge`/`conjoin` over a null or non-list operand', cite: ['docs/outstanding-work.md', '**Values** (corpus)'] },
  'split-residue': { kind: 'decline', why: '`split()` over a list or inside a body', cite: ['docs/outstanding-work.md', '(o-split)'] },
  'sack-residue': { kind: 'decline', why: '`withBulk(false)`, `normSack` and sack bodies', cite: ['docs/outstanding-work.md', '(o-sack)'] },
  'property-stream': { kind: 'decline', why: 'meta-property and property-stream reads', cite: ['docs/outstanding-work.md', '(o-propstream)'] },
  'path-value': { kind: 'decline', why: '`path()` read as a value (ordered, deduped, keyed, null members)', cite: ['docs/outstanding-work.md', '**Path as a value.**'] },
  'merge-residue': { kind: 'decline', why: '`mergeV`/`mergeE` shapes beyond the covered driver forms', cite: ['docs/outstanding-work.md', '**Merge residue.**'] },
  'match-residue': { kind: 'decline', why: '`match()` residue', cite: ['docs/outstanding-work.md', '**`match()` residue.**'] },
  'union-residue': { kind: 'decline', why: '`union()` as a source, a local reducer arm, or a re-sourced operand', cite: ['docs/outstanding-work.md', '**Source union**'] },
  'where-predicate': { kind: 'decline', why: '`where()`/`is()` predicates over labels, traversals and side effects', cite: ['docs/outstanding-work.md', '**Labels and scope**'] },
  'branch-choose-option': { kind: 'decline', why: 'body-keyed `branch()`/`choose()` with `option()`s', cite: ['docs/outstanding-work.md', 'body-keyed `choose`'] },
  'select-residue': { kind: 'decline', why: '`select()` over Pop/Column/traversal keys and map streams', cite: ['docs/outstanding-work.md', '`Pop.all/mixed`'] },
  'typeof-collection': { kind: 'decline', why: '`is(typeOf(LIST|SET|MAP))` over a collection value', cite: ['docs/outstanding-work.md', '**Families** (rank by `rel-blockers`)'] },
  'null-or-traversal-id': { kind: 'decline', why: '`V()`/`E()` with a null or a traversal id argument', cite: ['docs/outstanding-work.md', '**Families** (rank by `rel-blockers`)'] },
  'repeat-shape': { kind: 'decline', why: '`repeat()` body/modulator compositions', cite: ['docs/outstanding-work.md', '**Families** (rank by `rel-blockers`)'] },
  'group-side-effect': { kind: 'decline', why: '`group`/`groupCount`/`aggregate`/`sideEffect`/`cap` compositions', cite: ['docs/outstanding-work.md', '**Families** (rank by `rel-blockers`)'] },
  'index-step': { kind: 'decline', why: '`index()`', cite: ['docs/outstanding-work.md', '**Families** (rank by `rel-blockers`)'] },
  'add-element-residue': { kind: 'decline', why: '`addV`/`addE` with `with()` options or traversal arguments', cite: ['docs/outstanding-work.md', '**Families** (rank by `rel-blockers`)'] },
  'discard-residue': { kind: 'decline', why: '`discard()` followed by a barrier or a second step', cite: ['docs/outstanding-work.md', '**Families** (rank by `rel-blockers`)'] },
  'uncovered-composition': { kind: 'decline', why: 'another composition no lowering covers; the decline message names it', cite: ['docs/outstanding-work.md', '**Families** (rank by `rel-blockers`)'] },
} as const satisfies Record<string, Reason>;

export const EXPECTED_OUTCOMES: { readonly [K in ReasonKey]: readonly string[] } = {
  'nan-literal': [
    'InjectXNaNX_eqXnullX',
    'InjectXNaNX_gteXnullX',
    'InjectXNaNX_lteXnullX',
    'InjectXNaNX_neqX1dX',
    'InjectXNaNX_neqXNaNX',
    'InjectXNaNX_neqXnullX',
  ],
  'io-gryo-graphml': [
    'g_io_readXgraphmlX',
    'g_io_readXkryoX',
    'g_io_read_withXreader_graphmlX',
    'g_io_read_withXreader_gryoX',
  ],
  'connective-strategy': [
    'g_withoutStrategiesXConnectiveStrategyX_V_hasXname_markoX_or_whereXinXknowsX_hasXname_markoXX',
  ],
  'graph-computer-inert': [
    'g_withStrategiesXVertexProgramRestrictionStrategy_VertexProgramStrategyX_V',
  ],
  'vertex-property-ids': [
    'g_V_properties_order_id',
  ],
  'list-default-cardinality': [
    'g_V_hasXname_fooX_propertyXname_setXbarX_age_43X',
  ],
  'string-id-distinct': [
    'g_EX11AsStringX',
    'g_EX11X_outV_outE_hasXid_10AsStringX',
    'g_VX1AsStringX_outXknowsX',
    'g_VX1AsStringX_out_hasXid_2AsStringX',
    'g_VX1X_out_hasXid_2AsString_3AsStringX',
    'g_V_hasIdX1AsString_2AsString_nullX',
    'g_V_hasIdX2AsString_nullX',
    'g_addV_propertyXid_1X',
  ],
  'merge-type-error-text': [
    'g_V_fold_mergeXk_vX',
  ],
  'oncreate-override': [
    'g_withSideEffect_mergeEXout_vadasX_optionXonCreate_created_YX_optionXonMatch_created_NX_exists_updated_dynamic_override_sketchily_allowed',
  ],
  'binary-as-string': [
    'g_injectXBinaryXAA_eqeqXX',
    'g_injectXBinaryXAQIDXX',
    'g_injectXBinaryXAQIDXX_isXeqXBinaryXAQIDXXX',
    'g_injectXBinaryXemptyXX',
    'g_valuesXblobX_isXtypeOfXGType_BINARYXX',
  ],
  'call-traversal-params': [
    'g_V_callXdc_map_traversalX',
    'g_callXlist_map_traversalX',
  ],
  'multilabel-edge-label': [
    'g_withXmultilabelX_E_elementMap',
  ],
  't-token-order': [
    'g_VX1X_elementMap_orderXlocalX_byXkeys_ascXunfold',
    'g_VX1X_elementMap_orderXlocalX_byXkeys_descXunfold',
  ],
  'map-merge': [
    'g_V_asXnameX_projectXnameX_byXnameX_mergeXother_blueprintX',
    'g_V_elementMap_mergeXconstantXaXX',
    'g_V_hasXname_markoX_elementMap_mergeXV_hasXname_lopX_elementMapX',
  ],
  'subgraph-strategy': [
    'g_withStrategiesXSubgraphStrategyXsubgraphBXX_E',
    'g_withStrategiesXSubgraphStrategyXsubgraphBXX_VX1X_out',
    'g_withStrategiesXSubgraphStrategyXsubgraphBXX_VX1X_outE',
    'g_withStrategiesXSubgraphStrategyXsubgraphBXX_VX1X_outXcreatedX',
    'g_withStrategiesXSubgraphStrategyXsubgraphBXX_VX4X_both',
    'g_withStrategiesXSubgraphStrategyXsubgraphBXX_VX4X_bothE',
    'g_withStrategiesXSubgraphStrategyXsubgraphBXX_VX4X_out',
    'g_withStrategiesXSubgraphStrategyXsubgraphBXX_VX4X_outE',
    'g_withStrategiesXSubgraphStrategyXsubgraphBXX_VX4X_outV_outE',
    'g_withStrategiesXSubgraphStrategyXsubgraphBXX_VX4X_outXcreatedX',
    'g_withStrategiesXSubgraphStrategyXvertexProperties_hasXstartTime_gtX2005XXXX_V_asXaX_propertiesXlocationX_asXbX_selectXaX_outE_properties_selectXbX_value_dedup',
    'g_withStrategiesXSubgraphStrategyXvertexProperties_hasXstartTime_gtX2005XXXX_V_asXaX_valuesXlocationX_asXbX_selectXaX_outE_properties_selectXbX_dedup',
    'g_withStrategiesXSubgraphStrategyXvertexProperties_hasXstartTime_gtX2005XXXX_V_propertiesXlocationX_value',
    'g_withStrategiesXSubgraphStrategyXvertexProperties_hasXstartTime_gtX2005XXXX_V_valuesXlocationX',
    'g_withStrategiesXSubgraphStrategyXvertices_hasXname_neqXstephenXX_vertexProperties_hasXstartTime_gtX2005XXXX_V_propertiesXlocationX_value',
    'g_withStrategiesXSubgraphStrategyXvertices_hasXname_neqXstephenXX_vertexProperties_hasXstartTime_gtX2005XXXX_V_valuesXlocationX',
    'g_withStrategiesXSubgraphStrategyXvertices_in_hasXname_markoX_outXcreatedX_hasXname_lopXXXX_V_name',
  ],
  'partition-upsert': [
    'g_withStrategiesXPartitionStrategyXwrite_a_read_aXX_injectX0X__mergeV_optionXonCreateX',
    'g_withStrategiesXPartitionStrategyXwrite_a_read_aXX_injectX0X_mergeV',
    'g_withStrategiesXPartitionStrategyXwrite_a_read_aXX_injectX0XmergeE',
    'g_withStrategiesXPartitionStrategyXwrite_a_read_aXX_mergeE',
    'g_withStrategiesXPartitionStrategyXwrite_a_read_aXX_mergeV',
    'g_withStrategiesXPartitionStrategyXwrite_a_read_aXX_mergeVXlabel_person_name_aliceX_optionXonMatch_name_bobX',
    'g_withStrategiesXPartitionStrategyXwrite_a_read_aXX_mergeV_optionXonCreateX',
  ],
  'strategy-residue': [
    'g_withStrategiesXElementIdStrategyX_V',
    'g_withStrategiesXReferenceElementStrategyX_V',
  ],
  'tree-step': [
    'g_VX1X_outE_inV_bothE_otherV_tree',
    'g_VX1X_outE_inV_bothE_otherV_tree_byXnameX_byXlabelX',
    'g_VX1X_out_out_out_tree',
    'g_VX1X_out_out_tree',
    'g_VX1X_out_out_treeXaX_both_both_capXaX',
    'g_VX1X_out_out_treeXaX_byXlabelX_both_both_capXaX',
    'g_VX1X_out_out_treeXaX_byXnameX_both_both_capXaX',
    'g_VX1X_out_out_tree_byXlabelX',
    'g_VX1X_out_out_tree_byXnameX',
    'g_V_out_order_byXnameX_localXtreeXaX_selectXaX_countXlocalXX',
    'g_V_out_treeXaX_selectXaX_countXlocalX',
    'g_V_out_tree_byXageX',
    'g_V_out_tree_isXtypeOfXGType_TREEXX_count',
    'g_V_whereXtree_isXtypeOfXGType_TREEXXX_values_name',
  ],
  'subgraph-step': [
    'g_E_hasXweight_0_5X_subgraphXaX_selectXaX',
    'g_VX1X_outEXknowsX_subgraphXsgX_name_capXsgX',
    'g_VX1X_outEXknowsX_subgraphXsgX_name_capXsgX_isX_notXtypeOfXGType_GRAPHXXX_count',
    'g_VX1X_outEXknowsX_subgraphXsgX_name_capXsgX_isXtypeOfXGType_GRAPHXX_count',
    'g_V_outEXknowsX_subgraphXsgX_capXsgX_asString',
    'g_V_outEXnoexistX_subgraphXsgXcapXsgX',
    'g_V_repeatXbothEXcreatedX_subgraphXsgX_outVX_timesX5X_name_dedup_capXsgX',
  ],
  'to-direction-step': [
    'g_VX1X_to_XOUT_knowsX',
    'g_V_toEXout_knowsvarX_valuesXweightX',
  ],
  'local-scope-scalar': [
    'g_VX1X_valuesXageX_dedupXlocalX_unfold',
    'g_VX1X_valuesXageX_maxXlocalX',
    'g_VX1X_valuesXageX_meanXlocalX',
    'g_VX1X_valuesXageX_minXlocalX',
    'g_VX1X_valuesXageX_orderXlocalX',
    'g_VX1X_valuesXageX_sumXlocalX',
  ],
  'inject-residue': [
    'g_injectX10_20_null_20_10_10X_groupCountXxX_dedup_asXyX_projectXa_bX_by_byXselectXxX_selectXselectXyXXX',
    'g_injectX1_1X_set',
    'g_injectX1_3_100_300X_set',
  ],
  'set-op-operand': [
    'g_V_valuesXnameX_combineXV_foldX',
    'g_V_valuesXnameX_conjoinX1X',
    'g_V_valuesXnameX_differenceXV_foldX',
    'g_V_valuesXnameX_disjunctXV_foldX',
    'g_V_valuesXnameX_intersectXV_foldX',
    'g_V_valuesXnameX_mergeXV_foldX',
    'g_V_valuesXnameX_productXV_foldX',
    'g_injectXnullX_combineXinjectX1XX',
    'g_injectXnullX_conjoinX1X',
    'g_injectXnullX_differenceXinjectX1XX',
    'g_injectXnullX_disjunctXinjectX1XX',
    'g_injectXnullX_intersectXinjectX1XX',
    'g_injectXnullX_mergeXinjectX1XX',
    'g_injectXnullX_productXinjectX1XX',
  ],
  'split-residue': [
    'g_V_hasLabelXpersonX_valueXnameX_order_fold_splitXlocal_aX_unfold',
    'g_V_hasLabelXpersonX_valueXnameX_order_fold_splitXlocal_emptyX_unfold',
    'g_V_valuesXnameX_flatMapXsplitXaX_unfoldX',
    'g_injectXListXa_bXcX_splitXa_bX',
  ],
  'sack-residue': [
    'g_V_sackXassignX_byX_hasLabelXpersonX_count_asBoolX_sackXandX_byX_outE_count_asBoolX_sack_path',
    'g_withBulkXfalseX_withSackX1_sumX_VX1X_localXoutEXknowsX_barrierXnormSackX_inVX_inXknowsX_barrier_sack',
    'g_withBulkXfalseX_withSackX1_sumX_V_out_barrier_sack',
    'g_withSackX1_sumX_VX1X_localXoutXknowsX_barrierXnormSackXX_inXknowsX_barrier_sack',
    'g_withSackX30X_V_valuesXageX_isXgtXsackXX',
  ],
  'property-stream': [
    'g_EX11X_propertiesXweightX_asXaX_selectXaX_byXkeyX',
    'g_EX11X_propertiesXweightX_asXaX_selectXaX_byXvalueX',
    'g_VXv7_properties_properties_element_element',
    'g_V_both_properties_properties_dedup_count',
    'g_V_hasXname_markoX_propertyXfriendWeight_outEXknowsX_weight_sum__acl_privateX',
    'g_V_properties_hasLabelXnullX',
    'g_V_properties_propertiesXstartTimeX_drop',
    'g_V_properties_properties_element_element',
    'g_addVXpersonX_propertyXsingle_name_stephenX_propertyXsingle_name_stephenm_since_2010X',
    'g_injectX0X_mergeVXlabel_person_name_markoX_propertyXname_vadas_acl_publicX',
    'g_mergeVXlabel_person_name_markoX_propertyXname_vadas_acl_publicX',
    'get_g_addVXpersonX_propertyXsingle_name_stephenX_propertyXsingle_name_stephenm_since_2010X',
  ],
  'path-value': [
    'g_V_asXa_bX_out_asXcX_path_selectXkeysX',
    'g_V_hasXperson_name_markoX_path_asXaX_unionXidentity_identityX_selectXaX_unfold',
    'g_V_out_out_properties_asXheadX_path_order_byXascX_selectXheadX_value',
    'g_V_out_out_properties_asXheadX_path_order_byXdescX_selectXheadX_value',
    'g_V_out_out_values_asXheadX_path_order_byXascX_selectXheadX',
    'g_V_out_out_values_asXheadX_path_order_byXdescX_selectXheadX',
    'g_injectX1_null_nullX_path',
    'g_injectX1_null_nullX_path_dedup',
  ],
  'merge-residue': [
    'g_V_mapXmergeXlabel_person_name_joshXX',
    'g_V_mergeEXlabel_knows_out_marko_in_vadasX_optionXonMatch_sideEffectXpropertyXweight_0XX_constantXemptyXX',
    'g_injectXlist1_list2_list3X_fold_asXmX_mergeVXselectXmX_limitXlocal_1X_unfoldX_optionXonCreate_selectXmX_rangeXlocal_1_2X_unfoldX_optionXonMatch_selectXmX_tailXlocalX_unfoldX_to_create',
    'g_injectXlist1_list2_list3X_fold_asXmX_mergeVXselectXmX_limitXlocal_1X_unfoldX_optionXonCreate_selectXmX_rangeXlocal_1_2X_unfoldX_optionXonMatch_selectXmX_tailXlocalX_unfoldX_to_match',
    'g_mergeEXlabel_knows_out_marko_in_vadasX_optionXonMatch_sideEffectXpropertyXweight_0XX_constantXemptyXX',
    'g_mergeE_inline_with_outVinV_options_map',
    'g_mergeE_with_outVinV_options_map',
    'g_unionXselectXmapX_selectXmapX_constantXcreated_NXX_fold_asXmX_mergeEXselectXmX_limitXlocal_1X_unfoldX_optionXonCreate_selectXmX_rangeXlocal_1_2X_unfoldX_optionXonMatch_selectXmX_tailXlocalX_unfoldX_to_create',
    'g_unionXselectXmapX_selectXmapX_constantXcreated_NXX_fold_asXmX_mergeEXselectXmX_limitXlocal_1X_unfoldX_optionXonCreate_selectXmX_rangeXlocal_1_2X_unfoldX_optionXonMatch_selectXmX_tailXlocalX_unfoldX_to_match',
    'g_withSideEffectXc_created_YX_withSideEffectXm_matchedX_mergeEXlabel_knows_out_marko_in_vadasX_optionXonCreate_selectXcXX_optionXonMatch_sideEffectXpropertiesXweightX_dropX_selectXmXX_exists',
    'g_withSideEffectXc_label_person_name_markoX_withSideEffectXm_age_19X_mergeVXselectXcXX_optionXonMatch_sideEffectXpropertiesXageX_dropX_selectXmXX_option',
    'g_withSideEffectXm_age_19X_V_hasXperson_name_markoX_mergeVXselectXcXX_optionXonMatch_sideEffectXpropertiesXageX_dropX_selectXmXX_option',
  ],
  'match-residue': [
    'g_V_matchXa_hasXsong_name_sunshineX__a_mapX0followedBy_weight_meanX_b__a_0followedBy_c__c_filterXweight_whereXgteXbXXX_outV_dX_selectXdX_byXnameX',
    'g_V_valueMap_matchXa_selectXnameX_bX',
    'g_match_anyXknowsX_any_selectXaX_byXnameX_concatXconstant_selectXbX_byXnameXX',
  ],
  'union-residue': [
    'g_VX1_2X_localXunionXcountXX',
    'g_VX1_2X_localXunionXoutE_count__inE_count__outE_weight_sumXX',
    'g_VX1_2X_unionXoutE_count__inE_count__outE_weight_sumX',
    'g_V_hasXname_withinXunionXVXvid1X_outXknowsX_valuesXnameX_constantXpeterXX_foldXX',
    'g_V_hasXperson_name_markoX_elementMapXnameX_asXaX_unionXidentity_identityX_selectXaX_selectXnameX',
    'g_unionXV_out_out_V_hasLabelXsoftwareXX_path',
    'g_unionXV_out_out_V_hasLabelXsoftwareXX_path_byXnameX',
    'g_unionXunionXV_out_outX_V_hasLabelXsoftwareXX_path_byXnameX',
  ],
  'where-predicate': [
    'InjectX1dX_whereXnotXisXltXNaNXXXX',
    'g_VX1X_asXaX_V_valuesXageX_whereXeqXVXvid1X_valuesXageXX_orXeqXaXXX_byX_byXageX',
    'g_VX1X_asXaX_V_valuesXageX_whereXgteXconstantX0XX_andXneqXaXXX_byX_byXageX',
    'g_VX1X_asXaX_V_valuesXageX_whereXneqXaX_andXgtXVXvid1X_valuesXageXXXX_byX_byXageX',
    'g_VX1X_asXaX_out_hasXageX_whereXgtXaXX_byXageX_name',
    'g_VXvid1X_asXaX_V_valuesXageX_isXgtXselectXaX_valuesXageXXX',
    'g_V_asXaX_out_asXbX_whereXin_count_isXeqX3XX_or_whereXoutXcreatedX_and_hasXlabel_personXXX_selectXa_bX',
    'g_V_hasXname_notXidentityXX',
    'g_V_out_whereXhasXnameX_order_byXnameX_limitX1XX_out_whereXhasXnameX_order_byXnameX_limitX1XX',
    'g_V_whereXgtXVXvid1X_valuesXageXXX_byXageX_valuesXnameX',
    'g_withSideEffectXa_g_VX2XX_VX1X_out_whereXneqXaXX',
    'g_withSideEffectXa_josh_peterX_VX1X_outXcreatedX_inXcreatedX_name_whereXwithinXaXX',
    'g_withStrategiesXProductiveByStrategyX_VX3X_asXaX_in_out_asXbX_whereXa_eqXbXX_byXageX_name',
  ],
  'branch-choose-option': [
    'g_V_branchXageX_optionXltX30X__youngX_optionXgtX30X__oldX_optionXnone__on_the_edgeX',
    'g_V_branchXidentityX_optionXhasLabelXsoftwareX__inXcreatedX_name_order_foldX_optionXhasXname_vadasX__ageX_optionXneqX123X__bothE_countX',
    'g_V_branchXlabel_isXpersonX_countX_optionX1__ageX_optionX0__langX_optionX0__nameX',
    'g_V_branchXlabel_isXpersonX_countX_optionX1__ageX_optionX0__langX_optionX0__nameX_optionXany__labelX',
    'g_V_chooseXhasLabelXpersonX_localXchooseXageX_optionXbetweenX26_30X_name_foldX_optionXnone_name_foldXX',
    'g_V_chooseXhasLabelXpersonX_mapXchooseXageX_optionXbetweenX26_30X_name_foldX_optionXnone_name_foldXX',
    'g_V_chooseXlabelX_optionXperson__chooseXageX_optionXP_lt_30__constantXyoungXX_optionXP_gte_30__constantXoldXXX_optionXsoftware__constantXprogramXX_optionXnone__constantXunknownXX',
    'g_V_chooseXoutE_count_isX0X__asXaX__asXbXX_chooseXselectXaX__selectXaX__selectXbXX',
    'g_V_hasLabelXhabitat_reptileX_branchXidentityX_optionXhasLabelXaquaticXX_optionXhasLabelXreptileXX_optionXhasLabelXhabitatXX_multilabel',
    'g_V_hasLabelXpersonX_chooseX_valuesXnameX_option1X_isXmarkoX_valuesXageXX_option2Xnone_valuesXnameXX',
    'g_V_hasLabelXpersonX_chooseXlocalXoutXknowsX_countX__optionX0__constantXnoFriendsXX__optionXnone__constantXhasFriendsXXX',
    'g_unionXV_VXhasLabelXpersonX_barrier_localXchooseXageX_optionXbetweenX26_30X_name_foldX_optionXnone_name_foldXX',
    'g_unionXV_VXhasLabelXpersonX_barrier_mapXchooseXageX_optionXbetweenX26_30X_name_foldX_optionXnone_name_foldXX',
  ],
  'select-residue': [
    'g_V_asXaX_outXknowsX_asXaX_selectXall_constantXaXX',
    'g_V_asXaX_out_asXaX_out_asXaX_selectXmixed_aX_byXlimitXlocal_0XX_tailXlocal_1X',
    'g_V_hasLabelXsoftwareX_asXnameX_asXlanguageX_asXcreatorsX_selectXname_language_creatorsX_byXnameX_byXlangX_byXinXcreatedX_name_fold_orderXlocalXX',
    'g_V_out_asXxX_in_asXyX_selectXx_yX_byXnameX_fold_dedupXlocal_x_yX_unfold',
    'g_V_valueMap_projectXxX_byXselectXnameXX',
    'g_V_valueMap_unfold_mapXselectXkeysXX',
    'g_withPath_V_asXaX_out_out_asXbX_mapXselectXaX_valuesXnameX_concatXselectXbX_valuesXnameXXX',
  ],
  'typeof-collection': [
    'g_V_valueMap_selectXkeysX_dedup_isXtypeOfXGType_SETXX',
    'g_V_valueXnameX_aggregateXxX_capXxX_isXtypeOfXGType_SETX',
    'g_V_valuesXageX_isXtypeOfXGType_MAPXX',
    'g_V_valuesXlistX_isXtypeOfXGType_LISTXX_project_byXidentityX_byXcountXlocalX',
    'g_V_valuesXlistX_isXtypeOfXGType_LISTXX_whereXcountXlocalX_isXgtX2XXX',
    'g_V_valuesXmapX_isXtypeOfXGType_MAPXX',
    'g_V_valuesXmapX_isXtypeOfXGType_MAPXX_countXlocalX',
    'g_V_valuesXmapX_isXtypeOfXGType_MAPXX_foldX',
    'g_V_valuesXmapX_isXtypeOfXGType_MAPXX_selectXvaluesX',
    'g_V_valuesXmapX_isXtypeOfXGType_MAPXX_whereX_countXlocalX_isXgtX1XXX',
    'g_V_valuesXnameX_fold_isXtypeOfXGType_LISTXX_count',
    'g_V_valuesXsetX_isXtypeOfXGType_SETXX_whereXcountXlocalX_isXeqX3XXX',
    'g_injectXlistX_isXtypeOfXGType_LISTXX_groupCount',
    'g_injectXsetX_isXtypeOfXGType_SETXX_groupCount',
  ],
  'null-or-traversal-id': [
    'g_EX11_nullX',
    'g_EXVXvid1X_outE_idX',
    'g_EXlistXnullXX',
    'g_EXnullX',
    'g_VX1_nullX',
    'g_VXVXvid1X_idX_name',
    'g_VXlistXnullXX',
    'g_VXnullX',
    'g_VXvid1X_EXoutE_idX',
    'g_VXvid1X_VXoutXknowsX_idX_name',
    'g_VXvid1X_id_VXidentityX_name',
    'g_VXvid1X_id_asXbookmarkX_V_hasXname_joshX_VXselectXbookmarkXX_name',
    'g_VXvid1X_outEXknowsX_hasXinV_name_vadasX_id_EXidentityX',
    'g_VXvid1_vid2X_id_VXidentityX_name',
    'g_V_EXlistXnullXX',
    'g_V_EXnullX',
    'g_V_VXoutXknowsX_idX_valuesXnameX_passes_verification',
    'g_injectX1X_EX11_nullX',
    'g_injectX1X_VX1_nullX',
    'g_injectX1X_VXnullX',
    'g_injectX9999X_EXidentityX',
    'g_injectX9999X_VXidentityX',
  ],
  'repeat-shape': [
    'g_VX1X_asXaX_repeatXout_asXaXX_timesX2X_selectXfirst_aX',
    'g_VX1X_asXaX_repeatXout_asXaXX_timesX2X_selectXlast_aX',
    'g_VX1X_repeatXbothEXcreatedX_whereXwithoutXeXX_aggregateXeX_otherVX_emit_path',
    'g_VX1X_repeatXgroupCountXmX_byXloopsX_outX_timesX3X_capXmX',
    'g_VX1X_repeatXrepeatXunionXout_uses_out_traversesXX_whereXloops_isX0X_timesX1X_timeX2X_name',
    'g_VX1_2_3X_repeatXboth_barrierX_emit_timesX2X_path',
    'g_VX250X_repeatXout_localXorder_byXperformancesX_tailX1XXX_timesX2X_valuesXnameX',
    'g_VX2X_repeatXout_localXorder_byXperformancesX_tailX1XXX_timesX1X_valuesXnameX',
    'g_VX3X_repeatXbothX_createdXX_untilXloops_is_40XXemit_repeatXin_knowsXX_emit_loopsXisX1Xdedup_values',
    'g_VX3X_repeatXoutE_order_byXweightX_tailX2X_inVX_timesX2X_valuesXnameX',
    'g_VX3X_repeatXout_order_byXperformancesX_tailX2XX_timesX1X_valuesXnameX',
    'g_VX3X_repeatXout_order_byXperformancesX_tailX2XX_timesX2X_valuesXnameX',
    'g_VX3X_repeatXout_order_byXperformancesX_tailX3X_limitX1XX_timesX2X_valuesXnameX',
    'g_VX3X_repeatXout_order_byXperformances_descX_limitX5X_tailX1XX_timesX2X_valuesXnameX',
    'g_VX5X_repeatXlimitX1X_inX_untilXloopsXisX2XXX_valuesXnameX',
    'g_VX5X_repeatXrangeX0_1X_inX_untilXloopsXisX2XXX_valuesXnameX',
    'g_VX6X_repeatXa_bothXcreatedX_simplePathX_emitXrepeatXb_bothXknowsXX_untilXloopsXbX_asXb_whereXloopsXaX_asXbX_hasXname_vadasXX_dedup_name',
    'g_V_asXaX_repeatXbothX_timesX3X_emit_name_asXbX_group_byXselectXaXX_byXselectXbX_dedup_order_foldX_selectXvaluesX_unfold_dedup',
    'g_V_emit',
    'g_V_emitXhasLabelXpersonXX_repeatXout_order_byXnameXX_timesX2X_valuesXnameX',
    'g_V_emit_repeatXa_outXknows_filterXloops_isX0XX_lang',
    'g_V_emit_repeatXlocalXout_order_byXnameXXX_timesX2X_valuesXnameX',
    'g_V_hasXnameXHEY_BO_DIDDLEYXX_repeatXunionXoutXfollowedByX_order_byXnameX_limitX2X_outXsungByX_order_byXnameX_limitX1XXX_timesX2X',
    'g_V_hasXperson_name_markoX_repeatXoutXcreatedXX_timesX0X_name',
    'g_V_hasXperson_name_markoX_timesX0X_repeatXoutXcreatedXX_name',
    'g_V_localXemit_repeatXlocalXout_order_byXnameXXX_timesX2X_valuesXnameXX',
    'g_V_order_byXnameX_repeatXlocalXboth_simplePath_order_byXnameXXX_timesX2X_path',
    'g_V_order_byXname_descX_repeatXlocalXout_order_byXnameXXX_timesX1X',
    'g_V_playlist_paths',
    'g_V_repeatXa_outXknows_repeatXb_outXcreatedX_filterXloops_isX0XX_emit_lang',
    'g_V_repeatXaddV_propertyXgenerated_trueXX_timesX2X',
    'g_V_repeatXdedup_bothX_timesX2X',
    'g_V_repeatXoutXknowsXX_untilXrepeatXoutXcreatedXX_emitXhasXname_lopXXX_path_byXnameX',
    'g_V_repeatXout_groupXaX_byXnameX_byXcountX_timesX2X_capXaX',
    'g_V_repeatXout_whereXhasXnameX_order_byXnameX_limitX1XXX_timesX2X',
    'g_V_repeatXrepeatXout_createdXX_untilXhasXname_rippleXXXemit_lang',
    'g_V_repeatXunionXconstantXyX_limitX1X_identityXX_timesX3X',
    'g_V_repeatXunionXoutXknowsX_order_byXnameX_inXcreatedX_order_byXnameXXX_timesX1X',
    'g_V_shortestpath',
    'g_V_timesX5X',
    'g_V_unionXrepeatXunionXoutXcreatedX__inXcreatedXX_timesX2X__repeatXunionXinXcreatedX__outXcreatedXX_timesX2XX_label_groupCount',
    'g_V_untilXconstantXtrueXX_repeatXrepeatXout_createdXX_untilXhasXname_rippleXXXemit_lang',
    'g_V_untilXidentityX',
    'g_V_untilXloops_isX2XX_repeatXout_order_byXnameXX_valuesXnameX',
    'g_V_untilXout_outX_repeatXin_asXaXX_selectXaX_byXtailXlocalX_nameX',
    'g_V_untilXout_outX_repeatXin_asXaX_in_asXbXX_selectXa_bX_byXnameX',
    'g_V_valuesXstrX_repeatXsplitXabcX_conjoinX_timesX2X',
    'g_addV_asXfirstX_repeatXaddEXnextX_toXaddVX_inVX_timesX5X_addEXnextX_toXselectXfirstXX',
    'g_withSackX0X_V_repeatXoutE_sackXsumX_byXweightX_inVX_timesX2X_sack',
    'g_withSackX0X_V_repeatXsackXsumX_byXageX_whereXsack_isXltX59XXXX_timesX2X',
    'g_withSackX1X_injectX1X_repeatXsackXsumX_byXconstantX1XXX_timesX5X_emit_mathXsin__X_byXsackX',
    'g_withStrategiesXRepeatUnrollStrategyX_V_repeatXbothE_otherV_hasXage_ltX30XXX_timesX2X',
    'g_withStrategiesXRepeatUnrollStrategyX_V_repeatXboth_sampleX1XX_timesX2X',
    'g_withoutStrategiesXRepeatUnrollStrategyX_V_repeatXbothE_otherV_hasXage_ltX30XXX_timesX2X',
    'g_withoutStrategiesXRepeatUnrollStrategyX_V_repeatXboth_sampleX1XX_timesX2X',
  ],
  'group-side-effect': [
    'g_VX1X_out_aggregateXxX_out_whereXnotXwithinXaXXX',
    'g_V_aggregateXxX_byXout_order_byXnameXX_capXxX',
    'g_V_asXaX_groupXmX_by_byXbothE_countX_barrier_selectXmX_selectXselectXaXX',
    'g_V_asXaX_groupXmX_by_byXbothE_countX_barrier_selectXmX_selectXselectXaXX_byXmathX_plus_XX',
    'g_V_both_groupCountXaX_byXlabelX_asXbX_barrier_whereXselectXaX_selectXsoftwareX_isXgtX2XXX_selectXbX_name',
    'g_V_chooseXlabel_person__age_groupCountXaX__name_groupCountXbXX_capXa_bX_unfold',
    'g_V_classic_recommendation',
    'g_V_classic_recommendation_ranked',
    'g_V_coworker',
    'g_V_coworker_with_midV',
    'g_V_groupXmX_byXnameX_byXinXknowsX_nameX_capXmX',
    'g_V_group_byXlabelX_byXbothE_groupXaX_byXlabelX_byXweight_sumX_weight_sumX',
    'g_V_group_byXvaluesXnameXX_byXout_fold_countXlocalX_isXgtX0XXX',
    'g_V_group_byXvaluesXnameXX_byXvaluesXageX_fold_unfoldX',
    'g_V_group_byXvaluesXnameX_sideEffectXconstantXzyxXX_substringX1XX_byXconstantX1X_sideEffectXconstantXxyzXXX',
    'g_V_hasLabelXpersonX_asXpX_mapXbothE_label_groupCountX_asXrX_selectXp_rX',
    'g_V_hasLabelXpersonX_chooseXageX__optionX27L__constantXyoungXX_optionXnone__constantXoldXX_groupCount',
    'g_V_hasLabelXpersonX_localXaggregateXaXX_outE_inV_simplePath_localXaggregateXaXX_capXaX_unfold_hasLabelXsoftwareX_count',
    'g_V_hasLabelXreptileX_group_byXlabels_order_foldX_byXname_foldX',
    'g_V_hasLabelXsongX_groupXaX_byXnameX_byXproperties_groupCount_byXlabelXX_out_capXaX',
    'g_V_hasLabelXsongX_group_byXnameX_byXproperties_groupCount_byXlabelXX',
    'g_V_hasXperson_name_withinXvadas_peterXX_groupXaX_by_byXout_orderX_capXaX',
    'g_V_hasXperson_name_withinXvadas_peterXX_group_by_byXout_orderX',
    'g_V_label_groupCount_asXxX_selectXxX',
    'g_V_localXaggregateXaXX_bothE_sampleX1X_otherV_localXaggregateXaXX_capXaX_unfold_groupCount_byXlabelX',
    'g_V_localXaggregateXaXX_outE_hasXweight_lgtX0_5XX_inV_localXaggregateXaXX_capXaX_unfold_path',
    'g_V_localXgroupCountXaX_selectXaX_countXlocalXX',
    'g_V_localXgroupXaX_byXnameX_by_selectXaX_countXlocalXX',
    'g_V_outE_weight_groupCount_unfold_selectXkeysX_unfold',
    'g_V_outE_weight_groupCount_unfold_selectXvaluesX_unfold',
    'g_V_outXfollowedByX_group_byXsongTypeX_byXbothE_group_byXlabelX_byXweight_sumXX',
    'g_V_out_aggregateXaX_path',
    'g_V_sideEffectXidentityX',
    'g_V_sideEffectXidentity_valuesXnameXX',
    'g_V_sideEffectXpropertyXsingle_age_22X',
    'g_withSideEffectXa__marko_666_noone_blahX_V_groupXaX_byXnameX_byXoutE_label_foldX_capXaX',
    'g_withSideEffectXx_setX_V_both_both_sideEffectXlocalXaggregateXxX_byXnameXX_capXxX_unfold',
    'g_withStrategiesXProductiveByStrategyX_V_aggregateXxX_byXout_order_byXnameXX_capXxX',
  ],
  'index-step': [
    'g_VX1X_valuesXageX_index_unfold_unfold',
    'g_V_hasLabelXpersonX_name_fold_orderXlocalX_index_withXmapX',
    'g_V_hasLabelXsoftwareX_index_unfold',
    'g_V_hasLabelXsoftwareX_name_fold_orderXlocalX_index_unfold_order_byXtailXlocal_1XX',
    'g_V_hasLabelXsoftwareX_order_byXnameX_index_withXmapX',
  ],
  'add-element-residue': [
    'g_V_limitX3X_addVXsoftwareX_aggregateXa1X_byXlabelX_aggregateXa2X_byXlabelX_capXa1_a2X_selectXa_bX_byXunfoldX_foldX',
    'g_addEXV_outE_label_groupCount_orderXlocalX_byXvalues_descX_selectXkeysX_unfold_limitX1XX_fromXV_hasXname_vadasXX_toXV_hasXname_lopXX',
    'g_addEXedgeX_fromXV_hasXname_markoXX_toXV_hasXname_vadasXX_propertyXweight_0_5X_withXkey_valueX_valuesXweight_keyX',
    'g_addEXknowsX_fromXV_hasXname_markoXX_toXV_hasXname_vadasXX_propertyXweight_0_5X_addEXknowsX_fromXV_hasXname_markoXX',
    'g_addV_propertyXname_markoX_withXkey_valueX_valuesXname_keyX',
    'g_addV_propertyXname_marko_since_2010X_withXkey_valueX_propertiesXnameX_valuesXsince_keyX',
    'g_withSideEffectXb_bX_VXaX_addEXknowsX_toXbX_propertyXweight_0_5X',
  ],
  'discard-residue': [
    'g_V_discard_discard',
    'g_V_discard_fold',
    'g_V_discard_fold_constantX1X',
    'g_V_discard_fold_discard',
    'g_V_projectXxX_byXcoalesceXage_isXgtX29XX_discardXX_selectXxX',
  ],
  'uncovered-composition': [
    'g_VX1X_out_name_injectXdanielX_asXaX_mapXlengthX_path',
    'g_E_filterXisX0XX',
    'g_VX1X_optionalXaddVXdogXX_label',
    'g_VXvid2X_propertyXVXvid1X_projectXfriendCount_softwareCreatedXX',
    'g_V_filterXisX0XX',
    'g_V_hasLabelXhabitatX_dedup_byXlabels_order_foldX_localXlabels_order_foldX_multilabel',
    'g_V_hasLabelXhabitatX_order_byXlabels_order_foldX_name_multilabel',
    'g_V_hasXname_rippleX_inXcreatedX_peerPressure_withXedges_outEX_withyXpropertyName_clusterX_repeatXunionXidentity__bothX_timesX2X_dedup_valueMapXname_clusterX',
    'g_V_localXout_localXcountXX',
    'g_V_mapXbothE_weight_foldX_order_byXsumXlocalX_descX_byXcountXlocalX_descX',
    'g_V_mapXconstantXnullXX',
    'g_V_mapXin_hasIdX1XX_limitX2X_valuesXnameX',
    'g_V_out_in_valuesXnameX_fold_dedupXlocalX',
    'g_V_sampleX1X_byXageX_count',
    'g_V_valueMapXname_ageX_withXtokens_idsX_byXunfoldX',
    'g_V_valueMapXname_ageX_withXtokens_labelsX_byXunfoldX',
    'g_addVXconstantXprefix_X_concatXVX1X_labelX_label',
    'g_injectX0X_V_both_coalesceXhasXname_markoX_both_constantX0XX_cyclicPath_path',
    'g_injectX0X_V_both_coalesceXhasXname_markoX_both_constantX0XX_simplePath_path',
    'g_injectX1X_coalesceXEX_hasLabelXtestsX_addEXtestsX_from_V_hasXnameX_XjoshXX_toXV_hasXnameX_XvadasXXX',
    'g_injectX1_2_3_4X_unfold_asNumber',
    'g_injectXListXa_bXcX_concat_XdX',
  ],
};

export type ReasonKey = keyof typeof REASONS;

/** The ledger as a MULTISET of scenario names — a name failing twice (two scenarios share a generated
 *  name, test/CLAUDE.md) is listed twice. */
export function ledgeredCounts(ledger: { readonly [K in ReasonKey]?: readonly string[] } = EXPECTED_OUTCOMES): Map<string, number> {
  const counts = new Map<string, number>();
  for (const names of Object.values(ledger)) for (const n of names ?? []) counts.set(n, (counts.get(n) ?? 0) + 1);
  return counts;
}

/** The reason a ledgered name carries, or undefined. */
export function reasonOf(name: string, ledger: { readonly [K in ReasonKey]?: readonly string[] } = EXPECTED_OUTCOMES): ReasonKey | undefined {
  for (const [key, names] of Object.entries(ledger) as [ReasonKey, readonly string[]][]) if (names.includes(name)) return key;
  return undefined;
}

export interface LedgerAudit {
  /** Fails more often than it is ledgered: an UNEXPLAINED failure (a regression the ratchet also sees,
   *  or a new scenario a pin bump brought in). */
  readonly unledgered: string[];
  /** Ledgered more often than it fails: it now PASSES (`passes`), or left scope. Delete it here. */
  readonly stale: { readonly name: string; readonly passes: boolean }[];
}

/**
 * Compare the ledger to a run's outcome BY MULTIPLICITY. `failed` and `passed` are scenario LISTS, a
 * name repeated once per scenario. Both invariants in one comparison: (a) every failure is ledgered,
 * (b) nothing ledgered passes. Equal counts satisfy both; any surplus on either side is named.
 */
export function auditLedger(failed: readonly string[], passed: readonly string[], ledger: { readonly [K in ReasonKey]?: readonly string[] } = EXPECTED_OUTCOMES): LedgerAudit {
  const failing = new Map<string, number>();
  for (const n of failed) failing.set(n, (failing.get(n) ?? 0) + 1);
  const ledgered = ledgeredCounts(ledger);
  const passing = new Set(passed);
  const unledgered: string[] = [];
  const stale: { name: string; passes: boolean }[] = [];
  for (const [n, k] of failing) for (let i = ledgered.get(n) ?? 0; i < k; i++) unledgered.push(n);
  for (const [n, k] of ledgered) for (let i = failing.get(n) ?? 0; i < k; i++) stale.push({ name: n, passes: passing.has(n) });
  return { unledgered: unledgered.sort(), stale: stale.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** One query a scenario issued, as the L3 telemetry records it (`telemetry.ts` `QueryRecord`). */
export interface ScenarioQuery {
  readonly scenario?: string;
  readonly ok: boolean;
  readonly declined?: boolean;
}

/**
 * The `decline`-kind names whose run did NOT raise `UnsupportedTraversal`. A decline is only an
 * expected outcome while it is a CLEAN REFUSAL; once the scenario answers (or fails some other way) the
 * ledger's claim is false, and if the answer is wrong that is a defect wearing a decline's name. Only
 * names the run actually exercised are judged — an out-of-scope name has no queries to read.
 */
export function declinesThatAnswered(queries: readonly ScenarioQuery[], exercised: ReadonlySet<string>, ledger: { readonly [K in ReasonKey]?: readonly string[] } = EXPECTED_OUTCOMES): string[] {
  const declined = new Set<string>();
  for (const q of queries) if (q.scenario && !q.ok && q.declined) declined.add(q.scenario);
  const out: string[] = [];
  for (const [key, names] of Object.entries(ledger) as [ReasonKey, readonly string[]][]) {
    if (REASONS[key].kind !== 'decline') continue;
    for (const n of names) if (exercised.has(n) && !declined.has(n)) out.push(n);
  }
  return out.sort();
}
