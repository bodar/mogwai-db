
import { ErrorNode, ParseTreeListener, ParserRuleContext, TerminalNode } from "antlr4ng";


import { MatchClauseContext } from "./GQLParser.js";
import { GraphPatternContext } from "./GQLParser.js";
import { PathPatternContext } from "./GQLParser.js";
import { NodePatternContext } from "./GQLParser.js";
import { ElementPatternFillerContext } from "./GQLParser.js";
import { LabelSpecContext } from "./GQLParser.js";
import { PropertyFilterContext } from "./GQLParser.js";
import { PropertyPairContext } from "./GQLParser.js";
import { PropertyKeyContext } from "./GQLParser.js";
import { PropertyValueContext } from "./GQLParser.js";
import { LiteralContext } from "./GQLParser.js";
import { ParamRefContext } from "./GQLParser.js";
import { EdgePatternContext } from "./GQLParser.js";
import { DirectedEdgeContext } from "./GQLParser.js";
import { ReverseDirectedEdgeContext } from "./GQLParser.js";
import { UndirectedEdgeContext } from "./GQLParser.js";
import { ElementVariableContext } from "./GQLParser.js";
import { LabelNameContext } from "./GQLParser.js";


/**
 * This interface defines a complete listener for a parse tree produced by
 * `GQLParser`.
 */
export class GQLListener implements ParseTreeListener {
    /**
     * Enter a parse tree produced by `GQLParser.matchClause`.
     * @param ctx the parse tree
     */
    enterMatchClause?: (ctx: MatchClauseContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.matchClause`.
     * @param ctx the parse tree
     */
    exitMatchClause?: (ctx: MatchClauseContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.graphPattern`.
     * @param ctx the parse tree
     */
    enterGraphPattern?: (ctx: GraphPatternContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.graphPattern`.
     * @param ctx the parse tree
     */
    exitGraphPattern?: (ctx: GraphPatternContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.pathPattern`.
     * @param ctx the parse tree
     */
    enterPathPattern?: (ctx: PathPatternContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.pathPattern`.
     * @param ctx the parse tree
     */
    exitPathPattern?: (ctx: PathPatternContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.nodePattern`.
     * @param ctx the parse tree
     */
    enterNodePattern?: (ctx: NodePatternContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.nodePattern`.
     * @param ctx the parse tree
     */
    exitNodePattern?: (ctx: NodePatternContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.elementPatternFiller`.
     * @param ctx the parse tree
     */
    enterElementPatternFiller?: (ctx: ElementPatternFillerContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.elementPatternFiller`.
     * @param ctx the parse tree
     */
    exitElementPatternFiller?: (ctx: ElementPatternFillerContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.labelSpec`.
     * @param ctx the parse tree
     */
    enterLabelSpec?: (ctx: LabelSpecContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.labelSpec`.
     * @param ctx the parse tree
     */
    exitLabelSpec?: (ctx: LabelSpecContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.propertyFilter`.
     * @param ctx the parse tree
     */
    enterPropertyFilter?: (ctx: PropertyFilterContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.propertyFilter`.
     * @param ctx the parse tree
     */
    exitPropertyFilter?: (ctx: PropertyFilterContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.propertyPair`.
     * @param ctx the parse tree
     */
    enterPropertyPair?: (ctx: PropertyPairContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.propertyPair`.
     * @param ctx the parse tree
     */
    exitPropertyPair?: (ctx: PropertyPairContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.propertyKey`.
     * @param ctx the parse tree
     */
    enterPropertyKey?: (ctx: PropertyKeyContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.propertyKey`.
     * @param ctx the parse tree
     */
    exitPropertyKey?: (ctx: PropertyKeyContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.propertyValue`.
     * @param ctx the parse tree
     */
    enterPropertyValue?: (ctx: PropertyValueContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.propertyValue`.
     * @param ctx the parse tree
     */
    exitPropertyValue?: (ctx: PropertyValueContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.literal`.
     * @param ctx the parse tree
     */
    enterLiteral?: (ctx: LiteralContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.literal`.
     * @param ctx the parse tree
     */
    exitLiteral?: (ctx: LiteralContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.paramRef`.
     * @param ctx the parse tree
     */
    enterParamRef?: (ctx: ParamRefContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.paramRef`.
     * @param ctx the parse tree
     */
    exitParamRef?: (ctx: ParamRefContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.edgePattern`.
     * @param ctx the parse tree
     */
    enterEdgePattern?: (ctx: EdgePatternContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.edgePattern`.
     * @param ctx the parse tree
     */
    exitEdgePattern?: (ctx: EdgePatternContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.directedEdge`.
     * @param ctx the parse tree
     */
    enterDirectedEdge?: (ctx: DirectedEdgeContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.directedEdge`.
     * @param ctx the parse tree
     */
    exitDirectedEdge?: (ctx: DirectedEdgeContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.reverseDirectedEdge`.
     * @param ctx the parse tree
     */
    enterReverseDirectedEdge?: (ctx: ReverseDirectedEdgeContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.reverseDirectedEdge`.
     * @param ctx the parse tree
     */
    exitReverseDirectedEdge?: (ctx: ReverseDirectedEdgeContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.undirectedEdge`.
     * @param ctx the parse tree
     */
    enterUndirectedEdge?: (ctx: UndirectedEdgeContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.undirectedEdge`.
     * @param ctx the parse tree
     */
    exitUndirectedEdge?: (ctx: UndirectedEdgeContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.elementVariable`.
     * @param ctx the parse tree
     */
    enterElementVariable?: (ctx: ElementVariableContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.elementVariable`.
     * @param ctx the parse tree
     */
    exitElementVariable?: (ctx: ElementVariableContext) => void;
    /**
     * Enter a parse tree produced by `GQLParser.labelName`.
     * @param ctx the parse tree
     */
    enterLabelName?: (ctx: LabelNameContext) => void;
    /**
     * Exit a parse tree produced by `GQLParser.labelName`.
     * @param ctx the parse tree
     */
    exitLabelName?: (ctx: LabelNameContext) => void;

    visitTerminal(node: TerminalNode): void {}
    visitErrorNode(node: ErrorNode): void {}
    enterEveryRule(node: ParserRuleContext): void {}
    exitEveryRule(node: ParserRuleContext): void {}
}

