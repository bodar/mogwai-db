import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseGremlinUncached } from '../../src/gremlin/frontend.ts';
import { ValueParseError } from '../../src/gremlin/coerce.ts';
import { parseShape } from '../support/parse-shape.ts';

// The parse is two-stage: SLL + bail first, full LL only when SLL gives up (`parseGremlinUncached`
// in src/gremlin/frontend.ts). It is a pure speed change, so both halves of its contract are asserted
// against a FORCED single LL pass — the parse this function was before: the same tree for every valid
// query, and the byte-identical message for every invalid one.

const corpus = readFileSync(new URL('./corpus.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);

test('every L1 corpus traversal parses to the same tree as a forced LL parse', () => {
  const differs: string[] = [];
  for (const q of corpus) {
    if (parseShape(parseGremlinUncached(q)) !== parseShape(parseGremlinUncached(q, 'll'))) differs.push(q);
  }
  expect(differs).toEqual([]);
}, 60_000); // ~2,400 cold LL parses plus as many SLL ones; generous for a slow CI runner.

test('witnesses whose shapes lean on the grammar parse to the forced-LL tree', () => {
  for (const q of [
    'g.withStrategies(new SubgraphStrategy(checkAdjacentVertices: true, vertices: __.has("name", P.within("josh","lop","ripple")))).V().out()',
    'g.addV().property("name","bob").property(Cardinality.list, "location", "ny", "startTime", 2014, "endTime", 2016)',
    'g.V(); g.E().as("a").select("a")',
  ]) {
    expect(parseShape(parseGremlinUncached(q))).toBe(parseShape(parseGremlinUncached(q, 'll')));
  }
});

const message = (q: string, mode?: 'll'): string => {
  try { parseGremlinUncached(q, mode); } catch (e) {
    expect(e).toBeInstanceOf(ValueParseError);
    return (e as Error).message;
  }
  throw new Error(`expected ${JSON.stringify(q)} to fail to parse`);
};

test('a syntax error reads exactly as it does today', () => {
  // Pinned literally, not only against forced LL, so a change to the LL pass itself shows up too.
  expect(message('g.V().out((')).toBe("Gremlin parse error: 1:10 no viable alternative at input 'g.V().out(('");
});

test('every invalid query — lexer, parser, or both — gives the forced-LL message byte for byte', () => {
  for (const q of [
    'g.V().out((',                       // parser: no viable alternative
    'g.V().foo()',                       // parser: unknown step
    'g.V().out()).in(',                  // parser: mismatched input after a complete query
    '',                                  // parser: empty input
    'g.V(); g.E(',                       // parser error in the second query of a list
    'g.V().repeat(out()).times(',        // parser: unterminated argument list
    'g.V()#',                            // lexer only: SLL succeeds, the lexer message alone
    'g.V().out(``)',                     // lexer only, two messages
    "g.V().has('name', 'x",              // lexer then parser
    'g.V().out(( # ',                    // parser then lexer — the lexer's error lies past the parser's
    'g.V(#).out((',                      // lexer then parser
    'g.V().out("a").#.in(',              // lexer then parser, adjacent
  ]) {
    expect(message(q)).toBe(message(q, 'll'));
  }
});
