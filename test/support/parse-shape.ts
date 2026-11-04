import { ParserRuleContext, TerminalNode, type ParseTree } from 'antlr4ng';

/** A parse tree's full structure as one string: every rule context by its generated CLASS (so a
 *  labelled alternative is distinguished, not just the rule) and every terminal by token type, text
 *  and stream index. Two trees with equal shapes are the same parse — what the two-stage parse's SLL
 *  contract promises against a forced-LL parse. */
export function parseShape(t: ParseTree): string {
  if (t instanceof TerminalNode) return `${t.symbol.type}:${JSON.stringify(t.symbol.text)}@${t.symbol.tokenIndex}`;
  if (t instanceof ParserRuleContext) return `(${t.constructor.name} ${t.children.map(parseShape).join(' ')})`;
  throw new Error(`unexpected parse-tree node ${t.constructor.name}`);
}
