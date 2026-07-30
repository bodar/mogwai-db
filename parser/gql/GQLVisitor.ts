
import { AbstractParseTreeVisitor } from "antlr4ng";


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
 * This interface defines a complete generic visitor for a parse tree produced
 * by `GQLParser`.
 *
 * @param <Result> The return type of the visit operation. Use `void` for
 * operations with no return type.
 */
export class GQLVisitor<Result> extends AbstractParseTreeVisitor<Result> {
    /**
     * Visit a parse tree produced by `GQLParser.matchClause`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitMatchClause?: (ctx: MatchClauseContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.graphPattern`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitGraphPattern?: (ctx: GraphPatternContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.pathPattern`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPathPattern?: (ctx: PathPatternContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.nodePattern`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitNodePattern?: (ctx: NodePatternContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.elementPatternFiller`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitElementPatternFiller?: (ctx: ElementPatternFillerContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.labelSpec`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitLabelSpec?: (ctx: LabelSpecContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.propertyFilter`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPropertyFilter?: (ctx: PropertyFilterContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.propertyPair`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPropertyPair?: (ctx: PropertyPairContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.propertyKey`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPropertyKey?: (ctx: PropertyKeyContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.propertyValue`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitPropertyValue?: (ctx: PropertyValueContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.literal`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitLiteral?: (ctx: LiteralContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.paramRef`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitParamRef?: (ctx: ParamRefContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.edgePattern`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitEdgePattern?: (ctx: EdgePatternContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.directedEdge`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitDirectedEdge?: (ctx: DirectedEdgeContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.reverseDirectedEdge`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitReverseDirectedEdge?: (ctx: ReverseDirectedEdgeContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.undirectedEdge`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitUndirectedEdge?: (ctx: UndirectedEdgeContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.elementVariable`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitElementVariable?: (ctx: ElementVariableContext) => Result;
    /**
     * Visit a parse tree produced by `GQLParser.labelName`.
     * @param ctx the parse tree
     * @return the visitor result
     */
    visitLabelName?: (ctx: LabelNameContext) => Result;
}

