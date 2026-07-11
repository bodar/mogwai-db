// Generated from Gremlin.g4 by ANTLR 4.13.1

import { ErrorNode, ParseTreeListener, ParserRuleContext, TerminalNode } from "antlr4ng";


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
 * This interface defines a complete listener for a parse tree produced by
 * `GremlinParser`.
 */
export class GremlinListener implements ParseTreeListener {
    /**
     * Enter a parse tree produced by `GremlinParser.queryList`.
     * @param ctx the parse tree
     */
    enterQueryList?: (ctx: QueryListContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.queryList`.
     * @param ctx the parse tree
     */
    exitQueryList?: (ctx: QueryListContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.query`.
     * @param ctx the parse tree
     */
    enterQuery?: (ctx: QueryContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.query`.
     * @param ctx the parse tree
     */
    exitQuery?: (ctx: QueryContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.emptyQuery`.
     * @param ctx the parse tree
     */
    enterEmptyQuery?: (ctx: EmptyQueryContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.emptyQuery`.
     * @param ctx the parse tree
     */
    exitEmptyQuery?: (ctx: EmptyQueryContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSource`.
     * @param ctx the parse tree
     */
    enterTraversalSource?: (ctx: TraversalSourceContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSource`.
     * @param ctx the parse tree
     */
    exitTraversalSource?: (ctx: TraversalSourceContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.transactionPart`.
     * @param ctx the parse tree
     */
    enterTransactionPart?: (ctx: TransactionPartContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.transactionPart`.
     * @param ctx the parse tree
     */
    exitTransactionPart?: (ctx: TransactionPartContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.rootTraversal`.
     * @param ctx the parse tree
     */
    enterRootTraversal?: (ctx: RootTraversalContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.rootTraversal`.
     * @param ctx the parse tree
     */
    exitRootTraversal?: (ctx: RootTraversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSelfMethod`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSelfMethod?: (ctx: TraversalSourceSelfMethodContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSelfMethod`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSelfMethod?: (ctx: TraversalSourceSelfMethodContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withBulk`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSelfMethod_withBulk?: (ctx: TraversalSourceSelfMethod_withBulkContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withBulk`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSelfMethod_withBulk?: (ctx: TraversalSourceSelfMethod_withBulkContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withPath`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSelfMethod_withPath?: (ctx: TraversalSourceSelfMethod_withPathContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withPath`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSelfMethod_withPath?: (ctx: TraversalSourceSelfMethod_withPathContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withSack`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSelfMethod_withSack?: (ctx: TraversalSourceSelfMethod_withSackContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withSack`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSelfMethod_withSack?: (ctx: TraversalSourceSelfMethod_withSackContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withSideEffect`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSelfMethod_withSideEffect?: (ctx: TraversalSourceSelfMethod_withSideEffectContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withSideEffect`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSelfMethod_withSideEffect?: (ctx: TraversalSourceSelfMethod_withSideEffectContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withStrategies`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSelfMethod_withStrategies?: (ctx: TraversalSourceSelfMethod_withStrategiesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withStrategies`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSelfMethod_withStrategies?: (ctx: TraversalSourceSelfMethod_withStrategiesContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withoutStrategies`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSelfMethod_withoutStrategies?: (ctx: TraversalSourceSelfMethod_withoutStrategiesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_withoutStrategies`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSelfMethod_withoutStrategies?: (ctx: TraversalSourceSelfMethod_withoutStrategiesContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSelfMethod_with`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSelfMethod_with?: (ctx: TraversalSourceSelfMethod_withContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSelfMethod_with`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSelfMethod_with?: (ctx: TraversalSourceSelfMethod_withContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSpawnMethod`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod?: (ctx: TraversalSourceSpawnMethodContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod?: (ctx: TraversalSourceSpawnMethodContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_addE`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_addE?: (ctx: TraversalSourceSpawnMethod_addEContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_addE`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_addE?: (ctx: TraversalSourceSpawnMethod_addEContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_addV`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_addV?: (ctx: TraversalSourceSpawnMethod_addVContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_addV`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_addV?: (ctx: TraversalSourceSpawnMethod_addVContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_E`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_E?: (ctx: TraversalSourceSpawnMethod_EContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_E`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_E?: (ctx: TraversalSourceSpawnMethod_EContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_V`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_V?: (ctx: TraversalSourceSpawnMethod_VContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_V`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_V?: (ctx: TraversalSourceSpawnMethod_VContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_inject`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_inject?: (ctx: TraversalSourceSpawnMethod_injectContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_inject`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_inject?: (ctx: TraversalSourceSpawnMethod_injectContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_io`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_io?: (ctx: TraversalSourceSpawnMethod_ioContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_io`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_io?: (ctx: TraversalSourceSpawnMethod_ioContext) => void;
    /**
     * Enter a parse tree produced by the `traversalSourceSpawnMethod_mergeV_Map`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_mergeV`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_mergeV_Map?: (ctx: TraversalSourceSpawnMethod_mergeV_MapContext) => void;
    /**
     * Exit a parse tree produced by the `traversalSourceSpawnMethod_mergeV_Map`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_mergeV`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_mergeV_Map?: (ctx: TraversalSourceSpawnMethod_mergeV_MapContext) => void;
    /**
     * Enter a parse tree produced by the `traversalSourceSpawnMethod_mergeV_Traversal`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_mergeV`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_mergeV_Traversal?: (ctx: TraversalSourceSpawnMethod_mergeV_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalSourceSpawnMethod_mergeV_Traversal`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_mergeV`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_mergeV_Traversal?: (ctx: TraversalSourceSpawnMethod_mergeV_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalSourceSpawnMethod_mergeE_Map`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_mergeE`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_mergeE_Map?: (ctx: TraversalSourceSpawnMethod_mergeE_MapContext) => void;
    /**
     * Exit a parse tree produced by the `traversalSourceSpawnMethod_mergeE_Map`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_mergeE`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_mergeE_Map?: (ctx: TraversalSourceSpawnMethod_mergeE_MapContext) => void;
    /**
     * Enter a parse tree produced by the `traversalSourceSpawnMethod_mergeE_Traversal`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_mergeE`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_mergeE_Traversal?: (ctx: TraversalSourceSpawnMethod_mergeE_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalSourceSpawnMethod_mergeE_Traversal`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_mergeE`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_mergeE_Traversal?: (ctx: TraversalSourceSpawnMethod_mergeE_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalSourceSpawnMethod_call_empty`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_call_empty?: (ctx: TraversalSourceSpawnMethod_call_emptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalSourceSpawnMethod_call_empty`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_call_empty?: (ctx: TraversalSourceSpawnMethod_call_emptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalSourceSpawnMethod_call_string`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_call_string?: (ctx: TraversalSourceSpawnMethod_call_stringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalSourceSpawnMethod_call_string`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_call_string?: (ctx: TraversalSourceSpawnMethod_call_stringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalSourceSpawnMethod_call_string_map`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_call_string_map?: (ctx: TraversalSourceSpawnMethod_call_string_mapContext) => void;
    /**
     * Exit a parse tree produced by the `traversalSourceSpawnMethod_call_string_map`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_call_string_map?: (ctx: TraversalSourceSpawnMethod_call_string_mapContext) => void;
    /**
     * Enter a parse tree produced by the `traversalSourceSpawnMethod_call_string_traversal`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_call_string_traversal?: (ctx: TraversalSourceSpawnMethod_call_string_traversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalSourceSpawnMethod_call_string_traversal`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_call_string_traversal?: (ctx: TraversalSourceSpawnMethod_call_string_traversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalSourceSpawnMethod_call_string_map_traversal`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_call_string_map_traversal?: (ctx: TraversalSourceSpawnMethod_call_string_map_traversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalSourceSpawnMethod_call_string_map_traversal`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_call`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_call_string_map_traversal?: (ctx: TraversalSourceSpawnMethod_call_string_map_traversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_union`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_union?: (ctx: TraversalSourceSpawnMethod_unionContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSourceSpawnMethod_union`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_union?: (ctx: TraversalSourceSpawnMethod_unionContext) => void;
    /**
     * Enter a parse tree produced by the `traversalSourceSpawnMethod_match_string`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_match`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_match_string?: (ctx: TraversalSourceSpawnMethod_match_stringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalSourceSpawnMethod_match_string`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_match`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_match_string?: (ctx: TraversalSourceSpawnMethod_match_stringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalSourceSpawnMethod_match_string_map`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_match`.
     * @param ctx the parse tree
     */
    enterTraversalSourceSpawnMethod_match_string_map?: (ctx: TraversalSourceSpawnMethod_match_string_mapContext) => void;
    /**
     * Exit a parse tree produced by the `traversalSourceSpawnMethod_match_string_map`
     * labeled alternative in `GremlinParser.traversalSourceSpawnMethod_match`.
     * @param ctx the parse tree
     */
    exitTraversalSourceSpawnMethod_match_string_map?: (ctx: TraversalSourceSpawnMethod_match_string_mapContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.chainedTraversal`.
     * @param ctx the parse tree
     */
    enterChainedTraversal?: (ctx: ChainedTraversalContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.chainedTraversal`.
     * @param ctx the parse tree
     */
    exitChainedTraversal?: (ctx: ChainedTraversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.nestedTraversal`.
     * @param ctx the parse tree
     */
    enterNestedTraversal?: (ctx: NestedTraversalContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.nestedTraversal`.
     * @param ctx the parse tree
     */
    exitNestedTraversal?: (ctx: NestedTraversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.terminatedTraversal`.
     * @param ctx the parse tree
     */
    enterTerminatedTraversal?: (ctx: TerminatedTraversalContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.terminatedTraversal`.
     * @param ctx the parse tree
     */
    exitTerminatedTraversal?: (ctx: TerminatedTraversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod`.
     * @param ctx the parse tree
     */
    enterTraversalMethod?: (ctx: TraversalMethodContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod`.
     * @param ctx the parse tree
     */
    exitTraversalMethod?: (ctx: TraversalMethodContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_V`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_V?: (ctx: TraversalMethod_VContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_V`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_V?: (ctx: TraversalMethod_VContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_E`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_E?: (ctx: TraversalMethod_EContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_E`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_E?: (ctx: TraversalMethod_EContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_addE_String`
     * labeled alternative in `GremlinParser.traversalMethod_addE`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_addE_String?: (ctx: TraversalMethod_addE_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_addE_String`
     * labeled alternative in `GremlinParser.traversalMethod_addE`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_addE_String?: (ctx: TraversalMethod_addE_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_addE_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_addE`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_addE_Traversal?: (ctx: TraversalMethod_addE_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_addE_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_addE`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_addE_Traversal?: (ctx: TraversalMethod_addE_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_addV_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_addV`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_addV_Empty?: (ctx: TraversalMethod_addV_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_addV_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_addV`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_addV_Empty?: (ctx: TraversalMethod_addV_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_addV_String`
     * labeled alternative in `GremlinParser.traversalMethod_addV`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_addV_String?: (ctx: TraversalMethod_addV_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_addV_String`
     * labeled alternative in `GremlinParser.traversalMethod_addV`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_addV_String?: (ctx: TraversalMethod_addV_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_addV_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_addV`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_addV_Traversal?: (ctx: TraversalMethod_addV_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_addV_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_addV`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_addV_Traversal?: (ctx: TraversalMethod_addV_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_aggregate_String`
     * labeled alternative in `GremlinParser.traversalMethod_aggregate`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_aggregate_String?: (ctx: TraversalMethod_aggregate_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_aggregate_String`
     * labeled alternative in `GremlinParser.traversalMethod_aggregate`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_aggregate_String?: (ctx: TraversalMethod_aggregate_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_all_P`
     * labeled alternative in `GremlinParser.traversalMethod_all`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_all_P?: (ctx: TraversalMethod_all_PContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_all_P`
     * labeled alternative in `GremlinParser.traversalMethod_all`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_all_P?: (ctx: TraversalMethod_all_PContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_and`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_and?: (ctx: TraversalMethod_andContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_and`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_and?: (ctx: TraversalMethod_andContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_any_P`
     * labeled alternative in `GremlinParser.traversalMethod_any`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_any_P?: (ctx: TraversalMethod_any_PContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_any_P`
     * labeled alternative in `GremlinParser.traversalMethod_any`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_any_P?: (ctx: TraversalMethod_any_PContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_as`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_as?: (ctx: TraversalMethod_asContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_as`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_as?: (ctx: TraversalMethod_asContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_asBool`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_asBool?: (ctx: TraversalMethod_asBoolContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_asBool`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_asBool?: (ctx: TraversalMethod_asBoolContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_asDate`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_asDate?: (ctx: TraversalMethod_asDateContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_asDate`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_asDate?: (ctx: TraversalMethod_asDateContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_asNumber_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_asNumber`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_asNumber_Empty?: (ctx: TraversalMethod_asNumber_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_asNumber_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_asNumber`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_asNumber_Empty?: (ctx: TraversalMethod_asNumber_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_asNumber_traversalGType`
     * labeled alternative in `GremlinParser.traversalMethod_asNumber`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_asNumber_traversalGType?: (ctx: TraversalMethod_asNumber_traversalGTypeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_asNumber_traversalGType`
     * labeled alternative in `GremlinParser.traversalMethod_asNumber`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_asNumber_traversalGType?: (ctx: TraversalMethod_asNumber_traversalGTypeContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_asString_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_asString`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_asString_Empty?: (ctx: TraversalMethod_asString_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_asString_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_asString`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_asString_Empty?: (ctx: TraversalMethod_asString_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_asString_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_asString`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_asString_Scope?: (ctx: TraversalMethod_asString_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_asString_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_asString`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_asString_Scope?: (ctx: TraversalMethod_asString_ScopeContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_barrier_Consumer`
     * labeled alternative in `GremlinParser.traversalMethod_barrier`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_barrier_Consumer?: (ctx: TraversalMethod_barrier_ConsumerContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_barrier_Consumer`
     * labeled alternative in `GremlinParser.traversalMethod_barrier`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_barrier_Consumer?: (ctx: TraversalMethod_barrier_ConsumerContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_barrier_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_barrier`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_barrier_Empty?: (ctx: TraversalMethod_barrier_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_barrier_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_barrier`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_barrier_Empty?: (ctx: TraversalMethod_barrier_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_barrier_int`
     * labeled alternative in `GremlinParser.traversalMethod_barrier`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_barrier_int?: (ctx: TraversalMethod_barrier_intContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_barrier_int`
     * labeled alternative in `GremlinParser.traversalMethod_barrier`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_barrier_int?: (ctx: TraversalMethod_barrier_intContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_both`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_both?: (ctx: TraversalMethod_bothContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_both`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_both?: (ctx: TraversalMethod_bothContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_bothE`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_bothE?: (ctx: TraversalMethod_bothEContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_bothE`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_bothE?: (ctx: TraversalMethod_bothEContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_bothV`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_bothV?: (ctx: TraversalMethod_bothVContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_bothV`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_bothV?: (ctx: TraversalMethod_bothVContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_branch`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_branch?: (ctx: TraversalMethod_branchContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_branch`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_branch?: (ctx: TraversalMethod_branchContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_by_Comparator`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_by_Comparator?: (ctx: TraversalMethod_by_ComparatorContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_by_Comparator`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_by_Comparator?: (ctx: TraversalMethod_by_ComparatorContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_by_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_by_Empty?: (ctx: TraversalMethod_by_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_by_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_by_Empty?: (ctx: TraversalMethod_by_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_by_Function`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_by_Function?: (ctx: TraversalMethod_by_FunctionContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_by_Function`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_by_Function?: (ctx: TraversalMethod_by_FunctionContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_by_Function_Comparator`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_by_Function_Comparator?: (ctx: TraversalMethod_by_Function_ComparatorContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_by_Function_Comparator`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_by_Function_Comparator?: (ctx: TraversalMethod_by_Function_ComparatorContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_by_Order`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_by_Order?: (ctx: TraversalMethod_by_OrderContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_by_Order`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_by_Order?: (ctx: TraversalMethod_by_OrderContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_by_String`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_by_String?: (ctx: TraversalMethod_by_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_by_String`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_by_String?: (ctx: TraversalMethod_by_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_by_String_Comparator`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_by_String_Comparator?: (ctx: TraversalMethod_by_String_ComparatorContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_by_String_Comparator`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_by_String_Comparator?: (ctx: TraversalMethod_by_String_ComparatorContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_by_T`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_by_T?: (ctx: TraversalMethod_by_TContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_by_T`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_by_T?: (ctx: TraversalMethod_by_TContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_by_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_by_Traversal?: (ctx: TraversalMethod_by_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_by_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_by_Traversal?: (ctx: TraversalMethod_by_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_by_Traversal_Comparator`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_by_Traversal_Comparator?: (ctx: TraversalMethod_by_Traversal_ComparatorContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_by_Traversal_Comparator`
     * labeled alternative in `GremlinParser.traversalMethod_by`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_by_Traversal_Comparator?: (ctx: TraversalMethod_by_Traversal_ComparatorContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_call_string`
     * labeled alternative in `GremlinParser.traversalMethod_call`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_call_string?: (ctx: TraversalMethod_call_stringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_call_string`
     * labeled alternative in `GremlinParser.traversalMethod_call`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_call_string?: (ctx: TraversalMethod_call_stringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_call_string_map`
     * labeled alternative in `GremlinParser.traversalMethod_call`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_call_string_map?: (ctx: TraversalMethod_call_string_mapContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_call_string_map`
     * labeled alternative in `GremlinParser.traversalMethod_call`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_call_string_map?: (ctx: TraversalMethod_call_string_mapContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_call_string_traversal`
     * labeled alternative in `GremlinParser.traversalMethod_call`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_call_string_traversal?: (ctx: TraversalMethod_call_string_traversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_call_string_traversal`
     * labeled alternative in `GremlinParser.traversalMethod_call`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_call_string_traversal?: (ctx: TraversalMethod_call_string_traversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_call_string_map_traversal`
     * labeled alternative in `GremlinParser.traversalMethod_call`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_call_string_map_traversal?: (ctx: TraversalMethod_call_string_map_traversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_call_string_map_traversal`
     * labeled alternative in `GremlinParser.traversalMethod_call`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_call_string_map_traversal?: (ctx: TraversalMethod_call_string_map_traversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_cap`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_cap?: (ctx: TraversalMethod_capContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_cap`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_cap?: (ctx: TraversalMethod_capContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_choose_Function`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_choose_Function?: (ctx: TraversalMethod_choose_FunctionContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_choose_Function`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_choose_Function?: (ctx: TraversalMethod_choose_FunctionContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_choose_Predicate_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_choose_Predicate_Traversal?: (ctx: TraversalMethod_choose_Predicate_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_choose_Predicate_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_choose_Predicate_Traversal?: (ctx: TraversalMethod_choose_Predicate_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_choose_Predicate_Traversal_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_choose_Predicate_Traversal_Traversal?: (ctx: TraversalMethod_choose_Predicate_Traversal_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_choose_Predicate_Traversal_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_choose_Predicate_Traversal_Traversal?: (ctx: TraversalMethod_choose_Predicate_Traversal_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_choose_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_choose_Traversal?: (ctx: TraversalMethod_choose_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_choose_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_choose_Traversal?: (ctx: TraversalMethod_choose_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_choose_Traversal_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_choose_Traversal_Traversal?: (ctx: TraversalMethod_choose_Traversal_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_choose_Traversal_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_choose_Traversal_Traversal?: (ctx: TraversalMethod_choose_Traversal_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_choose_Traversal_Traversal_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_choose_Traversal_Traversal_Traversal?: (ctx: TraversalMethod_choose_Traversal_Traversal_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_choose_Traversal_Traversal_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_choose`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_choose_Traversal_Traversal_Traversal?: (ctx: TraversalMethod_choose_Traversal_Traversal_TraversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_coalesce`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_coalesce?: (ctx: TraversalMethod_coalesceContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_coalesce`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_coalesce?: (ctx: TraversalMethod_coalesceContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_coin`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_coin?: (ctx: TraversalMethod_coinContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_coin`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_coin?: (ctx: TraversalMethod_coinContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_combine_Object`
     * labeled alternative in `GremlinParser.traversalMethod_combine`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_combine_Object?: (ctx: TraversalMethod_combine_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_combine_Object`
     * labeled alternative in `GremlinParser.traversalMethod_combine`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_combine_Object?: (ctx: TraversalMethod_combine_ObjectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_concat_Traversal_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_concat`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_concat_Traversal_Traversal?: (ctx: TraversalMethod_concat_Traversal_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_concat_Traversal_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_concat`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_concat_Traversal_Traversal?: (ctx: TraversalMethod_concat_Traversal_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_concat_String`
     * labeled alternative in `GremlinParser.traversalMethod_concat`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_concat_String?: (ctx: TraversalMethod_concat_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_concat_String`
     * labeled alternative in `GremlinParser.traversalMethod_concat`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_concat_String?: (ctx: TraversalMethod_concat_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_conjoin_String`
     * labeled alternative in `GremlinParser.traversalMethod_conjoin`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_conjoin_String?: (ctx: TraversalMethod_conjoin_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_conjoin_String`
     * labeled alternative in `GremlinParser.traversalMethod_conjoin`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_conjoin_String?: (ctx: TraversalMethod_conjoin_StringContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_connectedComponent`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_connectedComponent?: (ctx: TraversalMethod_connectedComponentContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_connectedComponent`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_connectedComponent?: (ctx: TraversalMethod_connectedComponentContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_constant`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_constant?: (ctx: TraversalMethod_constantContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_constant`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_constant?: (ctx: TraversalMethod_constantContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_count_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_count`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_count_Empty?: (ctx: TraversalMethod_count_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_count_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_count`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_count_Empty?: (ctx: TraversalMethod_count_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_count_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_count`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_count_Scope?: (ctx: TraversalMethod_count_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_count_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_count`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_count_Scope?: (ctx: TraversalMethod_count_ScopeContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_cyclicPath`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_cyclicPath?: (ctx: TraversalMethod_cyclicPathContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_cyclicPath`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_cyclicPath?: (ctx: TraversalMethod_cyclicPathContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_dateAdd`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_dateAdd?: (ctx: TraversalMethod_dateAddContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_dateAdd`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_dateAdd?: (ctx: TraversalMethod_dateAddContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_dateDiff_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_dateDiff`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_dateDiff_Traversal?: (ctx: TraversalMethod_dateDiff_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_dateDiff_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_dateDiff`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_dateDiff_Traversal?: (ctx: TraversalMethod_dateDiff_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_dateDiff_Date`
     * labeled alternative in `GremlinParser.traversalMethod_dateDiff`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_dateDiff_Date?: (ctx: TraversalMethod_dateDiff_DateContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_dateDiff_Date`
     * labeled alternative in `GremlinParser.traversalMethod_dateDiff`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_dateDiff_Date?: (ctx: TraversalMethod_dateDiff_DateContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_dedup_Scope_String`
     * labeled alternative in `GremlinParser.traversalMethod_dedup`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_dedup_Scope_String?: (ctx: TraversalMethod_dedup_Scope_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_dedup_Scope_String`
     * labeled alternative in `GremlinParser.traversalMethod_dedup`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_dedup_Scope_String?: (ctx: TraversalMethod_dedup_Scope_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_dedup_String`
     * labeled alternative in `GremlinParser.traversalMethod_dedup`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_dedup_String?: (ctx: TraversalMethod_dedup_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_dedup_String`
     * labeled alternative in `GremlinParser.traversalMethod_dedup`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_dedup_String?: (ctx: TraversalMethod_dedup_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_difference_Object`
     * labeled alternative in `GremlinParser.traversalMethod_difference`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_difference_Object?: (ctx: TraversalMethod_difference_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_difference_Object`
     * labeled alternative in `GremlinParser.traversalMethod_difference`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_difference_Object?: (ctx: TraversalMethod_difference_ObjectContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_discard`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_discard?: (ctx: TraversalMethod_discardContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_discard`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_discard?: (ctx: TraversalMethod_discardContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_disjunct_Object`
     * labeled alternative in `GremlinParser.traversalMethod_disjunct`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_disjunct_Object?: (ctx: TraversalMethod_disjunct_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_disjunct_Object`
     * labeled alternative in `GremlinParser.traversalMethod_disjunct`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_disjunct_Object?: (ctx: TraversalMethod_disjunct_ObjectContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_drop`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_drop?: (ctx: TraversalMethod_dropContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_drop`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_drop?: (ctx: TraversalMethod_dropContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_element`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_element?: (ctx: TraversalMethod_elementContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_element`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_element?: (ctx: TraversalMethod_elementContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_elementMap`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_elementMap?: (ctx: TraversalMethod_elementMapContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_elementMap`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_elementMap?: (ctx: TraversalMethod_elementMapContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_emit_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_emit`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_emit_Empty?: (ctx: TraversalMethod_emit_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_emit_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_emit`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_emit_Empty?: (ctx: TraversalMethod_emit_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_emit_Predicate`
     * labeled alternative in `GremlinParser.traversalMethod_emit`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_emit_Predicate?: (ctx: TraversalMethod_emit_PredicateContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_emit_Predicate`
     * labeled alternative in `GremlinParser.traversalMethod_emit`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_emit_Predicate?: (ctx: TraversalMethod_emit_PredicateContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_emit_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_emit`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_emit_Traversal?: (ctx: TraversalMethod_emit_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_emit_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_emit`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_emit_Traversal?: (ctx: TraversalMethod_emit_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_fail_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_fail`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_fail_Empty?: (ctx: TraversalMethod_fail_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_fail_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_fail`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_fail_Empty?: (ctx: TraversalMethod_fail_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_fail_String`
     * labeled alternative in `GremlinParser.traversalMethod_fail`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_fail_String?: (ctx: TraversalMethod_fail_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_fail_String`
     * labeled alternative in `GremlinParser.traversalMethod_fail`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_fail_String?: (ctx: TraversalMethod_fail_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_filter_Predicate`
     * labeled alternative in `GremlinParser.traversalMethod_filter`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_filter_Predicate?: (ctx: TraversalMethod_filter_PredicateContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_filter_Predicate`
     * labeled alternative in `GremlinParser.traversalMethod_filter`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_filter_Predicate?: (ctx: TraversalMethod_filter_PredicateContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_filter_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_filter`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_filter_Traversal?: (ctx: TraversalMethod_filter_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_filter_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_filter`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_filter_Traversal?: (ctx: TraversalMethod_filter_TraversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_flatMap`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_flatMap?: (ctx: TraversalMethod_flatMapContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_flatMap`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_flatMap?: (ctx: TraversalMethod_flatMapContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_fold_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_fold`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_fold_Empty?: (ctx: TraversalMethod_fold_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_fold_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_fold`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_fold_Empty?: (ctx: TraversalMethod_fold_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_fold_Object_BiFunction`
     * labeled alternative in `GremlinParser.traversalMethod_fold`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_fold_Object_BiFunction?: (ctx: TraversalMethod_fold_Object_BiFunctionContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_fold_Object_BiFunction`
     * labeled alternative in `GremlinParser.traversalMethod_fold`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_fold_Object_BiFunction?: (ctx: TraversalMethod_fold_Object_BiFunctionContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_format_String`
     * labeled alternative in `GremlinParser.traversalMethod_format`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_format_String?: (ctx: TraversalMethod_format_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_format_String`
     * labeled alternative in `GremlinParser.traversalMethod_format`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_format_String?: (ctx: TraversalMethod_format_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_from_String`
     * labeled alternative in `GremlinParser.traversalMethod_from`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_from_String?: (ctx: TraversalMethod_from_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_from_String`
     * labeled alternative in `GremlinParser.traversalMethod_from`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_from_String?: (ctx: TraversalMethod_from_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_from_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_from`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_from_Traversal?: (ctx: TraversalMethod_from_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_from_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_from`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_from_Traversal?: (ctx: TraversalMethod_from_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_group_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_group`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_group_Empty?: (ctx: TraversalMethod_group_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_group_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_group`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_group_Empty?: (ctx: TraversalMethod_group_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_group_String`
     * labeled alternative in `GremlinParser.traversalMethod_group`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_group_String?: (ctx: TraversalMethod_group_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_group_String`
     * labeled alternative in `GremlinParser.traversalMethod_group`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_group_String?: (ctx: TraversalMethod_group_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_groupCount_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_groupCount`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_groupCount_Empty?: (ctx: TraversalMethod_groupCount_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_groupCount_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_groupCount`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_groupCount_Empty?: (ctx: TraversalMethod_groupCount_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_groupCount_String`
     * labeled alternative in `GremlinParser.traversalMethod_groupCount`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_groupCount_String?: (ctx: TraversalMethod_groupCount_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_groupCount_String`
     * labeled alternative in `GremlinParser.traversalMethod_groupCount`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_groupCount_String?: (ctx: TraversalMethod_groupCount_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_has_String`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_has_String?: (ctx: TraversalMethod_has_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_has_String`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_has_String?: (ctx: TraversalMethod_has_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_has_String_Object`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_has_String_Object?: (ctx: TraversalMethod_has_String_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_has_String_Object`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_has_String_Object?: (ctx: TraversalMethod_has_String_ObjectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_has_String_P`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_has_String_P?: (ctx: TraversalMethod_has_String_PContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_has_String_P`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_has_String_P?: (ctx: TraversalMethod_has_String_PContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_has_String_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_has_String_Traversal?: (ctx: TraversalMethod_has_String_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_has_String_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_has_String_Traversal?: (ctx: TraversalMethod_has_String_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_has_String_String_Object`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_has_String_String_Object?: (ctx: TraversalMethod_has_String_String_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_has_String_String_Object`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_has_String_String_Object?: (ctx: TraversalMethod_has_String_String_ObjectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_has_String_String_P`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_has_String_String_P?: (ctx: TraversalMethod_has_String_String_PContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_has_String_String_P`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_has_String_String_P?: (ctx: TraversalMethod_has_String_String_PContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_has_String_String_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_has_String_String_Traversal?: (ctx: TraversalMethod_has_String_String_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_has_String_String_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_has_String_String_Traversal?: (ctx: TraversalMethod_has_String_String_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_has_T_Object`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_has_T_Object?: (ctx: TraversalMethod_has_T_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_has_T_Object`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_has_T_Object?: (ctx: TraversalMethod_has_T_ObjectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_has_T_P`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_has_T_P?: (ctx: TraversalMethod_has_T_PContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_has_T_P`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_has_T_P?: (ctx: TraversalMethod_has_T_PContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_has_T_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_has_T_Traversal?: (ctx: TraversalMethod_has_T_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_has_T_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_has`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_has_T_Traversal?: (ctx: TraversalMethod_has_T_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_hasId_Object_Object`
     * labeled alternative in `GremlinParser.traversalMethod_hasId`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_hasId_Object_Object?: (ctx: TraversalMethod_hasId_Object_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_hasId_Object_Object`
     * labeled alternative in `GremlinParser.traversalMethod_hasId`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_hasId_Object_Object?: (ctx: TraversalMethod_hasId_Object_ObjectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_hasId_P`
     * labeled alternative in `GremlinParser.traversalMethod_hasId`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_hasId_P?: (ctx: TraversalMethod_hasId_PContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_hasId_P`
     * labeled alternative in `GremlinParser.traversalMethod_hasId`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_hasId_P?: (ctx: TraversalMethod_hasId_PContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_hasKey_P`
     * labeled alternative in `GremlinParser.traversalMethod_hasKey`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_hasKey_P?: (ctx: TraversalMethod_hasKey_PContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_hasKey_P`
     * labeled alternative in `GremlinParser.traversalMethod_hasKey`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_hasKey_P?: (ctx: TraversalMethod_hasKey_PContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_hasKey_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_hasKey`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_hasKey_String_String?: (ctx: TraversalMethod_hasKey_String_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_hasKey_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_hasKey`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_hasKey_String_String?: (ctx: TraversalMethod_hasKey_String_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_hasKey_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_hasKey`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_hasKey_Traversal?: (ctx: TraversalMethod_hasKey_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_hasKey_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_hasKey`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_hasKey_Traversal?: (ctx: TraversalMethod_hasKey_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_hasLabel_P`
     * labeled alternative in `GremlinParser.traversalMethod_hasLabel`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_hasLabel_P?: (ctx: TraversalMethod_hasLabel_PContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_hasLabel_P`
     * labeled alternative in `GremlinParser.traversalMethod_hasLabel`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_hasLabel_P?: (ctx: TraversalMethod_hasLabel_PContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_hasLabel_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_hasLabel`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_hasLabel_String_String?: (ctx: TraversalMethod_hasLabel_String_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_hasLabel_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_hasLabel`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_hasLabel_String_String?: (ctx: TraversalMethod_hasLabel_String_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_hasLabel_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_hasLabel`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_hasLabel_Traversal?: (ctx: TraversalMethod_hasLabel_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_hasLabel_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_hasLabel`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_hasLabel_Traversal?: (ctx: TraversalMethod_hasLabel_TraversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_hasNot`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_hasNot?: (ctx: TraversalMethod_hasNotContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_hasNot`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_hasNot?: (ctx: TraversalMethod_hasNotContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_hasValue_Object_Object`
     * labeled alternative in `GremlinParser.traversalMethod_hasValue`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_hasValue_Object_Object?: (ctx: TraversalMethod_hasValue_Object_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_hasValue_Object_Object`
     * labeled alternative in `GremlinParser.traversalMethod_hasValue`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_hasValue_Object_Object?: (ctx: TraversalMethod_hasValue_Object_ObjectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_hasValue_P`
     * labeled alternative in `GremlinParser.traversalMethod_hasValue`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_hasValue_P?: (ctx: TraversalMethod_hasValue_PContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_hasValue_P`
     * labeled alternative in `GremlinParser.traversalMethod_hasValue`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_hasValue_P?: (ctx: TraversalMethod_hasValue_PContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_hasValue_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_hasValue`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_hasValue_Traversal?: (ctx: TraversalMethod_hasValue_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_hasValue_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_hasValue`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_hasValue_Traversal?: (ctx: TraversalMethod_hasValue_TraversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_id`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_id?: (ctx: TraversalMethod_idContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_id`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_id?: (ctx: TraversalMethod_idContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_identity`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_identity?: (ctx: TraversalMethod_identityContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_identity`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_identity?: (ctx: TraversalMethod_identityContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_in`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_in?: (ctx: TraversalMethod_inContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_in`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_in?: (ctx: TraversalMethod_inContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_inE`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_inE?: (ctx: TraversalMethod_inEContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_inE`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_inE?: (ctx: TraversalMethod_inEContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_intersect_Object`
     * labeled alternative in `GremlinParser.traversalMethod_intersect`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_intersect_Object?: (ctx: TraversalMethod_intersect_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_intersect_Object`
     * labeled alternative in `GremlinParser.traversalMethod_intersect`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_intersect_Object?: (ctx: TraversalMethod_intersect_ObjectContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_inV`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_inV?: (ctx: TraversalMethod_inVContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_inV`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_inV?: (ctx: TraversalMethod_inVContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_index`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_index?: (ctx: TraversalMethod_indexContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_index`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_index?: (ctx: TraversalMethod_indexContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_inject`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_inject?: (ctx: TraversalMethod_injectContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_inject`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_inject?: (ctx: TraversalMethod_injectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_is_Object`
     * labeled alternative in `GremlinParser.traversalMethod_is`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_is_Object?: (ctx: TraversalMethod_is_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_is_Object`
     * labeled alternative in `GremlinParser.traversalMethod_is`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_is_Object?: (ctx: TraversalMethod_is_ObjectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_is_P`
     * labeled alternative in `GremlinParser.traversalMethod_is`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_is_P?: (ctx: TraversalMethod_is_PContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_is_P`
     * labeled alternative in `GremlinParser.traversalMethod_is`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_is_P?: (ctx: TraversalMethod_is_PContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_key`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_key?: (ctx: TraversalMethod_keyContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_key`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_key?: (ctx: TraversalMethod_keyContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_label`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_label?: (ctx: TraversalMethod_labelContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_label`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_label?: (ctx: TraversalMethod_labelContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_length_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_length`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_length_Empty?: (ctx: TraversalMethod_length_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_length_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_length`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_length_Empty?: (ctx: TraversalMethod_length_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_length_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_length`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_length_Scope?: (ctx: TraversalMethod_length_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_length_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_length`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_length_Scope?: (ctx: TraversalMethod_length_ScopeContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_limit_Scope_long`
     * labeled alternative in `GremlinParser.traversalMethod_limit`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_limit_Scope_long?: (ctx: TraversalMethod_limit_Scope_longContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_limit_Scope_long`
     * labeled alternative in `GremlinParser.traversalMethod_limit`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_limit_Scope_long?: (ctx: TraversalMethod_limit_Scope_longContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_limit_long`
     * labeled alternative in `GremlinParser.traversalMethod_limit`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_limit_long?: (ctx: TraversalMethod_limit_longContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_limit_long`
     * labeled alternative in `GremlinParser.traversalMethod_limit`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_limit_long?: (ctx: TraversalMethod_limit_longContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_local`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_local?: (ctx: TraversalMethod_localContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_local`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_local?: (ctx: TraversalMethod_localContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_loops_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_loops`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_loops_Empty?: (ctx: TraversalMethod_loops_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_loops_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_loops`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_loops_Empty?: (ctx: TraversalMethod_loops_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_loops_String`
     * labeled alternative in `GremlinParser.traversalMethod_loops`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_loops_String?: (ctx: TraversalMethod_loops_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_loops_String`
     * labeled alternative in `GremlinParser.traversalMethod_loops`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_loops_String?: (ctx: TraversalMethod_loops_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_lTrim_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_lTrim`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_lTrim_Empty?: (ctx: TraversalMethod_lTrim_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_lTrim_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_lTrim`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_lTrim_Empty?: (ctx: TraversalMethod_lTrim_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_lTrim_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_lTrim`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_lTrim_Scope?: (ctx: TraversalMethod_lTrim_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_lTrim_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_lTrim`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_lTrim_Scope?: (ctx: TraversalMethod_lTrim_ScopeContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_map`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_map?: (ctx: TraversalMethod_mapContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_map`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_map?: (ctx: TraversalMethod_mapContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_match_traversal`
     * labeled alternative in `GremlinParser.traversalMethod_match`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_match_traversal?: (ctx: TraversalMethod_match_traversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_match_traversal`
     * labeled alternative in `GremlinParser.traversalMethod_match`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_match_traversal?: (ctx: TraversalMethod_match_traversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_match_string`
     * labeled alternative in `GremlinParser.traversalMethod_match`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_match_string?: (ctx: TraversalMethod_match_stringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_match_string`
     * labeled alternative in `GremlinParser.traversalMethod_match`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_match_string?: (ctx: TraversalMethod_match_stringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_match_string_map`
     * labeled alternative in `GremlinParser.traversalMethod_match`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_match_string_map?: (ctx: TraversalMethod_match_string_mapContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_match_string_map`
     * labeled alternative in `GremlinParser.traversalMethod_match`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_match_string_map?: (ctx: TraversalMethod_match_string_mapContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_math`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_math?: (ctx: TraversalMethod_mathContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_math`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_math?: (ctx: TraversalMethod_mathContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_max_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_max`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_max_Empty?: (ctx: TraversalMethod_max_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_max_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_max`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_max_Empty?: (ctx: TraversalMethod_max_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_max_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_max`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_max_Scope?: (ctx: TraversalMethod_max_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_max_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_max`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_max_Scope?: (ctx: TraversalMethod_max_ScopeContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_mean_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_mean`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_mean_Empty?: (ctx: TraversalMethod_mean_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_mean_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_mean`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_mean_Empty?: (ctx: TraversalMethod_mean_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_mean_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_mean`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_mean_Scope?: (ctx: TraversalMethod_mean_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_mean_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_mean`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_mean_Scope?: (ctx: TraversalMethod_mean_ScopeContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_merge_Object`
     * labeled alternative in `GremlinParser.traversalMethod_merge`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_merge_Object?: (ctx: TraversalMethod_merge_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_merge_Object`
     * labeled alternative in `GremlinParser.traversalMethod_merge`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_merge_Object?: (ctx: TraversalMethod_merge_ObjectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_mergeV_empty`
     * labeled alternative in `GremlinParser.traversalMethod_mergeV`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_mergeV_empty?: (ctx: TraversalMethod_mergeV_emptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_mergeV_empty`
     * labeled alternative in `GremlinParser.traversalMethod_mergeV`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_mergeV_empty?: (ctx: TraversalMethod_mergeV_emptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_mergeV_Map`
     * labeled alternative in `GremlinParser.traversalMethod_mergeV`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_mergeV_Map?: (ctx: TraversalMethod_mergeV_MapContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_mergeV_Map`
     * labeled alternative in `GremlinParser.traversalMethod_mergeV`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_mergeV_Map?: (ctx: TraversalMethod_mergeV_MapContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_mergeV_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_mergeV`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_mergeV_Traversal?: (ctx: TraversalMethod_mergeV_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_mergeV_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_mergeV`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_mergeV_Traversal?: (ctx: TraversalMethod_mergeV_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_mergeE_empty`
     * labeled alternative in `GremlinParser.traversalMethod_mergeE`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_mergeE_empty?: (ctx: TraversalMethod_mergeE_emptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_mergeE_empty`
     * labeled alternative in `GremlinParser.traversalMethod_mergeE`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_mergeE_empty?: (ctx: TraversalMethod_mergeE_emptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_mergeE_Map`
     * labeled alternative in `GremlinParser.traversalMethod_mergeE`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_mergeE_Map?: (ctx: TraversalMethod_mergeE_MapContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_mergeE_Map`
     * labeled alternative in `GremlinParser.traversalMethod_mergeE`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_mergeE_Map?: (ctx: TraversalMethod_mergeE_MapContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_mergeE_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_mergeE`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_mergeE_Traversal?: (ctx: TraversalMethod_mergeE_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_mergeE_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_mergeE`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_mergeE_Traversal?: (ctx: TraversalMethod_mergeE_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_min_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_min`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_min_Empty?: (ctx: TraversalMethod_min_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_min_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_min`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_min_Empty?: (ctx: TraversalMethod_min_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_min_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_min`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_min_Scope?: (ctx: TraversalMethod_min_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_min_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_min`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_min_Scope?: (ctx: TraversalMethod_min_ScopeContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_none_P`
     * labeled alternative in `GremlinParser.traversalMethod_none`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_none_P?: (ctx: TraversalMethod_none_PContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_none_P`
     * labeled alternative in `GremlinParser.traversalMethod_none`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_none_P?: (ctx: TraversalMethod_none_PContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_not`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_not?: (ctx: TraversalMethod_notContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_not`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_not?: (ctx: TraversalMethod_notContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_option_Predicate_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_option_Predicate_Traversal?: (ctx: TraversalMethod_option_Predicate_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_option_Predicate_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_option_Predicate_Traversal?: (ctx: TraversalMethod_option_Predicate_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_option_Merge_Map`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_option_Merge_Map?: (ctx: TraversalMethod_option_Merge_MapContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_option_Merge_Map`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_option_Merge_Map?: (ctx: TraversalMethod_option_Merge_MapContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_option_Merge_Map_Cardinality`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_option_Merge_Map_Cardinality?: (ctx: TraversalMethod_option_Merge_Map_CardinalityContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_option_Merge_Map_Cardinality`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_option_Merge_Map_Cardinality?: (ctx: TraversalMethod_option_Merge_Map_CardinalityContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_option_Merge_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_option_Merge_Traversal?: (ctx: TraversalMethod_option_Merge_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_option_Merge_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_option_Merge_Traversal?: (ctx: TraversalMethod_option_Merge_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_option_Object_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_option_Object_Traversal?: (ctx: TraversalMethod_option_Object_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_option_Object_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_option_Object_Traversal?: (ctx: TraversalMethod_option_Object_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_option_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_option_Traversal?: (ctx: TraversalMethod_option_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_option_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_option`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_option_Traversal?: (ctx: TraversalMethod_option_TraversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_optional`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_optional?: (ctx: TraversalMethod_optionalContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_optional`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_optional?: (ctx: TraversalMethod_optionalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_or`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_or?: (ctx: TraversalMethod_orContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_or`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_or?: (ctx: TraversalMethod_orContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_order_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_order`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_order_Empty?: (ctx: TraversalMethod_order_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_order_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_order`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_order_Empty?: (ctx: TraversalMethod_order_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_order_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_order`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_order_Scope?: (ctx: TraversalMethod_order_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_order_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_order`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_order_Scope?: (ctx: TraversalMethod_order_ScopeContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_otherV`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_otherV?: (ctx: TraversalMethod_otherVContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_otherV`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_otherV?: (ctx: TraversalMethod_otherVContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_out`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_out?: (ctx: TraversalMethod_outContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_out`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_out?: (ctx: TraversalMethod_outContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_outE`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_outE?: (ctx: TraversalMethod_outEContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_outE`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_outE?: (ctx: TraversalMethod_outEContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_outV`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_outV?: (ctx: TraversalMethod_outVContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_outV`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_outV?: (ctx: TraversalMethod_outVContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_pageRank_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_pageRank`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_pageRank_Empty?: (ctx: TraversalMethod_pageRank_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_pageRank_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_pageRank`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_pageRank_Empty?: (ctx: TraversalMethod_pageRank_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_pageRank_double`
     * labeled alternative in `GremlinParser.traversalMethod_pageRank`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_pageRank_double?: (ctx: TraversalMethod_pageRank_doubleContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_pageRank_double`
     * labeled alternative in `GremlinParser.traversalMethod_pageRank`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_pageRank_double?: (ctx: TraversalMethod_pageRank_doubleContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_path`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_path?: (ctx: TraversalMethod_pathContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_path`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_path?: (ctx: TraversalMethod_pathContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_peerPressure`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_peerPressure?: (ctx: TraversalMethod_peerPressureContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_peerPressure`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_peerPressure?: (ctx: TraversalMethod_peerPressureContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_product_Object`
     * labeled alternative in `GremlinParser.traversalMethod_product`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_product_Object?: (ctx: TraversalMethod_product_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_product_Object`
     * labeled alternative in `GremlinParser.traversalMethod_product`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_product_Object?: (ctx: TraversalMethod_product_ObjectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_profile_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_profile`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_profile_Empty?: (ctx: TraversalMethod_profile_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_profile_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_profile`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_profile_Empty?: (ctx: TraversalMethod_profile_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_profile_String`
     * labeled alternative in `GremlinParser.traversalMethod_profile`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_profile_String?: (ctx: TraversalMethod_profile_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_profile_String`
     * labeled alternative in `GremlinParser.traversalMethod_profile`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_profile_String?: (ctx: TraversalMethod_profile_StringContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_project`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_project?: (ctx: TraversalMethod_projectContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_project`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_project?: (ctx: TraversalMethod_projectContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_properties`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_properties?: (ctx: TraversalMethod_propertiesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_properties`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_properties?: (ctx: TraversalMethod_propertiesContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_property_Cardinality_Object_Object_Object`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_property_Cardinality_Object_Object_Object?: (ctx: TraversalMethod_property_Cardinality_Object_Object_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_property_Cardinality_Object_Object_Object`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_property_Cardinality_Object_Object_Object?: (ctx: TraversalMethod_property_Cardinality_Object_Object_ObjectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_property_Cardinality_Object_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_property_Cardinality_Object_Traversal?: (ctx: TraversalMethod_property_Cardinality_Object_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_property_Cardinality_Object_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_property_Cardinality_Object_Traversal?: (ctx: TraversalMethod_property_Cardinality_Object_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_property_Cardinality_Object`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_property_Cardinality_Object?: (ctx: TraversalMethod_property_Cardinality_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_property_Cardinality_Object`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_property_Cardinality_Object?: (ctx: TraversalMethod_property_Cardinality_ObjectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_property_Object_Object_Object`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_property_Object_Object_Object?: (ctx: TraversalMethod_property_Object_Object_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_property_Object_Object_Object`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_property_Object_Object_Object?: (ctx: TraversalMethod_property_Object_Object_ObjectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_property_Object_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_property_Object_Traversal?: (ctx: TraversalMethod_property_Object_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_property_Object_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_property_Object_Traversal?: (ctx: TraversalMethod_property_Object_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_property_Object`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_property_Object?: (ctx: TraversalMethod_property_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_property_Object`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_property_Object?: (ctx: TraversalMethod_property_ObjectContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_property_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_property_Traversal?: (ctx: TraversalMethod_property_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_property_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_property`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_property_Traversal?: (ctx: TraversalMethod_property_TraversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_propertyMap`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_propertyMap?: (ctx: TraversalMethod_propertyMapContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_propertyMap`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_propertyMap?: (ctx: TraversalMethod_propertyMapContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_range_Scope_long_long`
     * labeled alternative in `GremlinParser.traversalMethod_range`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_range_Scope_long_long?: (ctx: TraversalMethod_range_Scope_long_longContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_range_Scope_long_long`
     * labeled alternative in `GremlinParser.traversalMethod_range`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_range_Scope_long_long?: (ctx: TraversalMethod_range_Scope_long_longContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_range_long_long`
     * labeled alternative in `GremlinParser.traversalMethod_range`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_range_long_long?: (ctx: TraversalMethod_range_long_longContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_range_long_long`
     * labeled alternative in `GremlinParser.traversalMethod_range`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_range_long_long?: (ctx: TraversalMethod_range_long_longContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_read`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_read?: (ctx: TraversalMethod_readContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_read`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_read?: (ctx: TraversalMethod_readContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_repeat_String_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_repeat`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_repeat_String_Traversal?: (ctx: TraversalMethod_repeat_String_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_repeat_String_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_repeat`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_repeat_String_Traversal?: (ctx: TraversalMethod_repeat_String_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_repeat_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_repeat`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_repeat_Traversal?: (ctx: TraversalMethod_repeat_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_repeat_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_repeat`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_repeat_Traversal?: (ctx: TraversalMethod_repeat_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_replace_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_replace`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_replace_String_String?: (ctx: TraversalMethod_replace_String_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_replace_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_replace`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_replace_String_String?: (ctx: TraversalMethod_replace_String_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_replace_Scope_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_replace`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_replace_Scope_String_String?: (ctx: TraversalMethod_replace_Scope_String_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_replace_Scope_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_replace`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_replace_Scope_String_String?: (ctx: TraversalMethod_replace_Scope_String_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_reverse_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_reverse`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_reverse_Empty?: (ctx: TraversalMethod_reverse_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_reverse_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_reverse`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_reverse_Empty?: (ctx: TraversalMethod_reverse_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_rTrim_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_rTrim`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_rTrim_Empty?: (ctx: TraversalMethod_rTrim_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_rTrim_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_rTrim`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_rTrim_Empty?: (ctx: TraversalMethod_rTrim_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_rTrim_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_rTrim`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_rTrim_Scope?: (ctx: TraversalMethod_rTrim_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_rTrim_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_rTrim`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_rTrim_Scope?: (ctx: TraversalMethod_rTrim_ScopeContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_sack_BiFunction`
     * labeled alternative in `GremlinParser.traversalMethod_sack`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_sack_BiFunction?: (ctx: TraversalMethod_sack_BiFunctionContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_sack_BiFunction`
     * labeled alternative in `GremlinParser.traversalMethod_sack`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_sack_BiFunction?: (ctx: TraversalMethod_sack_BiFunctionContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_sack_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_sack`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_sack_Empty?: (ctx: TraversalMethod_sack_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_sack_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_sack`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_sack_Empty?: (ctx: TraversalMethod_sack_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_sample_Scope_int`
     * labeled alternative in `GremlinParser.traversalMethod_sample`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_sample_Scope_int?: (ctx: TraversalMethod_sample_Scope_intContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_sample_Scope_int`
     * labeled alternative in `GremlinParser.traversalMethod_sample`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_sample_Scope_int?: (ctx: TraversalMethod_sample_Scope_intContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_sample_int`
     * labeled alternative in `GremlinParser.traversalMethod_sample`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_sample_int?: (ctx: TraversalMethod_sample_intContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_sample_int`
     * labeled alternative in `GremlinParser.traversalMethod_sample`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_sample_int?: (ctx: TraversalMethod_sample_intContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_select_Column`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_select_Column?: (ctx: TraversalMethod_select_ColumnContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_select_Column`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_select_Column?: (ctx: TraversalMethod_select_ColumnContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_select_Pop_String`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_select_Pop_String?: (ctx: TraversalMethod_select_Pop_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_select_Pop_String`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_select_Pop_String?: (ctx: TraversalMethod_select_Pop_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_select_Pop_String_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_select_Pop_String_String_String?: (ctx: TraversalMethod_select_Pop_String_String_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_select_Pop_String_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_select_Pop_String_String_String?: (ctx: TraversalMethod_select_Pop_String_String_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_select_Pop_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_select_Pop_Traversal?: (ctx: TraversalMethod_select_Pop_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_select_Pop_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_select_Pop_Traversal?: (ctx: TraversalMethod_select_Pop_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_select_String`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_select_String?: (ctx: TraversalMethod_select_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_select_String`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_select_String?: (ctx: TraversalMethod_select_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_select_String_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_select_String_String_String?: (ctx: TraversalMethod_select_String_String_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_select_String_String_String`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_select_String_String_String?: (ctx: TraversalMethod_select_String_String_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_select_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_select_Traversal?: (ctx: TraversalMethod_select_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_select_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_select`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_select_Traversal?: (ctx: TraversalMethod_select_TraversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_shortestPath`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_shortestPath?: (ctx: TraversalMethod_shortestPathContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_shortestPath`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_shortestPath?: (ctx: TraversalMethod_shortestPathContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_sideEffect`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_sideEffect?: (ctx: TraversalMethod_sideEffectContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_sideEffect`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_sideEffect?: (ctx: TraversalMethod_sideEffectContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_simplePath`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_simplePath?: (ctx: TraversalMethod_simplePathContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_simplePath`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_simplePath?: (ctx: TraversalMethod_simplePathContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_skip_Scope_long`
     * labeled alternative in `GremlinParser.traversalMethod_skip`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_skip_Scope_long?: (ctx: TraversalMethod_skip_Scope_longContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_skip_Scope_long`
     * labeled alternative in `GremlinParser.traversalMethod_skip`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_skip_Scope_long?: (ctx: TraversalMethod_skip_Scope_longContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_skip_long`
     * labeled alternative in `GremlinParser.traversalMethod_skip`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_skip_long?: (ctx: TraversalMethod_skip_longContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_skip_long`
     * labeled alternative in `GremlinParser.traversalMethod_skip`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_skip_long?: (ctx: TraversalMethod_skip_longContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_split_String`
     * labeled alternative in `GremlinParser.traversalMethod_split`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_split_String?: (ctx: TraversalMethod_split_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_split_String`
     * labeled alternative in `GremlinParser.traversalMethod_split`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_split_String?: (ctx: TraversalMethod_split_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_split_Scope_String`
     * labeled alternative in `GremlinParser.traversalMethod_split`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_split_Scope_String?: (ctx: TraversalMethod_split_Scope_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_split_Scope_String`
     * labeled alternative in `GremlinParser.traversalMethod_split`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_split_Scope_String?: (ctx: TraversalMethod_split_Scope_StringContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_subgraph`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_subgraph?: (ctx: TraversalMethod_subgraphContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_subgraph`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_subgraph?: (ctx: TraversalMethod_subgraphContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_substring_int`
     * labeled alternative in `GremlinParser.traversalMethod_substring`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_substring_int?: (ctx: TraversalMethod_substring_intContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_substring_int`
     * labeled alternative in `GremlinParser.traversalMethod_substring`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_substring_int?: (ctx: TraversalMethod_substring_intContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_substring_Scope_int`
     * labeled alternative in `GremlinParser.traversalMethod_substring`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_substring_Scope_int?: (ctx: TraversalMethod_substring_Scope_intContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_substring_Scope_int`
     * labeled alternative in `GremlinParser.traversalMethod_substring`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_substring_Scope_int?: (ctx: TraversalMethod_substring_Scope_intContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_substring_int_int`
     * labeled alternative in `GremlinParser.traversalMethod_substring`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_substring_int_int?: (ctx: TraversalMethod_substring_int_intContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_substring_int_int`
     * labeled alternative in `GremlinParser.traversalMethod_substring`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_substring_int_int?: (ctx: TraversalMethod_substring_int_intContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_substring_Scope_int_int`
     * labeled alternative in `GremlinParser.traversalMethod_substring`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_substring_Scope_int_int?: (ctx: TraversalMethod_substring_Scope_int_intContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_substring_Scope_int_int`
     * labeled alternative in `GremlinParser.traversalMethod_substring`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_substring_Scope_int_int?: (ctx: TraversalMethod_substring_Scope_int_intContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_sum_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_sum`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_sum_Empty?: (ctx: TraversalMethod_sum_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_sum_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_sum`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_sum_Empty?: (ctx: TraversalMethod_sum_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_sum_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_sum`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_sum_Scope?: (ctx: TraversalMethod_sum_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_sum_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_sum`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_sum_Scope?: (ctx: TraversalMethod_sum_ScopeContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_tail_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_tail`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_tail_Empty?: (ctx: TraversalMethod_tail_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_tail_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_tail`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_tail_Empty?: (ctx: TraversalMethod_tail_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_tail_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_tail`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_tail_Scope?: (ctx: TraversalMethod_tail_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_tail_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_tail`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_tail_Scope?: (ctx: TraversalMethod_tail_ScopeContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_tail_Scope_long`
     * labeled alternative in `GremlinParser.traversalMethod_tail`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_tail_Scope_long?: (ctx: TraversalMethod_tail_Scope_longContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_tail_Scope_long`
     * labeled alternative in `GremlinParser.traversalMethod_tail`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_tail_Scope_long?: (ctx: TraversalMethod_tail_Scope_longContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_tail_long`
     * labeled alternative in `GremlinParser.traversalMethod_tail`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_tail_long?: (ctx: TraversalMethod_tail_longContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_tail_long`
     * labeled alternative in `GremlinParser.traversalMethod_tail`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_tail_long?: (ctx: TraversalMethod_tail_longContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_timeLimit`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_timeLimit?: (ctx: TraversalMethod_timeLimitContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_timeLimit`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_timeLimit?: (ctx: TraversalMethod_timeLimitContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_times`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_times?: (ctx: TraversalMethod_timesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_times`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_times?: (ctx: TraversalMethod_timesContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_to_Direction_String`
     * labeled alternative in `GremlinParser.traversalMethod_to`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_to_Direction_String?: (ctx: TraversalMethod_to_Direction_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_to_Direction_String`
     * labeled alternative in `GremlinParser.traversalMethod_to`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_to_Direction_String?: (ctx: TraversalMethod_to_Direction_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_to_String`
     * labeled alternative in `GremlinParser.traversalMethod_to`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_to_String?: (ctx: TraversalMethod_to_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_to_String`
     * labeled alternative in `GremlinParser.traversalMethod_to`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_to_String?: (ctx: TraversalMethod_to_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_to_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_to`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_to_Traversal?: (ctx: TraversalMethod_to_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_to_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_to`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_to_Traversal?: (ctx: TraversalMethod_to_TraversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_toE`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_toE?: (ctx: TraversalMethod_toEContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_toE`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_toE?: (ctx: TraversalMethod_toEContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_toLower_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_toLower`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_toLower_Empty?: (ctx: TraversalMethod_toLower_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_toLower_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_toLower`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_toLower_Empty?: (ctx: TraversalMethod_toLower_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_toLower_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_toLower`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_toLower_Scope?: (ctx: TraversalMethod_toLower_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_toLower_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_toLower`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_toLower_Scope?: (ctx: TraversalMethod_toLower_ScopeContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_toUpper_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_toUpper`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_toUpper_Empty?: (ctx: TraversalMethod_toUpper_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_toUpper_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_toUpper`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_toUpper_Empty?: (ctx: TraversalMethod_toUpper_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_toUpper_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_toUpper`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_toUpper_Scope?: (ctx: TraversalMethod_toUpper_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_toUpper_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_toUpper`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_toUpper_Scope?: (ctx: TraversalMethod_toUpper_ScopeContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_toV`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_toV?: (ctx: TraversalMethod_toVContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_toV`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_toV?: (ctx: TraversalMethod_toVContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_tree_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_tree`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_tree_Empty?: (ctx: TraversalMethod_tree_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_tree_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_tree`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_tree_Empty?: (ctx: TraversalMethod_tree_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_tree_String`
     * labeled alternative in `GremlinParser.traversalMethod_tree`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_tree_String?: (ctx: TraversalMethod_tree_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_tree_String`
     * labeled alternative in `GremlinParser.traversalMethod_tree`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_tree_String?: (ctx: TraversalMethod_tree_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_trim_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_trim`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_trim_Empty?: (ctx: TraversalMethod_trim_EmptyContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_trim_Empty`
     * labeled alternative in `GremlinParser.traversalMethod_trim`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_trim_Empty?: (ctx: TraversalMethod_trim_EmptyContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_trim_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_trim`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_trim_Scope?: (ctx: TraversalMethod_trim_ScopeContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_trim_Scope`
     * labeled alternative in `GremlinParser.traversalMethod_trim`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_trim_Scope?: (ctx: TraversalMethod_trim_ScopeContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_unfold`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_unfold?: (ctx: TraversalMethod_unfoldContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_unfold`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_unfold?: (ctx: TraversalMethod_unfoldContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_union`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_union?: (ctx: TraversalMethod_unionContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_union`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_union?: (ctx: TraversalMethod_unionContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_until_Predicate`
     * labeled alternative in `GremlinParser.traversalMethod_until`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_until_Predicate?: (ctx: TraversalMethod_until_PredicateContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_until_Predicate`
     * labeled alternative in `GremlinParser.traversalMethod_until`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_until_Predicate?: (ctx: TraversalMethod_until_PredicateContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_until_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_until`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_until_Traversal?: (ctx: TraversalMethod_until_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_until_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_until`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_until_Traversal?: (ctx: TraversalMethod_until_TraversalContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_value`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_value?: (ctx: TraversalMethod_valueContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_value`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_value?: (ctx: TraversalMethod_valueContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_valueMap_String`
     * labeled alternative in `GremlinParser.traversalMethod_valueMap`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_valueMap_String?: (ctx: TraversalMethod_valueMap_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_valueMap_String`
     * labeled alternative in `GremlinParser.traversalMethod_valueMap`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_valueMap_String?: (ctx: TraversalMethod_valueMap_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_valueMap_boolean_String`
     * labeled alternative in `GremlinParser.traversalMethod_valueMap`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_valueMap_boolean_String?: (ctx: TraversalMethod_valueMap_boolean_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_valueMap_boolean_String`
     * labeled alternative in `GremlinParser.traversalMethod_valueMap`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_valueMap_boolean_String?: (ctx: TraversalMethod_valueMap_boolean_StringContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_values`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_values?: (ctx: TraversalMethod_valuesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_values`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_values?: (ctx: TraversalMethod_valuesContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_where_P`
     * labeled alternative in `GremlinParser.traversalMethod_where`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_where_P?: (ctx: TraversalMethod_where_PContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_where_P`
     * labeled alternative in `GremlinParser.traversalMethod_where`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_where_P?: (ctx: TraversalMethod_where_PContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_where_String_P`
     * labeled alternative in `GremlinParser.traversalMethod_where`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_where_String_P?: (ctx: TraversalMethod_where_String_PContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_where_String_P`
     * labeled alternative in `GremlinParser.traversalMethod_where`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_where_String_P?: (ctx: TraversalMethod_where_String_PContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_where_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_where`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_where_Traversal?: (ctx: TraversalMethod_where_TraversalContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_where_Traversal`
     * labeled alternative in `GremlinParser.traversalMethod_where`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_where_Traversal?: (ctx: TraversalMethod_where_TraversalContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_with_String`
     * labeled alternative in `GremlinParser.traversalMethod_with`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_with_String?: (ctx: TraversalMethod_with_StringContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_with_String`
     * labeled alternative in `GremlinParser.traversalMethod_with`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_with_String?: (ctx: TraversalMethod_with_StringContext) => void;
    /**
     * Enter a parse tree produced by the `traversalMethod_with_String_Object`
     * labeled alternative in `GremlinParser.traversalMethod_with`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_with_String_Object?: (ctx: TraversalMethod_with_String_ObjectContext) => void;
    /**
     * Exit a parse tree produced by the `traversalMethod_with_String_Object`
     * labeled alternative in `GremlinParser.traversalMethod_with`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_with_String_Object?: (ctx: TraversalMethod_with_String_ObjectContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMethod_write`.
     * @param ctx the parse tree
     */
    enterTraversalMethod_write?: (ctx: TraversalMethod_writeContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMethod_write`.
     * @param ctx the parse tree
     */
    exitTraversalMethod_write?: (ctx: TraversalMethod_writeContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalStrategy`.
     * @param ctx the parse tree
     */
    enterTraversalStrategy?: (ctx: TraversalStrategyContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalStrategy`.
     * @param ctx the parse tree
     */
    exitTraversalStrategy?: (ctx: TraversalStrategyContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.configuration`.
     * @param ctx the parse tree
     */
    enterConfiguration?: (ctx: ConfigurationContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.configuration`.
     * @param ctx the parse tree
     */
    exitConfiguration?: (ctx: ConfigurationContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalScope`.
     * @param ctx the parse tree
     */
    enterTraversalScope?: (ctx: TraversalScopeContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalScope`.
     * @param ctx the parse tree
     */
    exitTraversalScope?: (ctx: TraversalScopeContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalBarrier`.
     * @param ctx the parse tree
     */
    enterTraversalBarrier?: (ctx: TraversalBarrierContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalBarrier`.
     * @param ctx the parse tree
     */
    exitTraversalBarrier?: (ctx: TraversalBarrierContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalT`.
     * @param ctx the parse tree
     */
    enterTraversalT?: (ctx: TraversalTContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalT`.
     * @param ctx the parse tree
     */
    exitTraversalT?: (ctx: TraversalTContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalTShort`.
     * @param ctx the parse tree
     */
    enterTraversalTShort?: (ctx: TraversalTShortContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalTShort`.
     * @param ctx the parse tree
     */
    exitTraversalTShort?: (ctx: TraversalTShortContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalTLong`.
     * @param ctx the parse tree
     */
    enterTraversalTLong?: (ctx: TraversalTLongContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalTLong`.
     * @param ctx the parse tree
     */
    exitTraversalTLong?: (ctx: TraversalTLongContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalMerge`.
     * @param ctx the parse tree
     */
    enterTraversalMerge?: (ctx: TraversalMergeContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalMerge`.
     * @param ctx the parse tree
     */
    exitTraversalMerge?: (ctx: TraversalMergeContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalOrder`.
     * @param ctx the parse tree
     */
    enterTraversalOrder?: (ctx: TraversalOrderContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalOrder`.
     * @param ctx the parse tree
     */
    exitTraversalOrder?: (ctx: TraversalOrderContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalDirection`.
     * @param ctx the parse tree
     */
    enterTraversalDirection?: (ctx: TraversalDirectionContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalDirection`.
     * @param ctx the parse tree
     */
    exitTraversalDirection?: (ctx: TraversalDirectionContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalDirectionShort`.
     * @param ctx the parse tree
     */
    enterTraversalDirectionShort?: (ctx: TraversalDirectionShortContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalDirectionShort`.
     * @param ctx the parse tree
     */
    exitTraversalDirectionShort?: (ctx: TraversalDirectionShortContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalDirectionLong`.
     * @param ctx the parse tree
     */
    enterTraversalDirectionLong?: (ctx: TraversalDirectionLongContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalDirectionLong`.
     * @param ctx the parse tree
     */
    exitTraversalDirectionLong?: (ctx: TraversalDirectionLongContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalCardinality`.
     * @param ctx the parse tree
     */
    enterTraversalCardinality?: (ctx: TraversalCardinalityContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalCardinality`.
     * @param ctx the parse tree
     */
    exitTraversalCardinality?: (ctx: TraversalCardinalityContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalColumn`.
     * @param ctx the parse tree
     */
    enterTraversalColumn?: (ctx: TraversalColumnContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalColumn`.
     * @param ctx the parse tree
     */
    exitTraversalColumn?: (ctx: TraversalColumnContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPop`.
     * @param ctx the parse tree
     */
    enterTraversalPop?: (ctx: TraversalPopContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPop`.
     * @param ctx the parse tree
     */
    exitTraversalPop?: (ctx: TraversalPopContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalOperator`.
     * @param ctx the parse tree
     */
    enterTraversalOperator?: (ctx: TraversalOperatorContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalOperator`.
     * @param ctx the parse tree
     */
    exitTraversalOperator?: (ctx: TraversalOperatorContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPick`.
     * @param ctx the parse tree
     */
    enterTraversalPick?: (ctx: TraversalPickContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPick`.
     * @param ctx the parse tree
     */
    exitTraversalPick?: (ctx: TraversalPickContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalDT`.
     * @param ctx the parse tree
     */
    enterTraversalDT?: (ctx: TraversalDTContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalDT`.
     * @param ctx the parse tree
     */
    exitTraversalDT?: (ctx: TraversalDTContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalGType`.
     * @param ctx the parse tree
     */
    enterTraversalGType?: (ctx: TraversalGTypeContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalGType`.
     * @param ctx the parse tree
     */
    exitTraversalGType?: (ctx: TraversalGTypeContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate?: (ctx: TraversalPredicateContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate?: (ctx: TraversalPredicateContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalTerminalMethod`.
     * @param ctx the parse tree
     */
    enterTraversalTerminalMethod?: (ctx: TraversalTerminalMethodContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalTerminalMethod`.
     * @param ctx the parse tree
     */
    exitTraversalTerminalMethod?: (ctx: TraversalTerminalMethodContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalSackMethod`.
     * @param ctx the parse tree
     */
    enterTraversalSackMethod?: (ctx: TraversalSackMethodContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalSackMethod`.
     * @param ctx the parse tree
     */
    exitTraversalSackMethod?: (ctx: TraversalSackMethodContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalComparator`.
     * @param ctx the parse tree
     */
    enterTraversalComparator?: (ctx: TraversalComparatorContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalComparator`.
     * @param ctx the parse tree
     */
    exitTraversalComparator?: (ctx: TraversalComparatorContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalFunction`.
     * @param ctx the parse tree
     */
    enterTraversalFunction?: (ctx: TraversalFunctionContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalFunction`.
     * @param ctx the parse tree
     */
    exitTraversalFunction?: (ctx: TraversalFunctionContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalBiFunction`.
     * @param ctx the parse tree
     */
    enterTraversalBiFunction?: (ctx: TraversalBiFunctionContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalBiFunction`.
     * @param ctx the parse tree
     */
    exitTraversalBiFunction?: (ctx: TraversalBiFunctionContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_eq`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_eq?: (ctx: TraversalPredicate_eqContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_eq`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_eq?: (ctx: TraversalPredicate_eqContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_neq`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_neq?: (ctx: TraversalPredicate_neqContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_neq`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_neq?: (ctx: TraversalPredicate_neqContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_typeOf`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_typeOf?: (ctx: TraversalPredicate_typeOfContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_typeOf`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_typeOf?: (ctx: TraversalPredicate_typeOfContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_lt`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_lt?: (ctx: TraversalPredicate_ltContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_lt`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_lt?: (ctx: TraversalPredicate_ltContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_lte`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_lte?: (ctx: TraversalPredicate_lteContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_lte`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_lte?: (ctx: TraversalPredicate_lteContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_gt`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_gt?: (ctx: TraversalPredicate_gtContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_gt`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_gt?: (ctx: TraversalPredicate_gtContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_gte`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_gte?: (ctx: TraversalPredicate_gteContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_gte`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_gte?: (ctx: TraversalPredicate_gteContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_inside`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_inside?: (ctx: TraversalPredicate_insideContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_inside`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_inside?: (ctx: TraversalPredicate_insideContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_outside`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_outside?: (ctx: TraversalPredicate_outsideContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_outside`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_outside?: (ctx: TraversalPredicate_outsideContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_between`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_between?: (ctx: TraversalPredicate_betweenContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_between`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_between?: (ctx: TraversalPredicate_betweenContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_within`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_within?: (ctx: TraversalPredicate_withinContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_within`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_within?: (ctx: TraversalPredicate_withinContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_without`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_without?: (ctx: TraversalPredicate_withoutContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_without`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_without?: (ctx: TraversalPredicate_withoutContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_not`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_not?: (ctx: TraversalPredicate_notContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_not`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_not?: (ctx: TraversalPredicate_notContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_containing`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_containing?: (ctx: TraversalPredicate_containingContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_containing`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_containing?: (ctx: TraversalPredicate_containingContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_notContaining`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_notContaining?: (ctx: TraversalPredicate_notContainingContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_notContaining`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_notContaining?: (ctx: TraversalPredicate_notContainingContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_startingWith`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_startingWith?: (ctx: TraversalPredicate_startingWithContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_startingWith`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_startingWith?: (ctx: TraversalPredicate_startingWithContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_notStartingWith`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_notStartingWith?: (ctx: TraversalPredicate_notStartingWithContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_notStartingWith`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_notStartingWith?: (ctx: TraversalPredicate_notStartingWithContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_endingWith`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_endingWith?: (ctx: TraversalPredicate_endingWithContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_endingWith`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_endingWith?: (ctx: TraversalPredicate_endingWithContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_notEndingWith`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_notEndingWith?: (ctx: TraversalPredicate_notEndingWithContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_notEndingWith`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_notEndingWith?: (ctx: TraversalPredicate_notEndingWithContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_regex`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_regex?: (ctx: TraversalPredicate_regexContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_regex`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_regex?: (ctx: TraversalPredicate_regexContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalPredicate_notRegex`.
     * @param ctx the parse tree
     */
    enterTraversalPredicate_notRegex?: (ctx: TraversalPredicate_notRegexContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalPredicate_notRegex`.
     * @param ctx the parse tree
     */
    exitTraversalPredicate_notRegex?: (ctx: TraversalPredicate_notRegexContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalTerminalMethod_explain`.
     * @param ctx the parse tree
     */
    enterTraversalTerminalMethod_explain?: (ctx: TraversalTerminalMethod_explainContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalTerminalMethod_explain`.
     * @param ctx the parse tree
     */
    exitTraversalTerminalMethod_explain?: (ctx: TraversalTerminalMethod_explainContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalTerminalMethod_hasNext`.
     * @param ctx the parse tree
     */
    enterTraversalTerminalMethod_hasNext?: (ctx: TraversalTerminalMethod_hasNextContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalTerminalMethod_hasNext`.
     * @param ctx the parse tree
     */
    exitTraversalTerminalMethod_hasNext?: (ctx: TraversalTerminalMethod_hasNextContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalTerminalMethod_iterate`.
     * @param ctx the parse tree
     */
    enterTraversalTerminalMethod_iterate?: (ctx: TraversalTerminalMethod_iterateContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalTerminalMethod_iterate`.
     * @param ctx the parse tree
     */
    exitTraversalTerminalMethod_iterate?: (ctx: TraversalTerminalMethod_iterateContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalTerminalMethod_tryNext`.
     * @param ctx the parse tree
     */
    enterTraversalTerminalMethod_tryNext?: (ctx: TraversalTerminalMethod_tryNextContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalTerminalMethod_tryNext`.
     * @param ctx the parse tree
     */
    exitTraversalTerminalMethod_tryNext?: (ctx: TraversalTerminalMethod_tryNextContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalTerminalMethod_next`.
     * @param ctx the parse tree
     */
    enterTraversalTerminalMethod_next?: (ctx: TraversalTerminalMethod_nextContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalTerminalMethod_next`.
     * @param ctx the parse tree
     */
    exitTraversalTerminalMethod_next?: (ctx: TraversalTerminalMethod_nextContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalTerminalMethod_toList`.
     * @param ctx the parse tree
     */
    enterTraversalTerminalMethod_toList?: (ctx: TraversalTerminalMethod_toListContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalTerminalMethod_toList`.
     * @param ctx the parse tree
     */
    exitTraversalTerminalMethod_toList?: (ctx: TraversalTerminalMethod_toListContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalTerminalMethod_toSet`.
     * @param ctx the parse tree
     */
    enterTraversalTerminalMethod_toSet?: (ctx: TraversalTerminalMethod_toSetContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalTerminalMethod_toSet`.
     * @param ctx the parse tree
     */
    exitTraversalTerminalMethod_toSet?: (ctx: TraversalTerminalMethod_toSetContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalTerminalMethod_toBulkSet`.
     * @param ctx the parse tree
     */
    enterTraversalTerminalMethod_toBulkSet?: (ctx: TraversalTerminalMethod_toBulkSetContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalTerminalMethod_toBulkSet`.
     * @param ctx the parse tree
     */
    exitTraversalTerminalMethod_toBulkSet?: (ctx: TraversalTerminalMethod_toBulkSetContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.withOptionKeys`.
     * @param ctx the parse tree
     */
    enterWithOptionKeys?: (ctx: WithOptionKeysContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.withOptionKeys`.
     * @param ctx the parse tree
     */
    exitWithOptionKeys?: (ctx: WithOptionKeysContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.connectedComponentConstants`.
     * @param ctx the parse tree
     */
    enterConnectedComponentConstants?: (ctx: ConnectedComponentConstantsContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.connectedComponentConstants`.
     * @param ctx the parse tree
     */
    exitConnectedComponentConstants?: (ctx: ConnectedComponentConstantsContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.pageRankConstants`.
     * @param ctx the parse tree
     */
    enterPageRankConstants?: (ctx: PageRankConstantsContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.pageRankConstants`.
     * @param ctx the parse tree
     */
    exitPageRankConstants?: (ctx: PageRankConstantsContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.peerPressureConstants`.
     * @param ctx the parse tree
     */
    enterPeerPressureConstants?: (ctx: PeerPressureConstantsContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.peerPressureConstants`.
     * @param ctx the parse tree
     */
    exitPeerPressureConstants?: (ctx: PeerPressureConstantsContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.shortestPathConstants`.
     * @param ctx the parse tree
     */
    enterShortestPathConstants?: (ctx: ShortestPathConstantsContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.shortestPathConstants`.
     * @param ctx the parse tree
     */
    exitShortestPathConstants?: (ctx: ShortestPathConstantsContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.withOptionsValues`.
     * @param ctx the parse tree
     */
    enterWithOptionsValues?: (ctx: WithOptionsValuesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.withOptionsValues`.
     * @param ctx the parse tree
     */
    exitWithOptionsValues?: (ctx: WithOptionsValuesContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.ioOptionsKeys`.
     * @param ctx the parse tree
     */
    enterIoOptionsKeys?: (ctx: IoOptionsKeysContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.ioOptionsKeys`.
     * @param ctx the parse tree
     */
    exitIoOptionsKeys?: (ctx: IoOptionsKeysContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.ioOptionsValues`.
     * @param ctx the parse tree
     */
    enterIoOptionsValues?: (ctx: IoOptionsValuesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.ioOptionsValues`.
     * @param ctx the parse tree
     */
    exitIoOptionsValues?: (ctx: IoOptionsValuesContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.connectedComponentConstants_component`.
     * @param ctx the parse tree
     */
    enterConnectedComponentConstants_component?: (ctx: ConnectedComponentConstants_componentContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.connectedComponentConstants_component`.
     * @param ctx the parse tree
     */
    exitConnectedComponentConstants_component?: (ctx: ConnectedComponentConstants_componentContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.connectedComponentConstants_edges`.
     * @param ctx the parse tree
     */
    enterConnectedComponentConstants_edges?: (ctx: ConnectedComponentConstants_edgesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.connectedComponentConstants_edges`.
     * @param ctx the parse tree
     */
    exitConnectedComponentConstants_edges?: (ctx: ConnectedComponentConstants_edgesContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.connectedComponentConstants_propertyName`.
     * @param ctx the parse tree
     */
    enterConnectedComponentConstants_propertyName?: (ctx: ConnectedComponentConstants_propertyNameContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.connectedComponentConstants_propertyName`.
     * @param ctx the parse tree
     */
    exitConnectedComponentConstants_propertyName?: (ctx: ConnectedComponentConstants_propertyNameContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.pageRankConstants_edges`.
     * @param ctx the parse tree
     */
    enterPageRankConstants_edges?: (ctx: PageRankConstants_edgesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.pageRankConstants_edges`.
     * @param ctx the parse tree
     */
    exitPageRankConstants_edges?: (ctx: PageRankConstants_edgesContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.pageRankConstants_times`.
     * @param ctx the parse tree
     */
    enterPageRankConstants_times?: (ctx: PageRankConstants_timesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.pageRankConstants_times`.
     * @param ctx the parse tree
     */
    exitPageRankConstants_times?: (ctx: PageRankConstants_timesContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.pageRankConstants_propertyName`.
     * @param ctx the parse tree
     */
    enterPageRankConstants_propertyName?: (ctx: PageRankConstants_propertyNameContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.pageRankConstants_propertyName`.
     * @param ctx the parse tree
     */
    exitPageRankConstants_propertyName?: (ctx: PageRankConstants_propertyNameContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.peerPressureConstants_edges`.
     * @param ctx the parse tree
     */
    enterPeerPressureConstants_edges?: (ctx: PeerPressureConstants_edgesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.peerPressureConstants_edges`.
     * @param ctx the parse tree
     */
    exitPeerPressureConstants_edges?: (ctx: PeerPressureConstants_edgesContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.peerPressureConstants_times`.
     * @param ctx the parse tree
     */
    enterPeerPressureConstants_times?: (ctx: PeerPressureConstants_timesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.peerPressureConstants_times`.
     * @param ctx the parse tree
     */
    exitPeerPressureConstants_times?: (ctx: PeerPressureConstants_timesContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.peerPressureConstants_propertyName`.
     * @param ctx the parse tree
     */
    enterPeerPressureConstants_propertyName?: (ctx: PeerPressureConstants_propertyNameContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.peerPressureConstants_propertyName`.
     * @param ctx the parse tree
     */
    exitPeerPressureConstants_propertyName?: (ctx: PeerPressureConstants_propertyNameContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.shortestPathConstants_target`.
     * @param ctx the parse tree
     */
    enterShortestPathConstants_target?: (ctx: ShortestPathConstants_targetContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.shortestPathConstants_target`.
     * @param ctx the parse tree
     */
    exitShortestPathConstants_target?: (ctx: ShortestPathConstants_targetContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.shortestPathConstants_edges`.
     * @param ctx the parse tree
     */
    enterShortestPathConstants_edges?: (ctx: ShortestPathConstants_edgesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.shortestPathConstants_edges`.
     * @param ctx the parse tree
     */
    exitShortestPathConstants_edges?: (ctx: ShortestPathConstants_edgesContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.shortestPathConstants_distance`.
     * @param ctx the parse tree
     */
    enterShortestPathConstants_distance?: (ctx: ShortestPathConstants_distanceContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.shortestPathConstants_distance`.
     * @param ctx the parse tree
     */
    exitShortestPathConstants_distance?: (ctx: ShortestPathConstants_distanceContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.shortestPathConstants_maxDistance`.
     * @param ctx the parse tree
     */
    enterShortestPathConstants_maxDistance?: (ctx: ShortestPathConstants_maxDistanceContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.shortestPathConstants_maxDistance`.
     * @param ctx the parse tree
     */
    exitShortestPathConstants_maxDistance?: (ctx: ShortestPathConstants_maxDistanceContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.shortestPathConstants_includeEdges`.
     * @param ctx the parse tree
     */
    enterShortestPathConstants_includeEdges?: (ctx: ShortestPathConstants_includeEdgesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.shortestPathConstants_includeEdges`.
     * @param ctx the parse tree
     */
    exitShortestPathConstants_includeEdges?: (ctx: ShortestPathConstants_includeEdgesContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.withOptionsConstants_tokens`.
     * @param ctx the parse tree
     */
    enterWithOptionsConstants_tokens?: (ctx: WithOptionsConstants_tokensContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.withOptionsConstants_tokens`.
     * @param ctx the parse tree
     */
    exitWithOptionsConstants_tokens?: (ctx: WithOptionsConstants_tokensContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.withOptionsConstants_none`.
     * @param ctx the parse tree
     */
    enterWithOptionsConstants_none?: (ctx: WithOptionsConstants_noneContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.withOptionsConstants_none`.
     * @param ctx the parse tree
     */
    exitWithOptionsConstants_none?: (ctx: WithOptionsConstants_noneContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.withOptionsConstants_ids`.
     * @param ctx the parse tree
     */
    enterWithOptionsConstants_ids?: (ctx: WithOptionsConstants_idsContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.withOptionsConstants_ids`.
     * @param ctx the parse tree
     */
    exitWithOptionsConstants_ids?: (ctx: WithOptionsConstants_idsContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.withOptionsConstants_labels`.
     * @param ctx the parse tree
     */
    enterWithOptionsConstants_labels?: (ctx: WithOptionsConstants_labelsContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.withOptionsConstants_labels`.
     * @param ctx the parse tree
     */
    exitWithOptionsConstants_labels?: (ctx: WithOptionsConstants_labelsContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.withOptionsConstants_keys`.
     * @param ctx the parse tree
     */
    enterWithOptionsConstants_keys?: (ctx: WithOptionsConstants_keysContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.withOptionsConstants_keys`.
     * @param ctx the parse tree
     */
    exitWithOptionsConstants_keys?: (ctx: WithOptionsConstants_keysContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.withOptionsConstants_values`.
     * @param ctx the parse tree
     */
    enterWithOptionsConstants_values?: (ctx: WithOptionsConstants_valuesContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.withOptionsConstants_values`.
     * @param ctx the parse tree
     */
    exitWithOptionsConstants_values?: (ctx: WithOptionsConstants_valuesContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.withOptionsConstants_all`.
     * @param ctx the parse tree
     */
    enterWithOptionsConstants_all?: (ctx: WithOptionsConstants_allContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.withOptionsConstants_all`.
     * @param ctx the parse tree
     */
    exitWithOptionsConstants_all?: (ctx: WithOptionsConstants_allContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.withOptionsConstants_indexer`.
     * @param ctx the parse tree
     */
    enterWithOptionsConstants_indexer?: (ctx: WithOptionsConstants_indexerContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.withOptionsConstants_indexer`.
     * @param ctx the parse tree
     */
    exitWithOptionsConstants_indexer?: (ctx: WithOptionsConstants_indexerContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.withOptionsConstants_list`.
     * @param ctx the parse tree
     */
    enterWithOptionsConstants_list?: (ctx: WithOptionsConstants_listContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.withOptionsConstants_list`.
     * @param ctx the parse tree
     */
    exitWithOptionsConstants_list?: (ctx: WithOptionsConstants_listContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.withOptionsConstants_map`.
     * @param ctx the parse tree
     */
    enterWithOptionsConstants_map?: (ctx: WithOptionsConstants_mapContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.withOptionsConstants_map`.
     * @param ctx the parse tree
     */
    exitWithOptionsConstants_map?: (ctx: WithOptionsConstants_mapContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.ioOptionsConstants_reader`.
     * @param ctx the parse tree
     */
    enterIoOptionsConstants_reader?: (ctx: IoOptionsConstants_readerContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.ioOptionsConstants_reader`.
     * @param ctx the parse tree
     */
    exitIoOptionsConstants_reader?: (ctx: IoOptionsConstants_readerContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.ioOptionsConstants_writer`.
     * @param ctx the parse tree
     */
    enterIoOptionsConstants_writer?: (ctx: IoOptionsConstants_writerContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.ioOptionsConstants_writer`.
     * @param ctx the parse tree
     */
    exitIoOptionsConstants_writer?: (ctx: IoOptionsConstants_writerContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.ioOptionsConstants_gryo`.
     * @param ctx the parse tree
     */
    enterIoOptionsConstants_gryo?: (ctx: IoOptionsConstants_gryoContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.ioOptionsConstants_gryo`.
     * @param ctx the parse tree
     */
    exitIoOptionsConstants_gryo?: (ctx: IoOptionsConstants_gryoContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.ioOptionsConstants_graphson`.
     * @param ctx the parse tree
     */
    enterIoOptionsConstants_graphson?: (ctx: IoOptionsConstants_graphsonContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.ioOptionsConstants_graphson`.
     * @param ctx the parse tree
     */
    exitIoOptionsConstants_graphson?: (ctx: IoOptionsConstants_graphsonContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.ioOptionsConstants_graphml`.
     * @param ctx the parse tree
     */
    enterIoOptionsConstants_graphml?: (ctx: IoOptionsConstants_graphmlContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.ioOptionsConstants_graphml`.
     * @param ctx the parse tree
     */
    exitIoOptionsConstants_graphml?: (ctx: IoOptionsConstants_graphmlContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.connectedComponentStringConstant`.
     * @param ctx the parse tree
     */
    enterConnectedComponentStringConstant?: (ctx: ConnectedComponentStringConstantContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.connectedComponentStringConstant`.
     * @param ctx the parse tree
     */
    exitConnectedComponentStringConstant?: (ctx: ConnectedComponentStringConstantContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.pageRankStringConstant`.
     * @param ctx the parse tree
     */
    enterPageRankStringConstant?: (ctx: PageRankStringConstantContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.pageRankStringConstant`.
     * @param ctx the parse tree
     */
    exitPageRankStringConstant?: (ctx: PageRankStringConstantContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.peerPressureStringConstant`.
     * @param ctx the parse tree
     */
    enterPeerPressureStringConstant?: (ctx: PeerPressureStringConstantContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.peerPressureStringConstant`.
     * @param ctx the parse tree
     */
    exitPeerPressureStringConstant?: (ctx: PeerPressureStringConstantContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.shortestPathStringConstant`.
     * @param ctx the parse tree
     */
    enterShortestPathStringConstant?: (ctx: ShortestPathStringConstantContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.shortestPathStringConstant`.
     * @param ctx the parse tree
     */
    exitShortestPathStringConstant?: (ctx: ShortestPathStringConstantContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.withOptionsStringConstant`.
     * @param ctx the parse tree
     */
    enterWithOptionsStringConstant?: (ctx: WithOptionsStringConstantContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.withOptionsStringConstant`.
     * @param ctx the parse tree
     */
    exitWithOptionsStringConstant?: (ctx: WithOptionsStringConstantContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.ioOptionsStringConstant`.
     * @param ctx the parse tree
     */
    enterIoOptionsStringConstant?: (ctx: IoOptionsStringConstantContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.ioOptionsStringConstant`.
     * @param ctx the parse tree
     */
    exitIoOptionsStringConstant?: (ctx: IoOptionsStringConstantContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.booleanArgument`.
     * @param ctx the parse tree
     */
    enterBooleanArgument?: (ctx: BooleanArgumentContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.booleanArgument`.
     * @param ctx the parse tree
     */
    exitBooleanArgument?: (ctx: BooleanArgumentContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.integerArgument`.
     * @param ctx the parse tree
     */
    enterIntegerArgument?: (ctx: IntegerArgumentContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.integerArgument`.
     * @param ctx the parse tree
     */
    exitIntegerArgument?: (ctx: IntegerArgumentContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.stringArgument`.
     * @param ctx the parse tree
     */
    enterStringArgument?: (ctx: StringArgumentContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.stringArgument`.
     * @param ctx the parse tree
     */
    exitStringArgument?: (ctx: StringArgumentContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.stringNullableArgument`.
     * @param ctx the parse tree
     */
    enterStringNullableArgument?: (ctx: StringNullableArgumentContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.stringNullableArgument`.
     * @param ctx the parse tree
     */
    exitStringNullableArgument?: (ctx: StringNullableArgumentContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.stringNullableArgumentVarargs`.
     * @param ctx the parse tree
     */
    enterStringNullableArgumentVarargs?: (ctx: StringNullableArgumentVarargsContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.stringNullableArgumentVarargs`.
     * @param ctx the parse tree
     */
    exitStringNullableArgumentVarargs?: (ctx: StringNullableArgumentVarargsContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.dateArgument`.
     * @param ctx the parse tree
     */
    enterDateArgument?: (ctx: DateArgumentContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.dateArgument`.
     * @param ctx the parse tree
     */
    exitDateArgument?: (ctx: DateArgumentContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.genericArgument`.
     * @param ctx the parse tree
     */
    enterGenericArgument?: (ctx: GenericArgumentContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.genericArgument`.
     * @param ctx the parse tree
     */
    exitGenericArgument?: (ctx: GenericArgumentContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.genericArgumentVarargs`.
     * @param ctx the parse tree
     */
    enterGenericArgumentVarargs?: (ctx: GenericArgumentVarargsContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.genericArgumentVarargs`.
     * @param ctx the parse tree
     */
    exitGenericArgumentVarargs?: (ctx: GenericArgumentVarargsContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.genericMapArgument`.
     * @param ctx the parse tree
     */
    enterGenericMapArgument?: (ctx: GenericMapArgumentContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.genericMapArgument`.
     * @param ctx the parse tree
     */
    exitGenericMapArgument?: (ctx: GenericMapArgumentContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.genericMapNullableArgument`.
     * @param ctx the parse tree
     */
    enterGenericMapNullableArgument?: (ctx: GenericMapNullableArgumentContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.genericMapNullableArgument`.
     * @param ctx the parse tree
     */
    exitGenericMapNullableArgument?: (ctx: GenericMapNullableArgumentContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.nullableGenericLiteralMap`.
     * @param ctx the parse tree
     */
    enterNullableGenericLiteralMap?: (ctx: NullableGenericLiteralMapContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.nullableGenericLiteralMap`.
     * @param ctx the parse tree
     */
    exitNullableGenericLiteralMap?: (ctx: NullableGenericLiteralMapContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalStrategyVarargs`.
     * @param ctx the parse tree
     */
    enterTraversalStrategyVarargs?: (ctx: TraversalStrategyVarargsContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalStrategyVarargs`.
     * @param ctx the parse tree
     */
    exitTraversalStrategyVarargs?: (ctx: TraversalStrategyVarargsContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.traversalStrategyExpr`.
     * @param ctx the parse tree
     */
    enterTraversalStrategyExpr?: (ctx: TraversalStrategyExprContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.traversalStrategyExpr`.
     * @param ctx the parse tree
     */
    exitTraversalStrategyExpr?: (ctx: TraversalStrategyExprContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.classTypeList`.
     * @param ctx the parse tree
     */
    enterClassTypeList?: (ctx: ClassTypeListContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.classTypeList`.
     * @param ctx the parse tree
     */
    exitClassTypeList?: (ctx: ClassTypeListContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.classTypeExpr`.
     * @param ctx the parse tree
     */
    enterClassTypeExpr?: (ctx: ClassTypeExprContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.classTypeExpr`.
     * @param ctx the parse tree
     */
    exitClassTypeExpr?: (ctx: ClassTypeExprContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.nestedTraversalList`.
     * @param ctx the parse tree
     */
    enterNestedTraversalList?: (ctx: NestedTraversalListContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.nestedTraversalList`.
     * @param ctx the parse tree
     */
    exitNestedTraversalList?: (ctx: NestedTraversalListContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.nestedTraversalExpr`.
     * @param ctx the parse tree
     */
    enterNestedTraversalExpr?: (ctx: NestedTraversalExprContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.nestedTraversalExpr`.
     * @param ctx the parse tree
     */
    exitNestedTraversalExpr?: (ctx: NestedTraversalExprContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.genericCollectionLiteral`.
     * @param ctx the parse tree
     */
    enterGenericCollectionLiteral?: (ctx: GenericCollectionLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.genericCollectionLiteral`.
     * @param ctx the parse tree
     */
    exitGenericCollectionLiteral?: (ctx: GenericCollectionLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.genericLiteralVarargs`.
     * @param ctx the parse tree
     */
    enterGenericLiteralVarargs?: (ctx: GenericLiteralVarargsContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.genericLiteralVarargs`.
     * @param ctx the parse tree
     */
    exitGenericLiteralVarargs?: (ctx: GenericLiteralVarargsContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.genericLiteralExpr`.
     * @param ctx the parse tree
     */
    enterGenericLiteralExpr?: (ctx: GenericLiteralExprContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.genericLiteralExpr`.
     * @param ctx the parse tree
     */
    exitGenericLiteralExpr?: (ctx: GenericLiteralExprContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.genericMapNullableLiteral`.
     * @param ctx the parse tree
     */
    enterGenericMapNullableLiteral?: (ctx: GenericMapNullableLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.genericMapNullableLiteral`.
     * @param ctx the parse tree
     */
    exitGenericMapNullableLiteral?: (ctx: GenericMapNullableLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.genericRangeLiteral`.
     * @param ctx the parse tree
     */
    enterGenericRangeLiteral?: (ctx: GenericRangeLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.genericRangeLiteral`.
     * @param ctx the parse tree
     */
    exitGenericRangeLiteral?: (ctx: GenericRangeLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.genericSetLiteral`.
     * @param ctx the parse tree
     */
    enterGenericSetLiteral?: (ctx: GenericSetLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.genericSetLiteral`.
     * @param ctx the parse tree
     */
    exitGenericSetLiteral?: (ctx: GenericSetLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.stringNullableLiteralVarargs`.
     * @param ctx the parse tree
     */
    enterStringNullableLiteralVarargs?: (ctx: StringNullableLiteralVarargsContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.stringNullableLiteralVarargs`.
     * @param ctx the parse tree
     */
    exitStringNullableLiteralVarargs?: (ctx: StringNullableLiteralVarargsContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.genericLiteral`.
     * @param ctx the parse tree
     */
    enterGenericLiteral?: (ctx: GenericLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.genericLiteral`.
     * @param ctx the parse tree
     */
    exitGenericLiteral?: (ctx: GenericLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.genericMapLiteral`.
     * @param ctx the parse tree
     */
    enterGenericMapLiteral?: (ctx: GenericMapLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.genericMapLiteral`.
     * @param ctx the parse tree
     */
    exitGenericMapLiteral?: (ctx: GenericMapLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.mapKey`.
     * @param ctx the parse tree
     */
    enterMapKey?: (ctx: MapKeyContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.mapKey`.
     * @param ctx the parse tree
     */
    exitMapKey?: (ctx: MapKeyContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.mapEntry`.
     * @param ctx the parse tree
     */
    enterMapEntry?: (ctx: MapEntryContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.mapEntry`.
     * @param ctx the parse tree
     */
    exitMapEntry?: (ctx: MapEntryContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.stringLiteral`.
     * @param ctx the parse tree
     */
    enterStringLiteral?: (ctx: StringLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.stringLiteral`.
     * @param ctx the parse tree
     */
    exitStringLiteral?: (ctx: StringLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.stringNullableLiteral`.
     * @param ctx the parse tree
     */
    enterStringNullableLiteral?: (ctx: StringNullableLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.stringNullableLiteral`.
     * @param ctx the parse tree
     */
    exitStringNullableLiteral?: (ctx: StringNullableLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.integerLiteral`.
     * @param ctx the parse tree
     */
    enterIntegerLiteral?: (ctx: IntegerLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.integerLiteral`.
     * @param ctx the parse tree
     */
    exitIntegerLiteral?: (ctx: IntegerLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.floatLiteral`.
     * @param ctx the parse tree
     */
    enterFloatLiteral?: (ctx: FloatLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.floatLiteral`.
     * @param ctx the parse tree
     */
    exitFloatLiteral?: (ctx: FloatLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.numericLiteral`.
     * @param ctx the parse tree
     */
    enterNumericLiteral?: (ctx: NumericLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.numericLiteral`.
     * @param ctx the parse tree
     */
    exitNumericLiteral?: (ctx: NumericLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.booleanLiteral`.
     * @param ctx the parse tree
     */
    enterBooleanLiteral?: (ctx: BooleanLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.booleanLiteral`.
     * @param ctx the parse tree
     */
    exitBooleanLiteral?: (ctx: BooleanLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.dateLiteral`.
     * @param ctx the parse tree
     */
    enterDateLiteral?: (ctx: DateLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.dateLiteral`.
     * @param ctx the parse tree
     */
    exitDateLiteral?: (ctx: DateLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.nullLiteral`.
     * @param ctx the parse tree
     */
    enterNullLiteral?: (ctx: NullLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.nullLiteral`.
     * @param ctx the parse tree
     */
    exitNullLiteral?: (ctx: NullLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.nanLiteral`.
     * @param ctx the parse tree
     */
    enterNanLiteral?: (ctx: NanLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.nanLiteral`.
     * @param ctx the parse tree
     */
    exitNanLiteral?: (ctx: NanLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.infLiteral`.
     * @param ctx the parse tree
     */
    enterInfLiteral?: (ctx: InfLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.infLiteral`.
     * @param ctx the parse tree
     */
    exitInfLiteral?: (ctx: InfLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.uuidLiteral`.
     * @param ctx the parse tree
     */
    enterUuidLiteral?: (ctx: UuidLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.uuidLiteral`.
     * @param ctx the parse tree
     */
    exitUuidLiteral?: (ctx: UuidLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.characterLiteral`.
     * @param ctx the parse tree
     */
    enterCharacterLiteral?: (ctx: CharacterLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.characterLiteral`.
     * @param ctx the parse tree
     */
    exitCharacterLiteral?: (ctx: CharacterLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.durationLiteral`.
     * @param ctx the parse tree
     */
    enterDurationLiteral?: (ctx: DurationLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.durationLiteral`.
     * @param ctx the parse tree
     */
    exitDurationLiteral?: (ctx: DurationLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.binaryLiteral`.
     * @param ctx the parse tree
     */
    enterBinaryLiteral?: (ctx: BinaryLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.binaryLiteral`.
     * @param ctx the parse tree
     */
    exitBinaryLiteral?: (ctx: BinaryLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.pdtLiteral`.
     * @param ctx the parse tree
     */
    enterPdtLiteral?: (ctx: PdtLiteralContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.pdtLiteral`.
     * @param ctx the parse tree
     */
    exitPdtLiteral?: (ctx: PdtLiteralContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.nakedKey`.
     * @param ctx the parse tree
     */
    enterNakedKey?: (ctx: NakedKeyContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.nakedKey`.
     * @param ctx the parse tree
     */
    exitNakedKey?: (ctx: NakedKeyContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.classType`.
     * @param ctx the parse tree
     */
    enterClassType?: (ctx: ClassTypeContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.classType`.
     * @param ctx the parse tree
     */
    exitClassType?: (ctx: ClassTypeContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.variable`.
     * @param ctx the parse tree
     */
    enterVariable?: (ctx: VariableContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.variable`.
     * @param ctx the parse tree
     */
    exitVariable?: (ctx: VariableContext) => void;
    /**
     * Enter a parse tree produced by `GremlinParser.keyword`.
     * @param ctx the parse tree
     */
    enterKeyword?: (ctx: KeywordContext) => void;
    /**
     * Exit a parse tree produced by `GremlinParser.keyword`.
     * @param ctx the parse tree
     */
    exitKeyword?: (ctx: KeywordContext) => void;

    visitTerminal(node: TerminalNode): void {}
    visitErrorNode(node: ErrorNode): void {}
    enterEveryRule(node: ParserRuleContext): void {}
    exitEveryRule(node: ParserRuleContext): void {}
}

