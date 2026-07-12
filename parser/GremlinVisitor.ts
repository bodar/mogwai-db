
import { AbstractParseTreeVisitor } from "antlr4ng";


import { QueryListContext } from "./GremlinParser.js";
import { QueryContext } from "./GremlinParser.js";
import { EmptyQueryContext } from "./GremlinParser.js";
import { TraversalSourceContext } from "./GremlinParser.js";
import { TransactionPartContext } from "./GremlinParser.js";
import { RootTraversalContext } from "./GremlinParser.js";
import { TraversalSourceSelfMethodContext } from "./GremlinParser.js";
import { TraversalSourceSelfMethod_withBulkContext } from "./GremlinParser.js";
import { TraversalSourceSelfMethod_withPathContext } from "./GremlinParser.js";
import { TraversalSourceSelfMethod_withSackContext } from "./GremlinParser.js";
import { TraversalSourceSelfMethod_withSideEffectContext } from "./GremlinParser.js";
import { TraversalSourceSelfMethod_withStrategiesContext } from "./GremlinParser.js";
import { TraversalSourceSelfMethod_withoutStrategiesContext } from "./GremlinParser.js";
import { TraversalSourceSelfMethod_withContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethodContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_addEContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_addVContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_EContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_VContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_injectContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_ioContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_mergeV_MapContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_mergeV_TraversalContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_mergeE_MapContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_mergeE_TraversalContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_call_emptyContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_call_stringContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_call_string_mapContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_call_string_traversalContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_call_string_map_traversalContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_unionContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_match_stringContext } from "./GremlinParser.js";
import { TraversalSourceSpawnMethod_match_string_mapContext } from "./GremlinParser.js";
import { ChainedTraversalContext } from "./GremlinParser.js";
import { NestedTraversalContext } from "./GremlinParser.js";
import { TerminatedTraversalContext } from "./GremlinParser.js";
import { TraversalMethodContext } from "./GremlinParser.js";
import { TraversalMethod_VContext } from "./GremlinParser.js";
import { TraversalMethod_EContext } from "./GremlinParser.js";
import { TraversalMethod_addE_StringContext } from "./GremlinParser.js";
import { TraversalMethod_addE_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_addV_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_addV_StringContext } from "./GremlinParser.js";
import { TraversalMethod_addV_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_aggregate_StringContext } from "./GremlinParser.js";
import { TraversalMethod_all_PContext } from "./GremlinParser.js";
import { TraversalMethod_andContext } from "./GremlinParser.js";
import { TraversalMethod_any_PContext } from "./GremlinParser.js";
import { TraversalMethod_asContext } from "./GremlinParser.js";
import { TraversalMethod_asBoolContext } from "./GremlinParser.js";
import { TraversalMethod_asDateContext } from "./GremlinParser.js";
import { TraversalMethod_asNumber_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_asNumber_traversalGTypeContext } from "./GremlinParser.js";
import { TraversalMethod_asString_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_asString_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_barrier_ConsumerContext } from "./GremlinParser.js";
import { TraversalMethod_barrier_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_barrier_intContext } from "./GremlinParser.js";
import { TraversalMethod_bothContext } from "./GremlinParser.js";
import { TraversalMethod_bothEContext } from "./GremlinParser.js";
import { TraversalMethod_bothVContext } from "./GremlinParser.js";
import { TraversalMethod_branchContext } from "./GremlinParser.js";
import { TraversalMethod_by_ComparatorContext } from "./GremlinParser.js";
import { TraversalMethod_by_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_by_FunctionContext } from "./GremlinParser.js";
import { TraversalMethod_by_Function_ComparatorContext } from "./GremlinParser.js";
import { TraversalMethod_by_OrderContext } from "./GremlinParser.js";
import { TraversalMethod_by_StringContext } from "./GremlinParser.js";
import { TraversalMethod_by_String_ComparatorContext } from "./GremlinParser.js";
import { TraversalMethod_by_TContext } from "./GremlinParser.js";
import { TraversalMethod_by_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_by_Traversal_ComparatorContext } from "./GremlinParser.js";
import { TraversalMethod_call_stringContext } from "./GremlinParser.js";
import { TraversalMethod_call_string_mapContext } from "./GremlinParser.js";
import { TraversalMethod_call_string_traversalContext } from "./GremlinParser.js";
import { TraversalMethod_call_string_map_traversalContext } from "./GremlinParser.js";
import { TraversalMethod_capContext } from "./GremlinParser.js";
import { TraversalMethod_choose_FunctionContext } from "./GremlinParser.js";
import { TraversalMethod_choose_Predicate_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_choose_Predicate_Traversal_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_choose_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_choose_Traversal_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_choose_Traversal_Traversal_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_coalesceContext } from "./GremlinParser.js";
import { TraversalMethod_coinContext } from "./GremlinParser.js";
import { TraversalMethod_combine_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_concat_Traversal_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_concat_StringContext } from "./GremlinParser.js";
import { TraversalMethod_conjoin_StringContext } from "./GremlinParser.js";
import { TraversalMethod_connectedComponentContext } from "./GremlinParser.js";
import { TraversalMethod_constantContext } from "./GremlinParser.js";
import { TraversalMethod_count_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_count_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_cyclicPathContext } from "./GremlinParser.js";
import { TraversalMethod_dateAddContext } from "./GremlinParser.js";
import { TraversalMethod_dateDiff_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_dateDiff_DateContext } from "./GremlinParser.js";
import { TraversalMethod_dedup_Scope_StringContext } from "./GremlinParser.js";
import { TraversalMethod_dedup_StringContext } from "./GremlinParser.js";
import { TraversalMethod_difference_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_discardContext } from "./GremlinParser.js";
import { TraversalMethod_disjunct_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_dropContext } from "./GremlinParser.js";
import { TraversalMethod_elementContext } from "./GremlinParser.js";
import { TraversalMethod_elementMapContext } from "./GremlinParser.js";
import { TraversalMethod_emit_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_emit_PredicateContext } from "./GremlinParser.js";
import { TraversalMethod_emit_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_fail_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_fail_StringContext } from "./GremlinParser.js";
import { TraversalMethod_filter_PredicateContext } from "./GremlinParser.js";
import { TraversalMethod_filter_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_flatMapContext } from "./GremlinParser.js";
import { TraversalMethod_fold_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_fold_Object_BiFunctionContext } from "./GremlinParser.js";
import { TraversalMethod_format_StringContext } from "./GremlinParser.js";
import { TraversalMethod_from_StringContext } from "./GremlinParser.js";
import { TraversalMethod_from_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_group_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_group_StringContext } from "./GremlinParser.js";
import { TraversalMethod_groupCount_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_groupCount_StringContext } from "./GremlinParser.js";
import { TraversalMethod_has_StringContext } from "./GremlinParser.js";
import { TraversalMethod_has_String_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_has_String_PContext } from "./GremlinParser.js";
import { TraversalMethod_has_String_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_has_String_String_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_has_String_String_PContext } from "./GremlinParser.js";
import { TraversalMethod_has_String_String_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_has_T_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_has_T_PContext } from "./GremlinParser.js";
import { TraversalMethod_has_T_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_hasId_Object_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_hasId_PContext } from "./GremlinParser.js";
import { TraversalMethod_hasKey_PContext } from "./GremlinParser.js";
import { TraversalMethod_hasKey_String_StringContext } from "./GremlinParser.js";
import { TraversalMethod_hasKey_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_hasLabel_PContext } from "./GremlinParser.js";
import { TraversalMethod_hasLabel_String_StringContext } from "./GremlinParser.js";
import { TraversalMethod_hasLabel_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_hasNotContext } from "./GremlinParser.js";
import { TraversalMethod_hasValue_Object_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_hasValue_PContext } from "./GremlinParser.js";
import { TraversalMethod_hasValue_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_idContext } from "./GremlinParser.js";
import { TraversalMethod_identityContext } from "./GremlinParser.js";
import { TraversalMethod_inContext } from "./GremlinParser.js";
import { TraversalMethod_inEContext } from "./GremlinParser.js";
import { TraversalMethod_intersect_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_inVContext } from "./GremlinParser.js";
import { TraversalMethod_indexContext } from "./GremlinParser.js";
import { TraversalMethod_injectContext } from "./GremlinParser.js";
import { TraversalMethod_is_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_is_PContext } from "./GremlinParser.js";
import { TraversalMethod_keyContext } from "./GremlinParser.js";
import { TraversalMethod_labelContext } from "./GremlinParser.js";
import { TraversalMethod_length_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_length_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_limit_Scope_longContext } from "./GremlinParser.js";
import { TraversalMethod_limit_longContext } from "./GremlinParser.js";
import { TraversalMethod_localContext } from "./GremlinParser.js";
import { TraversalMethod_loops_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_loops_StringContext } from "./GremlinParser.js";
import { TraversalMethod_lTrim_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_lTrim_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_mapContext } from "./GremlinParser.js";
import { TraversalMethod_match_traversalContext } from "./GremlinParser.js";
import { TraversalMethod_match_stringContext } from "./GremlinParser.js";
import { TraversalMethod_match_string_mapContext } from "./GremlinParser.js";
import { TraversalMethod_mathContext } from "./GremlinParser.js";
import { TraversalMethod_max_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_max_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_mean_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_mean_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_merge_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_mergeV_emptyContext } from "./GremlinParser.js";
import { TraversalMethod_mergeV_MapContext } from "./GremlinParser.js";
import { TraversalMethod_mergeV_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_mergeE_emptyContext } from "./GremlinParser.js";
import { TraversalMethod_mergeE_MapContext } from "./GremlinParser.js";
import { TraversalMethod_mergeE_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_min_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_min_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_none_PContext } from "./GremlinParser.js";
import { TraversalMethod_notContext } from "./GremlinParser.js";
import { TraversalMethod_option_Predicate_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_option_Merge_MapContext } from "./GremlinParser.js";
import { TraversalMethod_option_Merge_Map_CardinalityContext } from "./GremlinParser.js";
import { TraversalMethod_option_Merge_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_option_Object_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_option_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_optionalContext } from "./GremlinParser.js";
import { TraversalMethod_orContext } from "./GremlinParser.js";
import { TraversalMethod_order_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_order_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_otherVContext } from "./GremlinParser.js";
import { TraversalMethod_outContext } from "./GremlinParser.js";
import { TraversalMethod_outEContext } from "./GremlinParser.js";
import { TraversalMethod_outVContext } from "./GremlinParser.js";
import { TraversalMethod_pageRank_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_pageRank_doubleContext } from "./GremlinParser.js";
import { TraversalMethod_pathContext } from "./GremlinParser.js";
import { TraversalMethod_peerPressureContext } from "./GremlinParser.js";
import { TraversalMethod_product_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_profile_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_profile_StringContext } from "./GremlinParser.js";
import { TraversalMethod_projectContext } from "./GremlinParser.js";
import { TraversalMethod_propertiesContext } from "./GremlinParser.js";
import { TraversalMethod_property_Cardinality_Object_Object_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_property_Cardinality_Object_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_property_Cardinality_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_property_Object_Object_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_property_Object_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_property_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_property_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_propertyMapContext } from "./GremlinParser.js";
import { TraversalMethod_range_Scope_long_longContext } from "./GremlinParser.js";
import { TraversalMethod_range_long_longContext } from "./GremlinParser.js";
import { TraversalMethod_readContext } from "./GremlinParser.js";
import { TraversalMethod_repeat_String_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_repeat_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_replace_String_StringContext } from "./GremlinParser.js";
import { TraversalMethod_replace_Scope_String_StringContext } from "./GremlinParser.js";
import { TraversalMethod_reverse_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_rTrim_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_rTrim_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_sack_BiFunctionContext } from "./GremlinParser.js";
import { TraversalMethod_sack_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_sample_Scope_intContext } from "./GremlinParser.js";
import { TraversalMethod_sample_intContext } from "./GremlinParser.js";
import { TraversalMethod_select_ColumnContext } from "./GremlinParser.js";
import { TraversalMethod_select_Pop_StringContext } from "./GremlinParser.js";
import { TraversalMethod_select_Pop_String_String_StringContext } from "./GremlinParser.js";
import { TraversalMethod_select_Pop_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_select_StringContext } from "./GremlinParser.js";
import { TraversalMethod_select_String_String_StringContext } from "./GremlinParser.js";
import { TraversalMethod_select_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_shortestPathContext } from "./GremlinParser.js";
import { TraversalMethod_sideEffectContext } from "./GremlinParser.js";
import { TraversalMethod_simplePathContext } from "./GremlinParser.js";
import { TraversalMethod_skip_Scope_longContext } from "./GremlinParser.js";
import { TraversalMethod_skip_longContext } from "./GremlinParser.js";
import { TraversalMethod_split_StringContext } from "./GremlinParser.js";
import { TraversalMethod_split_Scope_StringContext } from "./GremlinParser.js";
import { TraversalMethod_subgraphContext } from "./GremlinParser.js";
import { TraversalMethod_substring_intContext } from "./GremlinParser.js";
import { TraversalMethod_substring_Scope_intContext } from "./GremlinParser.js";
import { TraversalMethod_substring_int_intContext } from "./GremlinParser.js";
import { TraversalMethod_substring_Scope_int_intContext } from "./GremlinParser.js";
import { TraversalMethod_sum_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_sum_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_tail_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_tail_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_tail_Scope_longContext } from "./GremlinParser.js";
import { TraversalMethod_tail_longContext } from "./GremlinParser.js";
import { TraversalMethod_timeLimitContext } from "./GremlinParser.js";
import { TraversalMethod_timesContext } from "./GremlinParser.js";
import { TraversalMethod_to_Direction_StringContext } from "./GremlinParser.js";
import { TraversalMethod_to_StringContext } from "./GremlinParser.js";
import { TraversalMethod_to_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_toEContext } from "./GremlinParser.js";
import { TraversalMethod_toLower_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_toLower_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_toUpper_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_toUpper_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_toVContext } from "./GremlinParser.js";
import { TraversalMethod_tree_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_tree_StringContext } from "./GremlinParser.js";
import { TraversalMethod_trim_EmptyContext } from "./GremlinParser.js";
import { TraversalMethod_trim_ScopeContext } from "./GremlinParser.js";
import { TraversalMethod_unfoldContext } from "./GremlinParser.js";
import { TraversalMethod_unionContext } from "./GremlinParser.js";
import { TraversalMethod_until_PredicateContext } from "./GremlinParser.js";
import { TraversalMethod_until_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_valueContext } from "./GremlinParser.js";
import { TraversalMethod_valueMap_StringContext } from "./GremlinParser.js";
import { TraversalMethod_valueMap_boolean_StringContext } from "./GremlinParser.js";
import { TraversalMethod_valuesContext } from "./GremlinParser.js";
import { TraversalMethod_where_PContext } from "./GremlinParser.js";
import { TraversalMethod_where_String_PContext } from "./GremlinParser.js";
import { TraversalMethod_where_TraversalContext } from "./GremlinParser.js";
import { TraversalMethod_with_StringContext } from "./GremlinParser.js";
import { TraversalMethod_with_String_ObjectContext } from "./GremlinParser.js";
import { TraversalMethod_writeContext } from "./GremlinParser.js";
import { TraversalStrategyContext } from "./GremlinParser.js";
import { ConfigurationContext } from "./GremlinParser.js";
import { TraversalScopeContext } from "./GremlinParser.js";
import { TraversalBarrierContext } from "./GremlinParser.js";
import { TraversalTContext } from "./GremlinParser.js";
import { TraversalTShortContext } from "./GremlinParser.js";
import { TraversalTLongContext } from "./GremlinParser.js";
import { TraversalMergeContext } from "./GremlinParser.js";
import { TraversalOrderContext } from "./GremlinParser.js";
import { TraversalDirectionContext } from "./GremlinParser.js";
import { TraversalDirectionShortContext } from "./GremlinParser.js";
import { TraversalDirectionLongContext } from "./GremlinParser.js";
import { TraversalCardinalityContext } from "./GremlinParser.js";
import { TraversalColumnContext } from "./GremlinParser.js";
import { TraversalPopContext } from "./GremlinParser.js";
import { TraversalOperatorContext } from "./GremlinParser.js";
import { TraversalPickContext } from "./GremlinParser.js";
import { TraversalDTContext } from "./GremlinParser.js";
import { TraversalGTypeContext } from "./GremlinParser.js";
import { TraversalPredicateContext } from "./GremlinParser.js";
import { TraversalTerminalMethodContext } from "./GremlinParser.js";
import { TraversalSackMethodContext } from "./GremlinParser.js";
import { TraversalComparatorContext } from "./GremlinParser.js";
import { TraversalFunctionContext } from "./GremlinParser.js";
import { TraversalBiFunctionContext } from "./GremlinParser.js";
import { TraversalPredicate_eqContext } from "./GremlinParser.js";
import { TraversalPredicate_neqContext } from "./GremlinParser.js";
import { TraversalPredicate_typeOfContext } from "./GremlinParser.js";
import { TraversalPredicate_ltContext } from "./GremlinParser.js";
import { TraversalPredicate_lteContext } from "./GremlinParser.js";
import { TraversalPredicate_gtContext } from "./GremlinParser.js";
import { TraversalPredicate_gteContext } from "./GremlinParser.js";
import { TraversalPredicate_insideContext } from "./GremlinParser.js";
import { TraversalPredicate_outsideContext } from "./GremlinParser.js";
import { TraversalPredicate_betweenContext } from "./GremlinParser.js";
import { TraversalPredicate_withinContext } from "./GremlinParser.js";
import { TraversalPredicate_withoutContext } from "./GremlinParser.js";
import { TraversalPredicate_notContext } from "./GremlinParser.js";
import { TraversalPredicate_containingContext } from "./GremlinParser.js";
import { TraversalPredicate_notContainingContext } from "./GremlinParser.js";
import { TraversalPredicate_startingWithContext } from "./GremlinParser.js";
import { TraversalPredicate_notStartingWithContext } from "./GremlinParser.js";
import { TraversalPredicate_endingWithContext } from "./GremlinParser.js";
import { TraversalPredicate_notEndingWithContext } from "./GremlinParser.js";
import { TraversalPredicate_regexContext } from "./GremlinParser.js";
import { TraversalPredicate_notRegexContext } from "./GremlinParser.js";
import { TraversalTerminalMethod_explainContext } from "./GremlinParser.js";
import { TraversalTerminalMethod_hasNextContext } from "./GremlinParser.js";
import { TraversalTerminalMethod_iterateContext } from "./GremlinParser.js";
import { TraversalTerminalMethod_tryNextContext } from "./GremlinParser.js";
import { TraversalTerminalMethod_nextContext } from "./GremlinParser.js";
import { TraversalTerminalMethod_toListContext } from "./GremlinParser.js";
import { TraversalTerminalMethod_toSetContext } from "./GremlinParser.js";
import { TraversalTerminalMethod_toBulkSetContext } from "./GremlinParser.js";
import { WithOptionKeysContext } from "./GremlinParser.js";
import { ConnectedComponentConstantsContext } from "./GremlinParser.js";
import { PageRankConstantsContext } from "./GremlinParser.js";
import { PeerPressureConstantsContext } from "./GremlinParser.js";
import { ShortestPathConstantsContext } from "./GremlinParser.js";
import { WithOptionsValuesContext } from "./GremlinParser.js";
import { IoOptionsKeysContext } from "./GremlinParser.js";
import { IoOptionsValuesContext } from "./GremlinParser.js";
import { ConnectedComponentConstants_componentContext } from "./GremlinParser.js";
import { ConnectedComponentConstants_edgesContext } from "./GremlinParser.js";
import { ConnectedComponentConstants_propertyNameContext } from "./GremlinParser.js";
import { PageRankConstants_edgesContext } from "./GremlinParser.js";
import { PageRankConstants_timesContext } from "./GremlinParser.js";
import { PageRankConstants_propertyNameContext } from "./GremlinParser.js";
import { PeerPressureConstants_edgesContext } from "./GremlinParser.js";
import { PeerPressureConstants_timesContext } from "./GremlinParser.js";
import { PeerPressureConstants_propertyNameContext } from "./GremlinParser.js";
import { ShortestPathConstants_targetContext } from "./GremlinParser.js";
import { ShortestPathConstants_edgesContext } from "./GremlinParser.js";
import { ShortestPathConstants_distanceContext } from "./GremlinParser.js";
import { ShortestPathConstants_maxDistanceContext } from "./GremlinParser.js";
import { ShortestPathConstants_includeEdgesContext } from "./GremlinParser.js";
import { WithOptionsConstants_tokensContext } from "./GremlinParser.js";
import { WithOptionsConstants_noneContext } from "./GremlinParser.js";
import { WithOptionsConstants_idsContext } from "./GremlinParser.js";
import { WithOptionsConstants_labelsContext } from "./GremlinParser.js";
import { WithOptionsConstants_keysContext } from "./GremlinParser.js";
import { WithOptionsConstants_valuesContext } from "./GremlinParser.js";
import { WithOptionsConstants_allContext } from "./GremlinParser.js";
import { WithOptionsConstants_indexerContext } from "./GremlinParser.js";
import { WithOptionsConstants_listContext } from "./GremlinParser.js";
import { WithOptionsConstants_mapContext } from "./GremlinParser.js";
import { IoOptionsConstants_readerContext } from "./GremlinParser.js";
import { IoOptionsConstants_writerContext } from "./GremlinParser.js";
import { IoOptionsConstants_gryoContext } from "./GremlinParser.js";
import { IoOptionsConstants_graphsonContext } from "./GremlinParser.js";
import { IoOptionsConstants_graphmlContext } from "./GremlinParser.js";
import { ConnectedComponentStringConstantContext } from "./GremlinParser.js";
import { PageRankStringConstantContext } from "./GremlinParser.js";
import { PeerPressureStringConstantContext } from "./GremlinParser.js";
import { ShortestPathStringConstantContext } from "./GremlinParser.js";
import { WithOptionsStringConstantContext } from "./GremlinParser.js";
import { IoOptionsStringConstantContext } from "./GremlinParser.js";
import { BooleanArgumentContext } from "./GremlinParser.js";
import { IntegerArgumentContext } from "./GremlinParser.js";
import { StringArgumentContext } from "./GremlinParser.js";
import { StringNullableArgumentContext } from "./GremlinParser.js";
import { StringNullableArgumentVarargsContext } from "./GremlinParser.js";
import { DateArgumentContext } from "./GremlinParser.js";
import { GenericArgumentContext } from "./GremlinParser.js";
import { GenericArgumentVarargsContext } from "./GremlinParser.js";
import { GenericMapArgumentContext } from "./GremlinParser.js";
import { GenericMapNullableArgumentContext } from "./GremlinParser.js";
import { NullableGenericLiteralMapContext } from "./GremlinParser.js";
import { TraversalStrategyVarargsContext } from "./GremlinParser.js";
import { TraversalStrategyExprContext } from "./GremlinParser.js";
import { ClassTypeListContext } from "./GremlinParser.js";
import { ClassTypeExprContext } from "./GremlinParser.js";
import { NestedTraversalListContext } from "./GremlinParser.js";
import { NestedTraversalExprContext } from "./GremlinParser.js";
import { GenericCollectionLiteralContext } from "./GremlinParser.js";
import { GenericLiteralVarargsContext } from "./GremlinParser.js";
import { GenericLiteralExprContext } from "./GremlinParser.js";
import { GenericMapNullableLiteralContext } from "./GremlinParser.js";
import { GenericRangeLiteralContext } from "./GremlinParser.js";
import { GenericSetLiteralContext } from "./GremlinParser.js";
import { StringNullableLiteralVarargsContext } from "./GremlinParser.js";
import { GenericLiteralContext } from "./GremlinParser.js";
import { GenericMapLiteralContext } from "./GremlinParser.js";
import { MapKeyContext } from "./GremlinParser.js";
import { MapEntryContext } from "./GremlinParser.js";
import { StringLiteralContext } from "./GremlinParser.js";
import { StringNullableLiteralContext } from "./GremlinParser.js";
import { IntegerLiteralContext } from "./GremlinParser.js";
import { FloatLiteralContext } from "./GremlinParser.js";
import { NumericLiteralContext } from "./GremlinParser.js";
import { BooleanLiteralContext } from "./GremlinParser.js";
import { DateLiteralContext } from "./GremlinParser.js";
import { NullLiteralContext } from "./GremlinParser.js";
import { NanLiteralContext } from "./GremlinParser.js";
import { InfLiteralContext } from "./GremlinParser.js";
import { UuidLiteralContext } from "./GremlinParser.js";
import { CharacterLiteralContext } from "./GremlinParser.js";
import { DurationLiteralContext } from "./GremlinParser.js";
import { BinaryLiteralContext } from "./GremlinParser.js";
import { PdtLiteralContext } from "./GremlinParser.js";
import { NakedKeyContext } from "./GremlinParser.js";
import { ClassTypeContext } from "./GremlinParser.js";
import { VariableContext } from "./GremlinParser.js";
import { KeywordContext } from "./GremlinParser.js";


