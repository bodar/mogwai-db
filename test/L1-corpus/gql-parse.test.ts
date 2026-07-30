// L1 for the MATCH-string SUB-LANGUAGE: every GQL pattern the corpus contains must parse.
//
// `Gremlin.g4` types `match`'s argument as an opaque `stringLiteral`, so L1's own parse+chain bar
// says nothing about the pattern inside it — `corpus.test.ts` is 100% green while every one of these
// patterns is unparsed. This file applies the same bar one level down, against the SECOND generated
// parser (`parser/gql/`, from upstream's `gql-gremlin/src/main/antlr4/GQL.g4`).
//
// The patterns are extracted from `corpus.txt` rather than listed here, so the set tracks upstream:
// a new MatchString scenario raises the bar automatically instead of silently sitting outside it.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CharStream, CommonTokenStream, BaseErrorListener } from 'antlr4ng';
import { GQLLexer } from '../../parser/gql/GQLLexer.ts';
import { GQLParser } from '../../parser/gql/GQLParser.ts';

/** Every string argument of a `match("…")` / `match('…')` call in the corpus, unescaped.
 *  Deliberately a regex over the corpus text and not a parse: this is the INPUT side of the
 *  sub-language, so depending on the Gremlin front-end here would couple the two bars. */
function matchStrings(corpus: string): string[] {
  const out: string[] = [];
  for (const m of corpus.matchAll(/\bmatch\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) {
    const body = m[2].replace(/\\(['"\\])/g, '$1');
    if (/^\s*MATCH\b/i.test(body)) out.push(body);
  }
  return [...new Set(out)];
}

class Errors extends BaseErrorListener {
  errors: string[] = [];
  override syntaxError(_r: any, _s: any, line: number, col: number, msg: string) {
    this.errors.push(`${line}:${col} ${msg}`);
  }
}

/** Parse one GQL MATCH clause, returning its syntax errors (empty = clean). */
function parseErrors(pattern: string): string[] {
  const lexer = new GQLLexer(CharStream.fromString(pattern));
  const parser = new GQLParser(new CommonTokenStream(lexer));
  const errs = new Errors();
  lexer.removeErrorListeners(); parser.removeErrorListeners();
  lexer.addErrorListener(errs); parser.addErrorListener(errs);
  parser.matchClause();
  return errs.errors;
}

const CORPUS = readFileSync(new URL('./corpus.txt', import.meta.url), 'utf8');

test('every MATCH-string pattern in the corpus parses at 100%', () => {
  const patterns = matchStrings(CORPUS);
  // A floor, not an assertion about the exact count: upstream may add scenarios. If this ever
  // reads 0 the extraction regex has silently stopped matching, which would make the whole file
  // vacuously green — the failure mode worth guarding.
  expect(patterns.length).toBeGreaterThanOrEqual(21);

  const failures = patterns
    .map((p) => ({ p, errs: parseErrors(p) }))
    .filter(({ errs }) => errs.length);

  console.log(`GQL: ${patterns.length - failures.length}/${patterns.length} corpus MATCH patterns parse`);
  if (failures.length)
    console.log(failures.map(({ p, errs }) => `  ${p}\n    ${errs.join('; ')}`).join('\n'));

  expect(failures).toEqual([]);
});

test('the GQL parser rejects malformed patterns rather than accepting them silently', () => {
  // A generated parser that accepts everything would pass the test above vacuously. Each of these
  // violates the grammar in a different place: the required leading keyword, node parenthesisation,
  // the bracket form edges must use, and property-filter syntax.
  for (const bad of [
    '(a:person)',                        // no MATCH keyword
    'MATCH a:person',                    // unparenthesised node
    'MATCH (a)-:knows->(b)',             // edge without brackets
    'MATCH (a {name})',                  // property filter with no value
    'MATCH (a)-[:knows]->',              // dangling edge, no target node
  ])
    expect(parseErrors(bad).length, `expected a syntax error for: ${bad}`).toBeGreaterThan(0);
});
