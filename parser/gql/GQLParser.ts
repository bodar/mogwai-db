
import * as antlr from "antlr4ng";
import { Token } from "antlr4ng";

import { GQLListener } from "./GQLListener.js";
import { GQLVisitor } from "./GQLVisitor.js";

// for running tests with parameters, TODO: discuss strategy for typed parameters in CI
// eslint-disable-next-line no-unused-vars
type int = number;


export class GQLParser extends antlr.Parser {
    public static readonly K_MATCH = 1;
    public static readonly K_TRUE = 2;
    public static readonly K_FALSE = 3;
    public static readonly K_NULL = 4;
    public static readonly K_NAN = 5;
    public static readonly K_INFINITY = 6;
    public static readonly ARROW = 7;
    public static readonly LARROW = 8;
    public static readonly LPAREN = 9;
    public static readonly RPAREN = 10;
    public static readonly LBRACKET = 11;
    public static readonly RBRACKET = 12;
    public static readonly LBRACE = 13;
    public static readonly RBRACE = 14;
    public static readonly DASH = 15;
    public static readonly COLON = 16;
    public static readonly COMMA = 17;
    public static readonly DOLLAR = 18;
    public static readonly SIGNED_INFINITY = 19;
    public static readonly STRING_LITERAL = 20;
    public static readonly FLOAT_LITERAL = 21;
    public static readonly INTEGER_LITERAL = 22;
    public static readonly IDENTIFIER = 23;
    public static readonly WS = 24;
    public static readonly RULE_matchClause = 0;
    public static readonly RULE_graphPattern = 1;
    public static readonly RULE_pathPattern = 2;
    public static readonly RULE_nodePattern = 3;
    public static readonly RULE_elementPatternFiller = 4;
    public static readonly RULE_labelSpec = 5;
    public static readonly RULE_propertyFilter = 6;
    public static readonly RULE_propertyPair = 7;
    public static readonly RULE_propertyKey = 8;
    public static readonly RULE_propertyValue = 9;
    public static readonly RULE_literal = 10;
    public static readonly RULE_paramRef = 11;
    public static readonly RULE_edgePattern = 12;
    public static readonly RULE_directedEdge = 13;
    public static readonly RULE_reverseDirectedEdge = 14;
    public static readonly RULE_undirectedEdge = 15;
    public static readonly RULE_elementVariable = 16;
    public static readonly RULE_labelName = 17;

    public static readonly literalNames = [
        null, null, null, null, "'null'", "'NaN'", "'Infinity'", "'->'", 
        "'<-'", "'('", "')'", "'['", "']'", "'{'", "'}'", "'-'", "':'", 
        "','", "'$'"
    ];

    public static readonly symbolicNames = [
        null, "K_MATCH", "K_TRUE", "K_FALSE", "K_NULL", "K_NAN", "K_INFINITY", 
        "ARROW", "LARROW", "LPAREN", "RPAREN", "LBRACKET", "RBRACKET", "LBRACE", 
        "RBRACE", "DASH", "COLON", "COMMA", "DOLLAR", "SIGNED_INFINITY", 
        "STRING_LITERAL", "FLOAT_LITERAL", "INTEGER_LITERAL", "IDENTIFIER", 
        "WS"
    ];
    public static readonly ruleNames = [
        "matchClause", "graphPattern", "pathPattern", "nodePattern", "elementPatternFiller", 
        "labelSpec", "propertyFilter", "propertyPair", "propertyKey", "propertyValue", 
        "literal", "paramRef", "edgePattern", "directedEdge", "reverseDirectedEdge", 
        "undirectedEdge", "elementVariable", "labelName",
    ];

    public get grammarFileName(): string { return "GQL.g4"; }
    public get literalNames(): (string | null)[] { return GQLParser.literalNames; }
    public get symbolicNames(): (string | null)[] { return GQLParser.symbolicNames; }
    public get ruleNames(): string[] { return GQLParser.ruleNames; }
    public get serializedATN(): number[] { return GQLParser._serializedATN; }

    protected createFailedPredicateException(predicate?: string, message?: string): antlr.FailedPredicateException {
        return new antlr.FailedPredicateException(this, predicate, message);
    }