/**
 * This interface defines a complete generic visitor for a parse tree produced
 * by `GremlinParser`.
 *
 * @param <Result> The return type of the visit operation. Use `void` for
 * operations with no return type.
 */
export class GremlinVisitor<Result> extends AbstractParseTreeVisitor<Result> {
    /**
     * Visit a parse tree produced by `GremlinParser.queryList`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitQueryList?: (ctx: QueryListContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.query`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitQuery?: (ctx: QueryContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.emptyQuery`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitEmptyQuery?: (ctx: EmptyQueryContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSource`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSource?: (ctx: TraversalSourceContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.transactionPart`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTransactionPart?: (ctx: TransactionPartContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.rootTraversal`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitRootTraversal?: (ctx: RootTraversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSelfMethod`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSelfMethod?: (ctx: TraversalSourceSelfMethodContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withBulk`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSelfMethod_withBulk?: (ctx: TraversalSourceSelfMethod_withBulkContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withPath`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSelfMethod_withPath?: (ctx: TraversalSourceSelfMethod_withPathContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withSack`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSelfMethod_withSack?: (ctx: TraversalSourceSelfMethod_withSackContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withSideEffect`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSelfMethod_withSideEffect?: (ctx: TraversalSourceSelfMethod_withSideEffectContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withStrategies`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSelfMethod_withStrategies?: (ctx: TraversalSourceSelfMethod_withStrategiesContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withoutStrategies`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSelfMethod_withoutStrategies?: (ctx: TraversalSourceSelfMethod_withoutStrategiesContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_with`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSelfMethod_with?: (ctx: TraversalSourceSelfMethod_withContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod?: (ctx: TraversalSourceSpawnMethodContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_addE`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_addE?: (ctx: TraversalSourceSpawnMethod_addEContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_addV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_addV?: (ctx: TraversalSourceSpawnMethod_addVContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_E`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_E?: (ctx: TraversalSourceSpawnMethod_EContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_V`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_V?: (ctx: TraversalSourceSpawnMethod_VContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_inject`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_inject?: (ctx: TraversalSourceSpawnMethod_injectContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_io`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_io?: (ctx: TraversalSourceSpawnMethod_ioContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalSourceSpawnMethod_mergeV_Map`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_mergeV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_mergeV_Map?: (ctx: TraversalSourceSpawnMethod_mergeV_MapContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalSourceSpawnMethod_mergeV_Traversal`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_mergeV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_mergeV_Traversal?: (ctx: TraversalSourceSpawnMethod_mergeV_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalSourceSpawnMethod_mergeE_Map`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_mergeE`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_mergeE_Map?: (ctx: TraversalSourceSpawnMethod_mergeE_MapContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalSourceSpawnMethod_mergeE_Traversal`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_mergeE`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_mergeE_Traversal?: (ctx: TraversalSourceSpawnMethod_mergeE_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalSourceSpawnMethod_call_empty`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_call_empty?: (ctx: TraversalSourceSpawnMethod_call_emptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalSourceSpawnMethod_call_string`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_call_string?: (ctx: TraversalSourceSpawnMethod_call_stringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalSourceSpawnMethod_call_string_map`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_call_string_map?: (ctx: TraversalSourceSpawnMethod_call_string_mapContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalSourceSpawnMethod_call_string_traversal`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_call_string_traversal?: (ctx: TraversalSourceSpawnMethod_call_string_traversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalSourceSpawnMethod_call_string_map_traversal`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_call_string_map_traversal?: (ctx: TraversalSourceSpawnMethod_call_string_map_traversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_union`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_union?: (ctx: TraversalSourceSpawnMethod_unionContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalSourceSpawnMethod_match_string`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_match`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_match_string?: (ctx: TraversalSourceSpawnMethod_match_stringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalSourceSpawnMethod_match_string_map`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_match`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSourceSpawnMethod_match_string_map?: (ctx: TraversalSourceSpawnMethod_match_string_mapContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.chainedTraversal`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitChainedTraversal?: (ctx: ChainedTraversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.nestedTraversal`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitNestedTraversal?: (ctx: NestedTraversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.terminatedTraversal`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTerminatedTraversal?: (ctx: TerminatedTraversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod?: (ctx: TraversalMethodContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_V`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_V?: (ctx: TraversalMethod_VContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_E`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_E?: (ctx: TraversalMethod_EContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_addE_String`
     * labeled alternative in `GremlinParser.traversalMethod_addE`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_addE_String?: (ctx: TraversalMethod_addE_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_addE_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_addE`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_addE_Traversal?: (ctx: TraversalMethod_addE_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_addV_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_addV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_addV_Empty?: (ctx: TraversalMethod_addV_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_addV_String`
     * labeled alternative in `GremlinParser.traversalMethod_addV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_addV_String?: (ctx: TraversalMethod_addV_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_addV_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_addV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_addV_Traversal?: (ctx: TraversalMethod_addV_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_aggregate_String`
     * labeled alternative in `GremlinParser.traversalMethod_aggregate`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_aggregate_String?: (ctx: TraversalMethod_aggregate_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_all_P`
     * labeled alternative in `GremlinParser.traversalMethod_all`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_all_P?: (ctx: TraversalMethod_all_PContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_and`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_and?: (ctx: TraversalMethod_andContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_any_P`
     * labeled alternative in `GremlinParser.traversalMethod_any`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_any_P?: (ctx: TraversalMethod_any_PContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_as`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_as?: (ctx: TraversalMethod_asContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_asBool`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_asBool?: (ctx: TraversalMethod_asBoolContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_asDate`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_asDate?: (ctx: TraversalMethod_asDateContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_asNumber_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_asNumber`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_asNumber_Empty?: (ctx: TraversalMethod_asNumber_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_asNumber_traversalGType`
     * labeled alternative in `GremlinParser.traversalMethod_asNumber`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_asNumber_traversalGType?: (ctx: TraversalMethod_asNumber_traversalGTypeContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_asString_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_asString`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_asString_Empty?: (ctx: TraversalMethod_asString_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_asString_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_asString`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_asString_Scope?: (ctx: TraversalMethod_asString_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_barrier_Consumer`
     * labeled alternative in `GremlinParser.traversalMethod_barrier`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_barrier_Consumer?: (ctx: TraversalMethod_barrier_ConsumerContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_barrier_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_barrier`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_barrier_Empty?: (ctx: TraversalMethod_barrier_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_barrier_int`
     * labeled alternative in `GremlinParser.traversalMethod_barrier`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_barrier_int?: (ctx: TraversalMethod_barrier_intContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_both`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_both?: (ctx: TraversalMethod_bothContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_bothE`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_bothE?: (ctx: TraversalMethod_bothEContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_bothV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_bothV?: (ctx: TraversalMethod_bothVContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_branch`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_branch?: (ctx: TraversalMethod_branchContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_by_Comparator`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_by_Comparator?: (ctx: TraversalMethod_by_ComparatorContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_by_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_by_Empty?: (ctx: TraversalMethod_by_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_by_Function`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_by_Function?: (ctx: TraversalMethod_by_FunctionContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_by_Function_Comparator`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_by_Function_Comparator?: (ctx: TraversalMethod_by_Function_ComparatorContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_by_Order`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_by_Order?: (ctx: TraversalMethod_by_OrderContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_by_String`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_by_String?: (ctx: TraversalMethod_by_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_by_String_Comparator`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_by_String_Comparator?: (ctx: TraversalMethod_by_String_ComparatorContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_by_T`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_by_T?: (ctx: TraversalMethod_by_TContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_by_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_by_Traversal?: (ctx: TraversalMethod_by_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_by_Traversal_Comparator`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_by_Traversal_Comparator?: (ctx: TraversalMethod_by_Traversal_ComparatorContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_call_string`
     * labeled alternative in `GremlinParser.traversalMethod_call`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_call_string?: (ctx: TraversalMethod_call_stringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_call_string_map`
     * labeled alternative in `GremlinParser.traversalMethod_call`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_call_string_map?: (ctx: TraversalMethod_call_string_mapContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_call_string_traversal`
     * labeled alternative in `GremlinParser.traversalMethod_call`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_call_string_traversal?: (ctx: TraversalMethod_call_string_traversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_call_string_map_traversal`
     * labeled alternative in `GremlinParser.traversalMethod_call`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_call_string_map_traversal?: (ctx: TraversalMethod_call_string_map_traversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_cap`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_cap?: (ctx: TraversalMethod_capContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_choose_Function`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_choose_Function?: (ctx: TraversalMethod_choose_FunctionContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_choose_Predicate_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_choose_Predicate_Traversal?: (ctx: TraversalMethod_choose_Predicate_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_choose_Predicate_Traversal_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_choose_Predicate_Traversal_Traversal?: (ctx: TraversalMethod_choose_Predicate_Traversal_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_choose_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_choose_Traversal?: (ctx: TraversalMethod_choose_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_choose_Traversal_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_choose_Traversal_Traversal?: (ctx: TraversalMethod_choose_Traversal_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_choose_Traversal_Traversal_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_choose_Traversal_Traversal_Traversal?: (ctx: TraversalMethod_choose_Traversal_Traversal_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_coalesce`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_coalesce?: (ctx: TraversalMethod_coalesceContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_coin`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_coin?: (ctx: TraversalMethod_coinContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_combine_Object`
     * labeled alternative in `GremlinParser.traversalMethod_combine`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_combine_Object?: (ctx: TraversalMethod_combine_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_concat_Traversal_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_concat`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_concat_Traversal_Traversal?: (ctx: TraversalMethod_concat_Traversal_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_concat_String`
     * labeled alternative in `GremlinParser.traversalMethod_concat`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_concat_String?: (ctx: TraversalMethod_concat_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_conjoin_String`
     * labeled alternative in `GremlinParser.traversalMethod_conjoin`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_conjoin_String?: (ctx: TraversalMethod_conjoin_StringContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_connectedComponent`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_connectedComponent?: (ctx: TraversalMethod_connectedComponentContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_constant`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_constant?: (ctx: TraversalMethod_constantContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_count_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_count`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_count_Empty?: (ctx: TraversalMethod_count_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_count_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_count`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_count_Scope?: (ctx: TraversalMethod_count_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_cyclicPath`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_cyclicPath?: (ctx: TraversalMethod_cyclicPathContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_dateAdd`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_dateAdd?: (ctx: TraversalMethod_dateAddContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_dateDiff_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_dateDiff`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_dateDiff_Traversal?: (ctx: TraversalMethod_dateDiff_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_dateDiff_Date`
     * labeled alternative in `GremlinParser.traversalMethod_dateDiff`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_dateDiff_Date?: (ctx: TraversalMethod_dateDiff_DateContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_dedup_Scope_String`
     * labeled alternative in `GremlinParser.traversalMethod_dedup`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_dedup_Scope_String?: (ctx: TraversalMethod_dedup_Scope_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_dedup_String`
     * labeled alternative in `GremlinParser.traversalMethod_dedup`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_dedup_String?: (ctx: TraversalMethod_dedup_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_difference_Object`
     * labeled alternative in `GremlinParser.traversalMethod_difference`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_difference_Object?: (ctx: TraversalMethod_difference_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_discard`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_discard?: (ctx: TraversalMethod_discardContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_disjunct_Object`
     * labeled alternative in `GremlinParser.traversalMethod_disjunct`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_disjunct_Object?: (ctx: TraversalMethod_disjunct_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_drop`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_drop?: (ctx: TraversalMethod_dropContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_element`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_element?: (ctx: TraversalMethod_elementContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_elementMap`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_elementMap?: (ctx: TraversalMethod_elementMapContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_emit_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_emit`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_emit_Empty?: (ctx: TraversalMethod_emit_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_emit_Predicate`
     * labeled alternative in `GremlinParser.traversalMethod_emit`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_emit_Predicate?: (ctx: TraversalMethod_emit_PredicateContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_emit_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_emit`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_emit_Traversal?: (ctx: TraversalMethod_emit_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_fail_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_fail`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_fail_Empty?: (ctx: TraversalMethod_fail_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_fail_String`
     * labeled alternative in `GremlinParser.traversalMethod_fail`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_fail_String?: (ctx: TraversalMethod_fail_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_filter_Predicate`
     * labeled alternative in `GremlinParser.traversalMethod_filter`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_filter_Predicate?: (ctx: TraversalMethod_filter_PredicateContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_filter_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_filter`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_filter_Traversal?: (ctx: TraversalMethod_filter_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_flatMap`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_flatMap?: (ctx: TraversalMethod_flatMapContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_fold_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_fold`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_fold_Empty?: (ctx: TraversalMethod_fold_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_fold_Object_BiFunction`
     * labeled alternative in `GremlinParser.traversalMethod_fold`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_fold_Object_BiFunction?: (ctx: TraversalMethod_fold_Object_BiFunctionContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_format_String`
     * labeled alternative in `GremlinParser.traversalMethod_format`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_format_String?: (ctx: TraversalMethod_format_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_from_String`
     * labeled alternative in `GremlinParser.traversalMethod_from`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_from_String?: (ctx: TraversalMethod_from_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_from_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_from`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_from_Traversal?: (ctx: TraversalMethod_from_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_group_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_group`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_group_Empty?: (ctx: TraversalMethod_group_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_group_String`
     * labeled alternative in `GremlinParser.traversalMethod_group`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_group_String?: (ctx: TraversalMethod_group_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_groupCount_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_groupCount`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_groupCount_Empty?: (ctx: TraversalMethod_groupCount_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_groupCount_String`
     * labeled alternative in `GremlinParser.traversalMethod_groupCount`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_groupCount_String?: (ctx: TraversalMethod_groupCount_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_has_String`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_has_String?: (ctx: TraversalMethod_has_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_has_String_Object`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_has_String_Object?: (ctx: TraversalMethod_has_String_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_has_String_P`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_has_String_P?: (ctx: TraversalMethod_has_String_PContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_has_String_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_has_String_Traversal?: (ctx: TraversalMethod_has_String_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_has_String_String_Object`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_has_String_String_Object?: (ctx: TraversalMethod_has_String_String_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_has_String_String_P`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_has_String_String_P?: (ctx: TraversalMethod_has_String_String_PContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_has_String_String_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_has_String_String_Traversal?: (ctx: TraversalMethod_has_String_String_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_has_T_Object`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_has_T_Object?: (ctx: TraversalMethod_has_T_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_has_T_P`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_has_T_P?: (ctx: TraversalMethod_has_T_PContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_has_T_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_has_T_Traversal?: (ctx: TraversalMethod_has_T_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_hasId_Object_Object`
     * labeled alternative in `GremlinParser.traversalMethod_hasId`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_hasId_Object_Object?: (ctx: TraversalMethod_hasId_Object_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_hasId_P`
     * labeled alternative in `GremlinParser.traversalMethod_hasId`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_hasId_P?: (ctx: TraversalMethod_hasId_PContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_hasKey_P`
     * labeled alternative in `GremlinParser.traversalMethod_hasKey`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_hasKey_P?: (ctx: TraversalMethod_hasKey_PContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_hasKey_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_hasKey`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_hasKey_String_String?: (ctx: TraversalMethod_hasKey_String_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_hasKey_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_hasKey`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_hasKey_Traversal?: (ctx: TraversalMethod_hasKey_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_hasLabel_P`
     * labeled alternative in `GremlinParser.traversalMethod_hasLabel`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_hasLabel_P?: (ctx: TraversalMethod_hasLabel_PContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_hasLabel_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_hasLabel`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_hasLabel_String_String?: (ctx: TraversalMethod_hasLabel_String_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_hasLabel_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_hasLabel`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_hasLabel_Traversal?: (ctx: TraversalMethod_hasLabel_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_hasNot`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_hasNot?: (ctx: TraversalMethod_hasNotContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_hasValue_Object_Object`
     * labeled alternative in `GremlinParser.traversalMethod_hasValue`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_hasValue_Object_Object?: (ctx: TraversalMethod_hasValue_Object_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_hasValue_P`
     * labeled alternative in `GremlinParser.traversalMethod_hasValue`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_hasValue_P?: (ctx: TraversalMethod_hasValue_PContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_hasValue_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_hasValue`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_hasValue_Traversal?: (ctx: TraversalMethod_hasValue_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_id`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_id?: (ctx: TraversalMethod_idContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_identity`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_identity?: (ctx: TraversalMethod_identityContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_in`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_in?: (ctx: TraversalMethod_inContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_inE`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_inE?: (ctx: TraversalMethod_inEContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_intersect_Object`
     * labeled alternative in `GremlinParser.traversalMethod_intersect`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_intersect_Object?: (ctx: TraversalMethod_intersect_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_inV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_inV?: (ctx: TraversalMethod_inVContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_index`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_index?: (ctx: TraversalMethod_indexContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_inject`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_inject?: (ctx: TraversalMethod_injectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_is_Object`
     * labeled alternative in `GremlinParser.traversalMethod_is`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_is_Object?: (ctx: TraversalMethod_is_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_is_P`
     * labeled alternative in `GremlinParser.traversalMethod_is`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_is_P?: (ctx: TraversalMethod_is_PContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_key`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_key?: (ctx: TraversalMethod_keyContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_label`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_label?: (ctx: TraversalMethod_labelContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_length_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_length`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_length_Empty?: (ctx: TraversalMethod_length_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_length_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_length`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_length_Scope?: (ctx: TraversalMethod_length_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_limit_Scope_long`
     * labeled alternative in `GremlinParser.traversalMethod_limit`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_limit_Scope_long?: (ctx: TraversalMethod_limit_Scope_longContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_limit_long`
     * labeled alternative in `GremlinParser.traversalMethod_limit`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_limit_long?: (ctx: TraversalMethod_limit_longContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_local`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_local?: (ctx: TraversalMethod_localContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_loops_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_loops`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_loops_Empty?: (ctx: TraversalMethod_loops_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_loops_String`
     * labeled alternative in `GremlinParser.traversalMethod_loops`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_loops_String?: (ctx: TraversalMethod_loops_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_lTrim_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_lTrim`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_lTrim_Empty?: (ctx: TraversalMethod_lTrim_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_lTrim_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_lTrim`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_lTrim_Scope?: (ctx: TraversalMethod_lTrim_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_map`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_map?: (ctx: TraversalMethod_mapContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_match_traversal`
     * labeled alternative in `GremlinParser.traversalMethod_match`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_match_traversal?: (ctx: TraversalMethod_match_traversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_match_string`
     * labeled alternative in `GremlinParser.traversalMethod_match`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_match_string?: (ctx: TraversalMethod_match_stringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_match_string_map`
     * labeled alternative in `GremlinParser.traversalMethod_match`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_match_string_map?: (ctx: TraversalMethod_match_string_mapContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_math`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_math?: (ctx: TraversalMethod_mathContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_max_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_max`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_max_Empty?: (ctx: TraversalMethod_max_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_max_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_max`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_max_Scope?: (ctx: TraversalMethod_max_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_mean_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_mean`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_mean_Empty?: (ctx: TraversalMethod_mean_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_mean_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_mean`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_mean_Scope?: (ctx: TraversalMethod_mean_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_merge_Object`
     * labeled alternative in `GremlinParser.traversalMethod_merge`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_merge_Object?: (ctx: TraversalMethod_merge_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_mergeV_empty`
     * labeled alternative in `GremlinParser.traversalMethod_mergeV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_mergeV_empty?: (ctx: TraversalMethod_mergeV_emptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_mergeV_Map`
     * labeled alternative in `GremlinParser.traversalMethod_mergeV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_mergeV_Map?: (ctx: TraversalMethod_mergeV_MapContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_mergeV_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_mergeV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_mergeV_Traversal?: (ctx: TraversalMethod_mergeV_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_mergeE_empty`
     * labeled alternative in `GremlinParser.traversalMethod_mergeE`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_mergeE_empty?: (ctx: TraversalMethod_mergeE_emptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_mergeE_Map`
     * labeled alternative in `GremlinParser.traversalMethod_mergeE`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_mergeE_Map?: (ctx: TraversalMethod_mergeE_MapContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_mergeE_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_mergeE`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_mergeE_Traversal?: (ctx: TraversalMethod_mergeE_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_min_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_min`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_min_Empty?: (ctx: TraversalMethod_min_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_min_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_min`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_min_Scope?: (ctx: TraversalMethod_min_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_none_P`
     * labeled alternative in `GremlinParser.traversalMethod_none`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_none_P?: (ctx: TraversalMethod_none_PContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_not`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_not?: (ctx: TraversalMethod_notContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_option_Predicate_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_option_Predicate_Traversal?: (ctx: TraversalMethod_option_Predicate_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_option_Merge_Map`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_option_Merge_Map?: (ctx: TraversalMethod_option_Merge_MapContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_option_Merge_Map_Cardinality`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_option_Merge_Map_Cardinality?: (ctx: TraversalMethod_option_Merge_Map_CardinalityContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_option_Merge_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_option_Merge_Traversal?: (ctx: TraversalMethod_option_Merge_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_option_Object_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_option_Object_Traversal?: (ctx: TraversalMethod_option_Object_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_option_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_option_Traversal?: (ctx: TraversalMethod_option_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_optional`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_optional?: (ctx: TraversalMethod_optionalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_or`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_or?: (ctx: TraversalMethod_orContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_order_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_order`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_order_Empty?: (ctx: TraversalMethod_order_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_order_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_order`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_order_Scope?: (ctx: TraversalMethod_order_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_otherV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_otherV?: (ctx: TraversalMethod_otherVContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_out`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_out?: (ctx: TraversalMethod_outContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_outE`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_outE?: (ctx: TraversalMethod_outEContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_outV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_outV?: (ctx: TraversalMethod_outVContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_pageRank_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_pageRank`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_pageRank_Empty?: (ctx: TraversalMethod_pageRank_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_pageRank_double`
     * labeled alternative in `GremlinParser.traversalMethod_pageRank`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_pageRank_double?: (ctx: TraversalMethod_pageRank_doubleContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_path`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_path?: (ctx: TraversalMethod_pathContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_peerPressure`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_peerPressure?: (ctx: TraversalMethod_peerPressureContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_product_Object`
     * labeled alternative in `GremlinParser.traversalMethod_product`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_product_Object?: (ctx: TraversalMethod_product_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_profile_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_profile`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_profile_Empty?: (ctx: TraversalMethod_profile_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_profile_String`
     * labeled alternative in `GremlinParser.traversalMethod_profile`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_profile_String?: (ctx: TraversalMethod_profile_StringContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_project`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_project?: (ctx: TraversalMethod_projectContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_properties`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_properties?: (ctx: TraversalMethod_propertiesContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_property_Cardinality_Object_Object_Object`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_property_Cardinality_Object_Object_Object?: (ctx: TraversalMethod_property_Cardinality_Object_Object_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_property_Cardinality_Object_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_property_Cardinality_Object_Traversal?: (ctx: TraversalMethod_property_Cardinality_Object_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_property_Cardinality_Object`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_property_Cardinality_Object?: (ctx: TraversalMethod_property_Cardinality_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_property_Object_Object_Object`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_property_Object_Object_Object?: (ctx: TraversalMethod_property_Object_Object_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_property_Object_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_property_Object_Traversal?: (ctx: TraversalMethod_property_Object_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_property_Object`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_property_Object?: (ctx: TraversalMethod_property_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_property_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_property_Traversal?: (ctx: TraversalMethod_property_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_propertyMap`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_propertyMap?: (ctx: TraversalMethod_propertyMapContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_range_Scope_long_long`
     * labeled alternative in `GremlinParser.traversalMethod_range`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_range_Scope_long_long?: (ctx: TraversalMethod_range_Scope_long_longContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_range_long_long`
     * labeled alternative in `GremlinParser.traversalMethod_range`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_range_long_long?: (ctx: TraversalMethod_range_long_longContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_read`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_read?: (ctx: TraversalMethod_readContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_repeat_String_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_repeat`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_repeat_String_Traversal?: (ctx: TraversalMethod_repeat_String_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_repeat_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_repeat`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_repeat_Traversal?: (ctx: TraversalMethod_repeat_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_replace_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_replace`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_replace_String_String?: (ctx: TraversalMethod_replace_String_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_replace_Scope_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_replace`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_replace_Scope_String_String?: (ctx: TraversalMethod_replace_Scope_String_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_reverse_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_reverse`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_reverse_Empty?: (ctx: TraversalMethod_reverse_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_rTrim_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_rTrim`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_rTrim_Empty?: (ctx: TraversalMethod_rTrim_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_rTrim_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_rTrim`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_rTrim_Scope?: (ctx: TraversalMethod_rTrim_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_sack_BiFunction`
     * labeled alternative in `GremlinParser.traversalMethod_sack`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_sack_BiFunction?: (ctx: TraversalMethod_sack_BiFunctionContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_sack_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_sack`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_sack_Empty?: (ctx: TraversalMethod_sack_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_sample_Scope_int`
     * labeled alternative in `GremlinParser.traversalMethod_sample`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_sample_Scope_int?: (ctx: TraversalMethod_sample_Scope_intContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_sample_int`
     * labeled alternative in `GremlinParser.traversalMethod_sample`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_sample_int?: (ctx: TraversalMethod_sample_intContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_select_Column`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_select_Column?: (ctx: TraversalMethod_select_ColumnContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_select_Pop_String`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_select_Pop_String?: (ctx: TraversalMethod_select_Pop_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_select_Pop_String_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_select_Pop_String_String_String?: (ctx: TraversalMethod_select_Pop_String_String_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_select_Pop_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_select_Pop_Traversal?: (ctx: TraversalMethod_select_Pop_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_select_String`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_select_String?: (ctx: TraversalMethod_select_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_select_String_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_select_String_String_String?: (ctx: TraversalMethod_select_String_String_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_select_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_select_Traversal?: (ctx: TraversalMethod_select_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_shortestPath`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_shortestPath?: (ctx: TraversalMethod_shortestPathContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_sideEffect`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_sideEffect?: (ctx: TraversalMethod_sideEffectContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_simplePath`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_simplePath?: (ctx: TraversalMethod_simplePathContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_skip_Scope_long`
     * labeled alternative in `GremlinParser.traversalMethod_skip`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_skip_Scope_long?: (ctx: TraversalMethod_skip_Scope_longContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_skip_long`
     * labeled alternative in `GremlinParser.traversalMethod_skip`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_skip_long?: (ctx: TraversalMethod_skip_longContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_split_String`
     * labeled alternative in `GremlinParser.traversalMethod_split`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_split_String?: (ctx: TraversalMethod_split_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_split_Scope_String`
     * labeled alternative in `GremlinParser.traversalMethod_split`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_split_Scope_String?: (ctx: TraversalMethod_split_Scope_StringContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_subgraph`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_subgraph?: (ctx: TraversalMethod_subgraphContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_substring_int`
     * labeled alternative in `GremlinParser.traversalMethod_substring`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_substring_int?: (ctx: TraversalMethod_substring_intContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_substring_Scope_int`
     * labeled alternative in `GremlinParser.traversalMethod_substring`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_substring_Scope_int?: (ctx: TraversalMethod_substring_Scope_intContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_substring_int_int`
     * labeled alternative in `GremlinParser.traversalMethod_substring`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_substring_int_int?: (ctx: TraversalMethod_substring_int_intContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_substring_Scope_int_int`
     * labeled alternative in `GremlinParser.traversalMethod_substring`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_substring_Scope_int_int?: (ctx: TraversalMethod_substring_Scope_int_intContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_sum_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_sum`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_sum_Empty?: (ctx: TraversalMethod_sum_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_sum_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_sum`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_sum_Scope?: (ctx: TraversalMethod_sum_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_tail_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_tail`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_tail_Empty?: (ctx: TraversalMethod_tail_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_tail_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_tail`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_tail_Scope?: (ctx: TraversalMethod_tail_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_tail_Scope_long`
     * labeled alternative in `GremlinParser.traversalMethod_tail`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_tail_Scope_long?: (ctx: TraversalMethod_tail_Scope_longContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_tail_long`
     * labeled alternative in `GremlinParser.traversalMethod_tail`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_tail_long?: (ctx: TraversalMethod_tail_longContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_timeLimit`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_timeLimit?: (ctx: TraversalMethod_timeLimitContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_times`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_times?: (ctx: TraversalMethod_timesContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_to_Direction_String`
     * labeled alternative in `GremlinParser.traversalMethod_to`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_to_Direction_String?: (ctx: TraversalMethod_to_Direction_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_to_String`
     * labeled alternative in `GremlinParser.traversalMethod_to`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_to_String?: (ctx: TraversalMethod_to_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_to_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_to`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_to_Traversal?: (ctx: TraversalMethod_to_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_toE`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_toE?: (ctx: TraversalMethod_toEContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_toLower_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_toLower`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_toLower_Empty?: (ctx: TraversalMethod_toLower_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_toLower_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_toLower`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_toLower_Scope?: (ctx: TraversalMethod_toLower_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_toUpper_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_toUpper`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_toUpper_Empty?: (ctx: TraversalMethod_toUpper_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_toUpper_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_toUpper`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_toUpper_Scope?: (ctx: TraversalMethod_toUpper_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_toV`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_toV?: (ctx: TraversalMethod_toVContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_tree_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_tree`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_tree_Empty?: (ctx: TraversalMethod_tree_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_tree_String`
     * labeled alternative in `GremlinParser.traversalMethod_tree`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_tree_String?: (ctx: TraversalMethod_tree_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_trim_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_trim`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_trim_Empty?: (ctx: TraversalMethod_trim_EmptyContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_trim_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_trim`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_trim_Scope?: (ctx: TraversalMethod_trim_ScopeContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_unfold`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_unfold?: (ctx: TraversalMethod_unfoldContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_union`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_union?: (ctx: TraversalMethod_unionContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_until_Predicate`
     * labeled alternative in `GremlinParser.traversalMethod_until`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_until_Predicate?: (ctx: TraversalMethod_until_PredicateContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_until_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_until`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_until_Traversal?: (ctx: TraversalMethod_until_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_value`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_value?: (ctx: TraversalMethod_valueContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_valueMap_String`
     * labeled alternative in `GremlinParser.traversalMethod_valueMap`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_valueMap_String?: (ctx: TraversalMethod_valueMap_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_valueMap_boolean_String`
     * labeled alternative in `GremlinParser.traversalMethod_valueMap`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_valueMap_boolean_String?: (ctx: TraversalMethod_valueMap_boolean_StringContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_values`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_values?: (ctx: TraversalMethod_valuesContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_where_P`
     * labeled alternative in `GremlinParser.traversalMethod_where`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_where_P?: (ctx: TraversalMethod_where_PContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_where_String_P`
     * labeled alternative in `GremlinParser.traversalMethod_where`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_where_String_P?: (ctx: TraversalMethod_where_String_PContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_where_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_where`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_where_Traversal?: (ctx: TraversalMethod_where_TraversalContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_with_String`
     * labeled alternative in `GremlinParser.traversalMethod_with`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_with_String?: (ctx: TraversalMethod_with_StringContext) => Result;
    /**
     * Visit a parse tree produced by the `traversalMethod_with_String_Object`
     * labeled alternative in `GremlinParser.traversalMethod_with`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_with_String_Object?: (ctx: TraversalMethod_with_String_ObjectContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMethod_write`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMethod_write?: (ctx: TraversalMethod_writeContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalStrategy`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalStrategy?: (ctx: TraversalStrategyContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.configuration`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitConfiguration?: (ctx: ConfigurationContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalScope`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalScope?: (ctx: TraversalScopeContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalBarrier`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalBarrier?: (ctx: TraversalBarrierContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalT`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalT?: (ctx: TraversalTContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalTShort`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalTShort?: (ctx: TraversalTShortContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalTLong`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalTLong?: (ctx: TraversalTLongContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalMerge`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalMerge?: (ctx: TraversalMergeContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalOrder`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalOrder?: (ctx: TraversalOrderContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalDirection`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalDirection?: (ctx: TraversalDirectionContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalDirectionShort`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalDirectionShort?: (ctx: TraversalDirectionShortContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalDirectionLong`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalDirectionLong?: (ctx: TraversalDirectionLongContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalCardinality`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalCardinality?: (ctx: TraversalCardinalityContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalColumn`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalColumn?: (ctx: TraversalColumnContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPop`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPop?: (ctx: TraversalPopContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalOperator`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalOperator?: (ctx: TraversalOperatorContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPick`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPick?: (ctx: TraversalPickContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalDT`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalDT?: (ctx: TraversalDTContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalGType`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalGType?: (ctx: TraversalGTypeContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate?: (ctx: TraversalPredicateContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalTerminalMethod`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalTerminalMethod?: (ctx: TraversalTerminalMethodContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalSackMethod`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalSackMethod?: (ctx: TraversalSackMethodContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalComparator`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalComparator?: (ctx: TraversalComparatorContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalFunction`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalFunction?: (ctx: TraversalFunctionContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalBiFunction`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalBiFunction?: (ctx: TraversalBiFunctionContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_eq`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_eq?: (ctx: TraversalPredicate_eqContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_neq`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_neq?: (ctx: TraversalPredicate_neqContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_typeOf`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_typeOf?: (ctx: TraversalPredicate_typeOfContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_lt`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_lt?: (ctx: TraversalPredicate_ltContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_lte`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_lte?: (ctx: TraversalPredicate_lteContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_gt`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_gt?: (ctx: TraversalPredicate_gtContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_gte`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_gte?: (ctx: TraversalPredicate_gteContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_inside`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_inside?: (ctx: TraversalPredicate_insideContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_outside`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_outside?: (ctx: TraversalPredicate_outsideContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_between`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_between?: (ctx: TraversalPredicate_betweenContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_within`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_within?: (ctx: TraversalPredicate_withinContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_without`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_without?: (ctx: TraversalPredicate_withoutContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_not`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_not?: (ctx: TraversalPredicate_notContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_containing`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_containing?: (ctx: TraversalPredicate_containingContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_notContaining`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_notContaining?: (ctx: TraversalPredicate_notContainingContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_startingWith`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_startingWith?: (ctx: TraversalPredicate_startingWithContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_notStartingWith`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_notStartingWith?: (ctx: TraversalPredicate_notStartingWithContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_endingWith`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_endingWith?: (ctx: TraversalPredicate_endingWithContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_notEndingWith`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_notEndingWith?: (ctx: TraversalPredicate_notEndingWithContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_regex`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_regex?: (ctx: TraversalPredicate_regexContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalPredicate_notRegex`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalPredicate_notRegex?: (ctx: TraversalPredicate_notRegexContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalTerminalMethod_explain`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalTerminalMethod_explain?: (ctx: TraversalTerminalMethod_explainContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalTerminalMethod_hasNext`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalTerminalMethod_hasNext?: (ctx: TraversalTerminalMethod_hasNextContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalTerminalMethod_iterate`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalTerminalMethod_iterate?: (ctx: TraversalTerminalMethod_iterateContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalTerminalMethod_tryNext`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalTerminalMethod_tryNext?: (ctx: TraversalTerminalMethod_tryNextContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalTerminalMethod_next`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalTerminalMethod_next?: (ctx: TraversalTerminalMethod_nextContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalTerminalMethod_toList`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalTerminalMethod_toList?: (ctx: TraversalTerminalMethod_toListContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalTerminalMethod_toSet`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalTerminalMethod_toSet?: (ctx: TraversalTerminalMethod_toSetContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalTerminalMethod_toBulkSet`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalTerminalMethod_toBulkSet?: (ctx: TraversalTerminalMethod_toBulkSetContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.withOptionKeys`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitWithOptionKeys?: (ctx: WithOptionKeysContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.connectedComponentConstants`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitConnectedComponentConstants?: (ctx: ConnectedComponentConstantsContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.pageRankConstants`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPageRankConstants?: (ctx: PageRankConstantsContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.peerPressureConstants`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPeerPressureConstants?: (ctx: PeerPressureConstantsContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.shortestPathConstants`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitShortestPathConstants?: (ctx: ShortestPathConstantsContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.withOptionsValues`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitWithOptionsValues?: (ctx: WithOptionsValuesContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.ioOptionsKeys`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitIoOptionsKeys?: (ctx: IoOptionsKeysContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.ioOptionsValues`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitIoOptionsValues?: (ctx: IoOptionsValuesContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.connectedComponentConstants_component`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitConnectedComponentConstants_component?: (ctx: ConnectedComponentConstants_componentContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.connectedComponentConstants_edges`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitConnectedComponentConstants_edges?: (ctx: ConnectedComponentConstants_edgesContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.connectedComponentConstants_propertyName`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitConnectedComponentConstants_propertyName?: (ctx: ConnectedComponentConstants_propertyNameContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.pageRankConstants_edges`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPageRankConstants_edges?: (ctx: PageRankConstants_edgesContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.pageRankConstants_times`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPageRankConstants_times?: (ctx: PageRankConstants_timesContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.pageRankConstants_propertyName`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPageRankConstants_propertyName?: (ctx: PageRankConstants_propertyNameContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.peerPressureConstants_edges`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPeerPressureConstants_edges?: (ctx: PeerPressureConstants_edgesContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.peerPressureConstants_times`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPeerPressureConstants_times?: (ctx: PeerPressureConstants_timesContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.peerPressureConstants_propertyName`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPeerPressureConstants_propertyName?: (ctx: PeerPressureConstants_propertyNameContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.shortestPathConstants_target`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitShortestPathConstants_target?: (ctx: ShortestPathConstants_targetContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.shortestPathConstants_edges`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitShortestPathConstants_edges?: (ctx: ShortestPathConstants_edgesContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.shortestPathConstants_distance`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitShortestPathConstants_distance?: (ctx: ShortestPathConstants_distanceContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.shortestPathConstants_maxDistance`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitShortestPathConstants_maxDistance?: (ctx: ShortestPathConstants_maxDistanceContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.shortestPathConstants_includeEdges`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitShortestPathConstants_includeEdges?: (ctx: ShortestPathConstants_includeEdgesContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.withOptionsConstants_tokens`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitWithOptionsConstants_tokens?: (ctx: WithOptionsConstants_tokensContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.withOptionsConstants_none`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitWithOptionsConstants_none?: (ctx: WithOptionsConstants_noneContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.withOptionsConstants_ids`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitWithOptionsConstants_ids?: (ctx: WithOptionsConstants_idsContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.withOptionsConstants_labels`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitWithOptionsConstants_labels?: (ctx: WithOptionsConstants_labelsContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.withOptionsConstants_keys`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitWithOptionsConstants_keys?: (ctx: WithOptionsConstants_keysContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.withOptionsConstants_values`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitWithOptionsConstants_values?: (ctx: WithOptionsConstants_valuesContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.withOptionsConstants_all`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitWithOptionsConstants_all?: (ctx: WithOptionsConstants_allContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.withOptionsConstants_indexer`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitWithOptionsConstants_indexer?: (ctx: WithOptionsConstants_indexerContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.withOptionsConstants_list`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitWithOptionsConstants_list?: (ctx: WithOptionsConstants_listContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.withOptionsConstants_map`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitWithOptionsConstants_map?: (ctx: WithOptionsConstants_mapContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.ioOptionsConstants_reader`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitIoOptionsConstants_reader?: (ctx: IoOptionsConstants_readerContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.ioOptionsConstants_writer`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitIoOptionsConstants_writer?: (ctx: IoOptionsConstants_writerContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.ioOptionsConstants_gryo`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitIoOptionsConstants_gryo?: (ctx: IoOptionsConstants_gryoContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.ioOptionsConstants_graphson`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitIoOptionsConstants_graphson?: (ctx: IoOptionsConstants_graphsonContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.ioOptionsConstants_graphml`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitIoOptionsConstants_graphml?: (ctx: IoOptionsConstants_graphmlContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.connectedComponentStringConstant`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitConnectedComponentStringConstant?: (ctx: ConnectedComponentStringConstantContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.pageRankStringConstant`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPageRankStringConstant?: (ctx: PageRankStringConstantContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.peerPressureStringConstant`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPeerPressureStringConstant?: (ctx: PeerPressureStringConstantContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.shortestPathStringConstant`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitShortestPathStringConstant?: (ctx: ShortestPathStringConstantContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.withOptionsStringConstant`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitWithOptionsStringConstant?: (ctx: WithOptionsStringConstantContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.ioOptionsStringConstant`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitIoOptionsStringConstant?: (ctx: IoOptionsStringConstantContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.booleanArgument`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitBooleanArgument?: (ctx: BooleanArgumentContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.integerArgument`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitIntegerArgument?: (ctx: IntegerArgumentContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.stringArgument`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitStringArgument?: (ctx: StringArgumentContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.stringNullableArgument`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitStringNullableArgument?: (ctx: StringNullableArgumentContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.stringNullableArgumentVarargs`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitStringNullableArgumentVarargs?: (ctx: StringNullableArgumentVarargsContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.dateArgument`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitDateArgument?: (ctx: DateArgumentContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.genericArgument`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitGenericArgument?: (ctx: GenericArgumentContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.genericArgumentVarargs`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitGenericArgumentVarargs?: (ctx: GenericArgumentVarargsContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.genericMapArgument`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitGenericMapArgument?: (ctx: GenericMapArgumentContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.genericMapNullableArgument`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitGenericMapNullableArgument?: (ctx: GenericMapNullableArgumentContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.nullableGenericLiteralMap`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitNullableGenericLiteralMap?: (ctx: NullableGenericLiteralMapContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalStrategyVarargs`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalStrategyVarargs?: (ctx: TraversalStrategyVarargsContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.traversalStrategyExpr`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitTraversalStrategyExpr?: (ctx: TraversalStrategyExprContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.classTypeList`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitClassTypeList?: (ctx: ClassTypeListContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.classTypeExpr`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitClassTypeExpr?: (ctx: ClassTypeExprContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.nestedTraversalList`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitNestedTraversalList?: (ctx: NestedTraversalListContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.nestedTraversalExpr`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitNestedTraversalExpr?: (ctx: NestedTraversalExprContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.genericCollectionLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitGenericCollectionLiteral?: (ctx: GenericCollectionLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.genericLiteralVarargs`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitGenericLiteralVarargs?: (ctx: GenericLiteralVarargsContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.genericLiteralExpr`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitGenericLiteralExpr?: (ctx: GenericLiteralExprContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.genericMapNullableLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitGenericMapNullableLiteral?: (ctx: GenericMapNullableLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.genericRangeLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitGenericRangeLiteral?: (ctx: GenericRangeLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.genericSetLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitGenericSetLiteral?: (ctx: GenericSetLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.stringNullableLiteralVarargs`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitStringNullableLiteralVarargs?: (ctx: StringNullableLiteralVarargsContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.genericLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitGenericLiteral?: (ctx: GenericLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.genericMapLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitGenericMapLiteral?: (ctx: GenericMapLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.mapKey`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitMapKey?: (ctx: MapKeyContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.mapEntry`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitMapEntry?: (ctx: MapEntryContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.stringLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitStringLiteral?: (ctx: StringLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.stringNullableLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitStringNullableLiteral?: (ctx: StringNullableLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.integerLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitIntegerLiteral?: (ctx: IntegerLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.floatLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitFloatLiteral?: (ctx: FloatLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.numericLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitNumericLiteral?: (ctx: NumericLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.booleanLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitBooleanLiteral?: (ctx: BooleanLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.dateLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitDateLiteral?: (ctx: DateLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.nullLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitNullLiteral?: (ctx: NullLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.nanLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitNanLiteral?: (ctx: NanLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.infLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitInfLiteral?: (ctx: InfLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.uuidLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitUuidLiteral?: (ctx: UuidLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.characterLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitCharacterLiteral?: (ctx: CharacterLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.durationLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitDurationLiteral?: (ctx: DurationLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.binaryLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitBinaryLiteral?: (ctx: BinaryLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.pdtLiteral`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPdtLiteral?: (ctx: PdtLiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.nakedKey`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitNakedKey?: (ctx: NakedKeyContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.classType`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitClassType?: (ctx: ClassTypeContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.variable`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitVariable?: (ctx: VariableContext) => Result;
    /**
     * Visit a parse tree produced by `GremlinParser.keyword`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitKeyword?: (ctx: KeywordContext) => Result;
}