    public constructor(input: antlr.TokenStream) {
        super(input);
        this.interpreter = new antlr.ParserATNSimulator(this, GQLParser._ATN, GQLParser.decisionsToDFA, new antlr.PredictionContextCache());
    }
    public matchClause(): MatchClauseContext {
        let localContext = new MatchClauseContext(this.context, this.state);
        this.enterRule(localContext, 0, GQLParser.RULE_matchClause);
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 36;
            this.match(GQLParser.K_MATCH);
            this.state = 37;
            this.graphPattern();
            this.state = 38;
            this.match(GQLParser.EOF);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public graphPattern(): GraphPatternContext {
        let localContext = new GraphPatternContext(this.context, this.state);
        this.enterRule(localContext, 2, GQLParser.RULE_graphPattern);
        let _la: number;
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 40;
            this.pathPattern();
            this.state = 45;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            while (_la === 17) {
                {
                {
                this.state = 41;
                this.match(GQLParser.COMMA);
                this.state = 42;
                this.pathPattern();
                }
                }
                this.state = 47;
                this.errorHandler.sync(this);
                _la = this.tokenStream.LA(1);
            }
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public pathPattern(): PathPatternContext {
        let localContext = new PathPatternContext(this.context, this.state);
        this.enterRule(localContext, 4, GQLParser.RULE_pathPattern);
        let _la: number;
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 48;
            this.nodePattern();
            this.state = 54;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            while (_la === 8 || _la === 15) {
                {
                {
                this.state = 49;
                this.edgePattern();
                this.state = 50;
                this.nodePattern();
                }
                }
                this.state = 56;
                this.errorHandler.sync(this);
                _la = this.tokenStream.LA(1);
            }
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public nodePattern(): NodePatternContext {
        let localContext = new NodePatternContext(this.context, this.state);
        this.enterRule(localContext, 6, GQLParser.RULE_nodePattern);
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 57;
            this.match(GQLParser.LPAREN);
            this.state = 58;
            this.elementPatternFiller();
            this.state = 59;
            this.match(GQLParser.RPAREN);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public elementPatternFiller(): ElementPatternFillerContext {
        let localContext = new ElementPatternFillerContext(this.context, this.state);
        this.enterRule(localContext, 8, GQLParser.RULE_elementPatternFiller);
        let _la: number;
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 62;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            if (_la === 23) {
                {
                this.state = 61;
                this.elementVariable();
                }
            }

            this.state = 65;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            if (_la === 16) {
                {
                this.state = 64;
                this.labelSpec();
                }
            }

            this.state = 68;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            if (_la === 13) {
                {
                this.state = 67;
                this.propertyFilter();
                }
            }

            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public labelSpec(): LabelSpecContext {
        let localContext = new LabelSpecContext(this.context, this.state);
        this.enterRule(localContext, 10, GQLParser.RULE_labelSpec);
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 70;
            this.match(GQLParser.COLON);
            this.state = 71;
            this.labelName();
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public propertyFilter(): PropertyFilterContext {
        let localContext = new PropertyFilterContext(this.context, this.state);
        this.enterRule(localContext, 12, GQLParser.RULE_propertyFilter);
        let _la: number;
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 73;
            this.match(GQLParser.LBRACE);
            this.state = 74;
            this.propertyPair();
            this.state = 79;
            this.errorHandler.sync(this);
            _la = this.tokenStream.LA(1);
            while (_la === 17) {
                {
                {
                this.state = 75;
                this.match(GQLParser.COMMA);
                this.state = 76;
                this.propertyPair();
                }
                }
                this.state = 81;
                this.errorHandler.sync(this);
                _la = this.tokenStream.LA(1);
            }
            this.state = 82;
            this.match(GQLParser.RBRACE);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public propertyPair(): PropertyPairContext {
        let localContext = new PropertyPairContext(this.context, this.state);
        this.enterRule(localContext, 14, GQLParser.RULE_propertyPair);
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 84;
            this.propertyKey();
            this.state = 85;
            this.match(GQLParser.COLON);
            this.state = 86;
            this.propertyValue();
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public propertyKey(): PropertyKeyContext {
        let localContext = new PropertyKeyContext(this.context, this.state);
        this.enterRule(localContext, 16, GQLParser.RULE_propertyKey);
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 88;
            this.match(GQLParser.IDENTIFIER);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public propertyValue(): PropertyValueContext {
        let localContext = new PropertyValueContext(this.context, this.state);
        this.enterRule(localContext, 18, GQLParser.RULE_propertyValue);
        try {
            this.state = 92;
            this.errorHandler.sync(this);
            switch (this.tokenStream.LA(1)) {
            case GQLParser.K_TRUE:
            case GQLParser.K_FALSE:
            case GQLParser.K_NULL:
            case GQLParser.K_NAN:
            case GQLParser.K_INFINITY:
            case GQLParser.SIGNED_INFINITY:
            case GQLParser.STRING_LITERAL:
            case GQLParser.FLOAT_LITERAL:
            case GQLParser.INTEGER_LITERAL:
                this.enterOuterAlt(localContext, 1);
                {
                this.state = 90;
                this.literal();
                }
                break;
            case GQLParser.DOLLAR:
                this.enterOuterAlt(localContext, 2);
                {
                this.state = 91;
                this.paramRef();
                }
                break;
            default:
                throw new antlr.NoViableAltException(this);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public literal(): LiteralContext {
        let localContext = new LiteralContext(this.context, this.state);
        this.enterRule(localContext, 20, GQLParser.RULE_literal);
        let _la: number;
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 94;
            _la = this.tokenStream.LA(1);
            if(!((((_la) & ~0x1F) === 0 && ((1 << _la) & 7864444) !== 0))) {
            this.errorHandler.recoverInline(this);
            }
            else {
                this.errorHandler.reportMatch(this);
                this.consume();
            }
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public paramRef(): ParamRefContext {
        let localContext = new ParamRefContext(this.context, this.state);
        this.enterRule(localContext, 22, GQLParser.RULE_paramRef);
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 96;
            this.match(GQLParser.DOLLAR);
            this.state = 97;
            this.match(GQLParser.IDENTIFIER);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public edgePattern(): EdgePatternContext {
        let localContext = new EdgePatternContext(this.context, this.state);
        this.enterRule(localContext, 24, GQLParser.RULE_edgePattern);
        try {
            this.state = 102;
            this.errorHandler.sync(this);
            switch (this.interpreter.adaptivePredict(this.tokenStream, 7, this.context) ) {
            case 1:
                this.enterOuterAlt(localContext, 1);
                {
                this.state = 99;
                this.directedEdge();
                }
                break;
            case 2:
                this.enterOuterAlt(localContext, 2);
                {
                this.state = 100;
                this.reverseDirectedEdge();
                }
                break;
            case 3:
                this.enterOuterAlt(localContext, 3);
                {
                this.state = 101;
                this.undirectedEdge();
                }
                break;
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public directedEdge(): DirectedEdgeContext {
        let localContext = new DirectedEdgeContext(this.context, this.state);
        this.enterRule(localContext, 26, GQLParser.RULE_directedEdge);
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 104;
            this.match(GQLParser.DASH);
            this.state = 105;
            this.match(GQLParser.LBRACKET);
            this.state = 106;
            this.elementPatternFiller();
            this.state = 107;
            this.match(GQLParser.RBRACKET);
            this.state = 108;
            this.match(GQLParser.ARROW);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public reverseDirectedEdge(): ReverseDirectedEdgeContext {
        let localContext = new ReverseDirectedEdgeContext(this.context, this.state);
        this.enterRule(localContext, 28, GQLParser.RULE_reverseDirectedEdge);
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 110;
            this.match(GQLParser.LARROW);
            this.state = 111;
            this.match(GQLParser.LBRACKET);
            this.state = 112;
            this.elementPatternFiller();
            this.state = 113;
            this.match(GQLParser.RBRACKET);
            this.state = 114;
            this.match(GQLParser.DASH);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public undirectedEdge(): UndirectedEdgeContext {
        let localContext = new UndirectedEdgeContext(this.context, this.state);
        this.enterRule(localContext, 30, GQLParser.RULE_undirectedEdge);
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 116;
            this.match(GQLParser.DASH);
            this.state = 117;
            this.match(GQLParser.LBRACKET);
            this.state = 118;
            this.elementPatternFiller();
            this.state = 119;
            this.match(GQLParser.RBRACKET);
            this.state = 120;
            this.match(GQLParser.DASH);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public elementVariable(): ElementVariableContext {
        let localContext = new ElementVariableContext(this.context, this.state);
        this.enterRule(localContext, 32, GQLParser.RULE_elementVariable);
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 122;
            this.match(GQLParser.IDENTIFIER);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }
    public labelName(): LabelNameContext {
        let localContext = new LabelNameContext(this.context, this.state);
        this.enterRule(localContext, 34, GQLParser.RULE_labelName);
        try {
            this.enterOuterAlt(localContext, 1);
            {
            this.state = 124;
            this.match(GQLParser.IDENTIFIER);
            }
        }
        catch (re) {
            if (re instanceof antlr.RecognitionException) {
                this.errorHandler.reportError(this, re);
                this.errorHandler.recover(this, re);
            } else {
                throw re;
            }
        }
        finally {
            this.exitRule();
        }
        return localContext;
    }

    public static readonly _serializedATN: number[] = [
        4,1,24,127,2,0,7,0,2,1,7,1,2,2,7,2,2,3,7,3,2,4,7,4,2,5,7,5,2,6,7,
        6,2,7,7,7,2,8,7,8,2,9,7,9,2,10,7,10,2,11,7,11,2,12,7,12,2,13,7,13,
        2,14,7,14,2,15,7,15,2,16,7,16,2,17,7,17,1,0,1,0,1,0,1,0,1,1,1,1,
        1,1,5,1,44,8,1,10,1,12,1,47,9,1,1,2,1,2,1,2,1,2,5,2,53,8,2,10,2,
        12,2,56,9,2,1,3,1,3,1,3,1,3,1,4,3,4,63,8,4,1,4,3,4,66,8,4,1,4,3,
        4,69,8,4,1,5,1,5,1,5,1,6,1,6,1,6,1,6,5,6,78,8,6,10,6,12,6,81,9,6,
        1,6,1,6,1,7,1,7,1,7,1,7,1,8,1,8,1,9,1,9,3,9,93,8,9,1,10,1,10,1,11,
        1,11,1,11,1,12,1,12,1,12,3,12,103,8,12,1,13,1,13,1,13,1,13,1,13,
        1,13,1,14,1,14,1,14,1,14,1,14,1,14,1,15,1,15,1,15,1,15,1,15,1,15,
        1,16,1,16,1,17,1,17,1,17,0,0,18,0,2,4,6,8,10,12,14,16,18,20,22,24,
        26,28,30,32,34,0,1,2,0,2,6,19,22,117,0,36,1,0,0,0,2,40,1,0,0,0,4,
        48,1,0,0,0,6,57,1,0,0,0,8,62,1,0,0,0,10,70,1,0,0,0,12,73,1,0,0,0,
        14,84,1,0,0,0,16,88,1,0,0,0,18,92,1,0,0,0,20,94,1,0,0,0,22,96,1,
        0,0,0,24,102,1,0,0,0,26,104,1,0,0,0,28,110,1,0,0,0,30,116,1,0,0,
        0,32,122,1,0,0,0,34,124,1,0,0,0,36,37,5,1,0,0,37,38,3,2,1,0,38,39,
        5,0,0,1,39,1,1,0,0,0,40,45,3,4,2,0,41,42,5,17,0,0,42,44,3,4,2,0,
        43,41,1,0,0,0,44,47,1,0,0,0,45,43,1,0,0,0,45,46,1,0,0,0,46,3,1,0,
        0,0,47,45,1,0,0,0,48,54,3,6,3,0,49,50,3,24,12,0,50,51,3,6,3,0,51,
        53,1,0,0,0,52,49,1,0,0,0,53,56,1,0,0,0,54,52,1,0,0,0,54,55,1,0,0,
        0,55,5,1,0,0,0,56,54,1,0,0,0,57,58,5,9,0,0,58,59,3,8,4,0,59,60,5,
        10,0,0,60,7,1,0,0,0,61,63,3,32,16,0,62,61,1,0,0,0,62,63,1,0,0,0,
        63,65,1,0,0,0,64,66,3,10,5,0,65,64,1,0,0,0,65,66,1,0,0,0,66,68,1,
        0,0,0,67,69,3,12,6,0,68,67,1,0,0,0,68,69,1,0,0,0,69,9,1,0,0,0,70,
        71,5,16,0,0,71,72,3,34,17,0,72,11,1,0,0,0,73,74,5,13,0,0,74,79,3,
        14,7,0,75,76,5,17,0,0,76,78,3,14,7,0,77,75,1,0,0,0,78,81,1,0,0,0,
        79,77,1,0,0,0,79,80,1,0,0,0,80,82,1,0,0,0,81,79,1,0,0,0,82,83,5,
        14,0,0,83,13,1,0,0,0,84,85,3,16,8,0,85,86,5,16,0,0,86,87,3,18,9,
        0,87,15,1,0,0,0,88,89,5,23,0,0,89,17,1,0,0,0,90,93,3,20,10,0,91,
        93,3,22,11,0,92,90,1,0,0,0,92,91,1,0,0,0,93,19,1,0,0,0,94,95,7,0,
        0,0,95,21,1,0,0,0,96,97,5,18,0,0,97,98,5,23,0,0,98,23,1,0,0,0,99,
        103,3,26,13,0,100,103,3,28,14,0,101,103,3,30,15,0,102,99,1,0,0,0,
        102,100,1,0,0,0,102,101,1,0,0,0,103,25,1,0,0,0,104,105,5,15,0,0,
        105,106,5,11,0,0,106,107,3,8,4,0,107,108,5,12,0,0,108,109,5,7,0,
        0,109,27,1,0,0,0,110,111,5,8,0,0,111,112,5,11,0,0,112,113,3,8,4,
        0,113,114,5,12,0,0,114,115,5,15,0,0,115,29,1,0,0,0,116,117,5,15,
        0,0,117,118,5,11,0,0,118,119,3,8,4,0,119,120,5,12,0,0,120,121,5,
        15,0,0,121,31,1,0,0,0,122,123,5,23,0,0,123,33,1,0,0,0,124,125,5,
        23,0,0,125,35,1,0,0,0,8,45,54,62,65,68,79,92,102
    ];

    private static __ATN: antlr.ATN;
    public static get _ATN(): antlr.ATN {
        if (!GQLParser.__ATN) {
            GQLParser.__ATN = new antlr.ATNDeserializer().deserialize(GQLParser._serializedATN);
        }

        return GQLParser.__ATN;
    }


    private static readonly vocabulary = new antlr.Vocabulary(GQLParser.literalNames, GQLParser.symbolicNames, []);

    public override get vocabulary(): antlr.Vocabulary {
        return GQLParser.vocabulary;
    }

    private static readonly decisionsToDFA = GQLParser._ATN.decisionToState.map( (ds: antlr.DecisionState, index: number) => new antlr.DFA(ds, index) );
}

export class MatchClauseContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public K_MATCH(): antlr.TerminalNode {
        return this.getToken(GQLParser.K_MATCH, 0)!;
    }
    public graphPattern(): GraphPatternContext {
        return this.getRuleContext(0, GraphPatternContext)!;
    }
    public EOF(): antlr.TerminalNode {
        return this.getToken(GQLParser.EOF, 0)!;
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_matchClause;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterMatchClause) {
             listener.enterMatchClause(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitMatchClause) {
             listener.exitMatchClause(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitMatchClause) {
            return visitor.visitMatchClause(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class GraphPatternContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public pathPattern(): PathPatternContext[];
    public pathPattern(i: number): PathPatternContext | null;
    public pathPattern(i?: number): PathPatternContext[] | PathPatternContext | null {
        if (i === undefined) {
            return this.getRuleContexts(PathPatternContext);
        }

        return this.getRuleContext(i, PathPatternContext);
    }
    public COMMA(): antlr.TerminalNode[];
    public COMMA(i: number): antlr.TerminalNode | null;
    public COMMA(i?: number): antlr.TerminalNode | null | antlr.TerminalNode[] {
    	if (i === undefined) {
    		return this.getTokens(GQLParser.COMMA);
    	} else {
    		return this.getToken(GQLParser.COMMA, i);
    	}
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_graphPattern;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterGraphPattern) {
             listener.enterGraphPattern(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitGraphPattern) {
             listener.exitGraphPattern(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitGraphPattern) {
            return visitor.visitGraphPattern(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class PathPatternContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public nodePattern(): NodePatternContext[];
    public nodePattern(i: number): NodePatternContext | null;
    public nodePattern(i?: number): NodePatternContext[] | NodePatternContext | null {
        if (i === undefined) {
            return this.getRuleContexts(NodePatternContext);
        }

        return this.getRuleContext(i, NodePatternContext);
    }
    public edgePattern(): EdgePatternContext[];
    public edgePattern(i: number): EdgePatternContext | null;
    public edgePattern(i?: number): EdgePatternContext[] | EdgePatternContext | null {
        if (i === undefined) {
            return this.getRuleContexts(EdgePatternContext);
        }

        return this.getRuleContext(i, EdgePatternContext);
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_pathPattern;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterPathPattern) {
             listener.enterPathPattern(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitPathPattern) {
             listener.exitPathPattern(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitPathPattern) {
            return visitor.visitPathPattern(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class NodePatternContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public LPAREN(): antlr.TerminalNode {
        return this.getToken(GQLParser.LPAREN, 0)!;
    }
    public elementPatternFiller(): ElementPatternFillerContext {
        return this.getRuleContext(0, ElementPatternFillerContext)!;
    }
    public RPAREN(): antlr.TerminalNode {
        return this.getToken(GQLParser.RPAREN, 0)!;
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_nodePattern;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterNodePattern) {
             listener.enterNodePattern(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitNodePattern) {
             listener.exitNodePattern(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitNodePattern) {
            return visitor.visitNodePattern(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class ElementPatternFillerContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public elementVariable(): ElementVariableContext | null {
        return this.getRuleContext(0, ElementVariableContext);
    }
    public labelSpec(): LabelSpecContext | null {
        return this.getRuleContext(0, LabelSpecContext);
    }
    public propertyFilter(): PropertyFilterContext | null {
        return this.getRuleContext(0, PropertyFilterContext);
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_elementPatternFiller;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterElementPatternFiller) {
             listener.enterElementPatternFiller(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitElementPatternFiller) {
             listener.exitElementPatternFiller(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitElementPatternFiller) {
            return visitor.visitElementPatternFiller(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class LabelSpecContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public COLON(): antlr.TerminalNode {
        return this.getToken(GQLParser.COLON, 0)!;
    }
    public labelName(): LabelNameContext {
        return this.getRuleContext(0, LabelNameContext)!;
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_labelSpec;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterLabelSpec) {
             listener.enterLabelSpec(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitLabelSpec) {
             listener.exitLabelSpec(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitLabelSpec) {
            return visitor.visitLabelSpec(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class PropertyFilterContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public LBRACE(): antlr.TerminalNode {
        return this.getToken(GQLParser.LBRACE, 0)!;
    }
    public propertyPair(): PropertyPairContext[];
    public propertyPair(i: number): PropertyPairContext | null;
    public propertyPair(i?: number): PropertyPairContext[] | PropertyPairContext | null {
        if (i === undefined) {
            return this.getRuleContexts(PropertyPairContext);
        }

        return this.getRuleContext(i, PropertyPairContext);
    }
    public RBRACE(): antlr.TerminalNode {
        return this.getToken(GQLParser.RBRACE, 0)!;
    }
    public COMMA(): antlr.TerminalNode[];
    public COMMA(i: number): antlr.TerminalNode | null;
    public COMMA(i?: number): antlr.TerminalNode | null | antlr.TerminalNode[] {
    	if (i === undefined) {
    		return this.getTokens(GQLParser.COMMA);
    	} else {
    		return this.getToken(GQLParser.COMMA, i);
    	}
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_propertyFilter;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterPropertyFilter) {
             listener.enterPropertyFilter(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitPropertyFilter) {
             listener.exitPropertyFilter(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitPropertyFilter) {
            return visitor.visitPropertyFilter(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class PropertyPairContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public propertyKey(): PropertyKeyContext {
        return this.getRuleContext(0, PropertyKeyContext)!;
    }
    public COLON(): antlr.TerminalNode {
        return this.getToken(GQLParser.COLON, 0)!;
    }
    public propertyValue(): PropertyValueContext {
        return this.getRuleContext(0, PropertyValueContext)!;
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_propertyPair;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterPropertyPair) {
             listener.enterPropertyPair(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitPropertyPair) {
             listener.exitPropertyPair(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitPropertyPair) {
            return visitor.visitPropertyPair(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class PropertyKeyContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public IDENTIFIER(): antlr.TerminalNode {
        return this.getToken(GQLParser.IDENTIFIER, 0)!;
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_propertyKey;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterPropertyKey) {
             listener.enterPropertyKey(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitPropertyKey) {
             listener.exitPropertyKey(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitPropertyKey) {
            return visitor.visitPropertyKey(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class PropertyValueContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public literal(): LiteralContext | null {
        return this.getRuleContext(0, LiteralContext);
    }
    public paramRef(): ParamRefContext | null {
        return this.getRuleContext(0, ParamRefContext);
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_propertyValue;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterPropertyValue) {
             listener.enterPropertyValue(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitPropertyValue) {
             listener.exitPropertyValue(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitPropertyValue) {
            return visitor.visitPropertyValue(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class LiteralContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public STRING_LITERAL(): antlr.TerminalNode | null {
        return this.getToken(GQLParser.STRING_LITERAL, 0);
    }
    public FLOAT_LITERAL(): antlr.TerminalNode | null {
        return this.getToken(GQLParser.FLOAT_LITERAL, 0);
    }
    public INTEGER_LITERAL(): antlr.TerminalNode | null {
        return this.getToken(GQLParser.INTEGER_LITERAL, 0);
    }
    public K_TRUE(): antlr.TerminalNode | null {
        return this.getToken(GQLParser.K_TRUE, 0);
    }
    public K_FALSE(): antlr.TerminalNode | null {
        return this.getToken(GQLParser.K_FALSE, 0);
    }
    public K_NULL(): antlr.TerminalNode | null {
        return this.getToken(GQLParser.K_NULL, 0);
    }
    public K_NAN(): antlr.TerminalNode | null {
        return this.getToken(GQLParser.K_NAN, 0);
    }
    public SIGNED_INFINITY(): antlr.TerminalNode | null {
        return this.getToken(GQLParser.SIGNED_INFINITY, 0);
    }
    public K_INFINITY(): antlr.TerminalNode | null {
        return this.getToken(GQLParser.K_INFINITY, 0);
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_literal;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterLiteral) {
             listener.enterLiteral(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitLiteral) {
             listener.exitLiteral(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitLiteral) {
            return visitor.visitLiteral(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class ParamRefContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public DOLLAR(): antlr.TerminalNode {
        return this.getToken(GQLParser.DOLLAR, 0)!;
    }
    public IDENTIFIER(): antlr.TerminalNode {
        return this.getToken(GQLParser.IDENTIFIER, 0)!;
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_paramRef;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterParamRef) {
             listener.enterParamRef(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitParamRef) {
             listener.exitParamRef(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitParamRef) {
            return visitor.visitParamRef(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class EdgePatternContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public directedEdge(): DirectedEdgeContext | null {
        return this.getRuleContext(0, DirectedEdgeContext);
    }
    public reverseDirectedEdge(): ReverseDirectedEdgeContext | null {
        return this.getRuleContext(0, ReverseDirectedEdgeContext);
    }
    public undirectedEdge(): UndirectedEdgeContext | null {
        return this.getRuleContext(0, UndirectedEdgeContext);
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_edgePattern;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterEdgePattern) {
             listener.enterEdgePattern(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitEdgePattern) {
             listener.exitEdgePattern(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitEdgePattern) {
            return visitor.visitEdgePattern(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class DirectedEdgeContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public DASH(): antlr.TerminalNode {
        return this.getToken(GQLParser.DASH, 0)!;
    }
    public LBRACKET(): antlr.TerminalNode {
        return this.getToken(GQLParser.LBRACKET, 0)!;
    }
    public elementPatternFiller(): ElementPatternFillerContext {
        return this.getRuleContext(0, ElementPatternFillerContext)!;
    }
    public RBRACKET(): antlr.TerminalNode {
        return this.getToken(GQLParser.RBRACKET, 0)!;
    }
    public ARROW(): antlr.TerminalNode {
        return this.getToken(GQLParser.ARROW, 0)!;
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_directedEdge;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterDirectedEdge) {
             listener.enterDirectedEdge(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitDirectedEdge) {
             listener.exitDirectedEdge(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitDirectedEdge) {
            return visitor.visitDirectedEdge(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class ReverseDirectedEdgeContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public LARROW(): antlr.TerminalNode {
        return this.getToken(GQLParser.LARROW, 0)!;
    }
    public LBRACKET(): antlr.TerminalNode {
        return this.getToken(GQLParser.LBRACKET, 0)!;
    }
    public elementPatternFiller(): ElementPatternFillerContext {
        return this.getRuleContext(0, ElementPatternFillerContext)!;
    }
    public RBRACKET(): antlr.TerminalNode {
        return this.getToken(GQLParser.RBRACKET, 0)!;
    }
    public DASH(): antlr.TerminalNode {
        return this.getToken(GQLParser.DASH, 0)!;
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_reverseDirectedEdge;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterReverseDirectedEdge) {
             listener.enterReverseDirectedEdge(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitReverseDirectedEdge) {
             listener.exitReverseDirectedEdge(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitReverseDirectedEdge) {
            return visitor.visitReverseDirectedEdge(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class UndirectedEdgeContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public DASH(): antlr.TerminalNode[];
    public DASH(i: number): antlr.TerminalNode | null;
    public DASH(i?: number): antlr.TerminalNode | null | antlr.TerminalNode[] {
    	if (i === undefined) {
    		return this.getTokens(GQLParser.DASH);
    	} else {
    		return this.getToken(GQLParser.DASH, i);
    	}
    }
    public LBRACKET(): antlr.TerminalNode {
        return this.getToken(GQLParser.LBRACKET, 0)!;
    }
    public elementPatternFiller(): ElementPatternFillerContext {
        return this.getRuleContext(0, ElementPatternFillerContext)!;
    }
    public RBRACKET(): antlr.TerminalNode {
        return this.getToken(GQLParser.RBRACKET, 0)!;
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_undirectedEdge;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterUndirectedEdge) {
             listener.enterUndirectedEdge(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitUndirectedEdge) {
             listener.exitUndirectedEdge(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitUndirectedEdge) {
            return visitor.visitUndirectedEdge(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class ElementVariableContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public IDENTIFIER(): antlr.TerminalNode {
        return this.getToken(GQLParser.IDENTIFIER, 0)!;
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_elementVariable;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterElementVariable) {
             listener.enterElementVariable(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitElementVariable) {
             listener.exitElementVariable(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitElementVariable) {
            return visitor.visitElementVariable(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}


export class LabelNameContext extends antlr.ParserRuleContext {
    public constructor(parent: antlr.ParserRuleContext | null, invokingState: number) {
        super(parent, invokingState);
    }
    public IDENTIFIER(): antlr.TerminalNode {
        return this.getToken(GQLParser.IDENTIFIER, 0)!;
    }
    public override get ruleIndex(): number {
        return GQLParser.RULE_labelName;
    }
    public override enterRule(listener: GQLListener): void {
        if(listener.enterLabelName) {
             listener.enterLabelName(this);
        }
    }
    public override exitRule(listener: GQLListener): void {
        if(listener.exitLabelName) {
             listener.exitLabelName(this);
        }
    }
    public override accept<Result>(visitor: GQLVisitor<Result>): Result | null {
        if (visitor.visitLabelName) {
            return visitor.visitLabelName(this);
        } else {
            return visitor.visitChildren(this);
        }
    }
}
