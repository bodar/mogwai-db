// The MATCH-string translator (src/gremlin/gql.ts): GQL pattern → the match() IR.
//
// Two levels, because each catches what the other cannot:
//
//  · SHAPE — the emitted `Step[]`, rendered back to Gremlin text. This is where orientation,
//    anonymous naming, constraint placement and the terminal projection are pinned, because they are
//    decidable from the pattern alone and a wrong choice is invisible in a result set that happens to
//    match anyway.
//  · BEHAVIOUR — that same rendered chain EXECUTED against the modern graph, compared with
//    MatchString.feature's expected rows. The rendering is valid Gremlin, so the translator can be
//    verified end-to-end before the desugar Pass exists to wire it in.
import { test, expect, describe } from 'bun:test';
import { parseGremlin, stepChain, type Step } from '../../src/gremlin/frontend.ts';
import { gqlMatchSteps } from '../../src/gremlin/gql.ts';
import { decodeAll } from '../support/decode.ts';
import { seeded } from '../support/graph.ts';
import { exec } from '../support/executor.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';

/** Any real parse context serves as the host stamp; the translator only carries it through. */
const HOST_CTX = stepChain(parseGremlin('g.V()'), {})[0].ctx;

/** Render a synthesized chain back to Gremlin text. Doubles as the executable form — which is the
 *  point: the assertion and the execution read the same emitted steps. */
function render(steps: readonly Step[]): string {
  return steps.map((s) => {
    const args = (s.args ?? []).map((arg: any) => arg.value).map((a: any) =>
      a && typeof a === 'object' && 'nested' in a ? `__.${render(a.nested)}` : JSON.stringify(a));
    return `${s.name}(${args.join(',')})`;
  }).join('.');
}

const translate = (gql: string, opts: { terminal?: boolean; params?: Record<string, any> } = {}) =>
  render(gqlMatchSteps(gql, opts.params ?? {}, HOST_CTX, opts.terminal ?? false));

describe('GQL MATCH translation — shape', () => {
  test('a node pattern binds the seed in the PREFIX, so an index can serve its constraints', () => {
    expect(translate('MATCH (p:person)')).toBe('V().hasLabel("person").as("p")');
    expect(translate("MATCH (p:person {name: 'marko', age: 29i})"))
      .toBe('V().hasLabel("person").has("name","marko").has("age",29).as("p")');
  });

  test('an edge orients from the already-bound end, in either written direction', () => {
    expect(translate('MATCH (a:person)-[:knows]->(b:person)'))
      .toBe('V().hasLabel("person").as("a").match(__.as("a").out("knows").hasLabel("person").as("b"))');
    expect(translate('MATCH (s:software)<-[:created]-(p:person)'))
      .toBe('V().hasLabel("software").as("s").match(__.as("s").in("created").hasLabel("person").as("p"))');
    expect(translate('MATCH (a:person)-[:knows]-(b:person)'))
      .toBe('V().hasLabel("person").as("a").match(__.as("a").both("knows").hasLabel("person").as("b"))');
  });

  // The BFS exists for this case and only this case: match()'s own scheduler reorders patterns
  // freely but cannot REVERSE one, so a second path pattern whose start is unbound must be emitted
  // backwards from the shared variable.
  test('a second path pattern is REVERSED to start from the shared variable', () => {
    expect(translate('MATCH (a:person)-[:created]->(s:software), (b:person)-[:created]->(s)'))
      .toBe('V().hasLabel("person").as("a").match('
        + '__.as("a").out("created").hasLabel("software").as("s"),'
        + '__.as("s").in("created").hasLabel("person").as("b"))');
  });

  test('an anonymous node gets a variable a user cannot type', () => {
    // GQL IDENTIFIER is [a-zA-Z_][a-zA-Z_0-9]*, so a leading space cannot collide.
    expect(translate('MATCH ()-[:knows]->(b:person)'))
      .toBe('V().as(" anon0").match(__.as(" anon0").out("knows").hasLabel("person").as("b"))');
  });

  test('an edge VARIABLE splits into two patterns, since match() binds one end each', () => {
    expect(translate('MATCH (a:person)-[e:knows]->(b:person)'))
      .toBe('V().hasLabel("person").as("a").match('
        + '__.as("a").outE("knows").as("e"),'
        + '__.as("e").inV().hasLabel("person").as("b"))');
  });

  test('an edge PROPERTY forces the exploded form, because a bare out() has no edge to filter', () => {
    expect(translate('MATCH (a:person)-[:knows {weight: 1.0}]->(b:person)'))
      .toBe('V().hasLabel("person").as("a").match('
        + '__.as("a").outE("knows").has("weight",1).inV().hasLabel("person").as("b"))');
  });

  test('{k: null} means the property is ABSENT, not equal to null', () => {
    // hasNot() is unimplemented; not(has(k)) is the verified equivalent.
    expect(translate('MATCH (v {age: null})')).toBe('V().not(__.has("age")).as("v")');
  });

  test('a back edge re-uses a bound variable, which match() reads as a CONSTRAINT', () => {
    expect(translate('MATCH (a:person)-[:knows]->(b:person)-[:created]->(s:software)<-[:created]-(a)'))
      .toBe('V().hasLabel("person").as("a").match('
        + '__.as("a").out("knows").hasLabel("person").as("b"),'
        + '__.as("b").out("created").hasLabel("software").as("s"),'
        + '__.as("s").in("created").hasLabel("person").as("a"))');
  });

  test('a terminal match projects the binding map over DECLARED variables only', () => {
    expect(translate('MATCH (a:person)-[:knows]->(b:person)', { terminal: true }))
      .toEndWith('.select("a","b")');
    // One variable: select(v) would yield the VALUE, so a one-key map needs project().
    expect(translate('MATCH (p:person)', { terminal: true })).toEndWith('.project("p").by(__.select("p"))');
    // Anonymous nodes are not declared, so they never appear in the map.
    expect(translate('MATCH ()-[:knows]->(b:person)', { terminal: true })).toEndWith('.project("b").by(__.select("b"))');
  });

  test('a $param resolves from the map argument, and an unbound one fails closed', () => {
    expect(translate('MATCH (p:person {name: $who})', { params: { who: 'marko' } }))
      .toBe('V().hasLabel("person").has("name","marko").as("p")');
    // Upstream resolves a missing param to null, which then matches an ABSENT property — a
    // fail-open we deliberately do not copy.
    expect(() => translate('MATCH (p:person {name: $who})')).toThrow('unbound parameter $who');
  });

  test('the residuals fail closed, naming the GQL construct rather than the desugared Gremlin', () => {
    expect(() => translate('MATCH (a)-[e:knows]-(b)')).toThrow('undirected edge with a variable');
    expect(() => translate('MATCH (a)-[:knows]->(b), (c)-[:knows]->(d)')).toThrow('disconnected components');
    expect(() => translate('MATCH (a:person)-[:knows]->(a:software)')).toThrow('two labels');
    expect(() => translate('MATCH (a)-[:knows]->(b)')).not.toThrow();
    expect(() => translate('(a:person)')).toThrow('parse error');
  });
});

// The desugar Pass sits in the `extract` category, and that placement is LOAD-BEARING but SILENT:
// nothing fails loudly if it moves to `canonicalize`. The injectors (decoration) recurse into raw
// `{nested}` args, so a desugar running after them would mint pattern bodies the criterion never
// reaches — an unfiltered leak, not an error. This is the guard the design doc asked for.
describe('the MATCH-string desugar runs before decoration', () => {
  test('a SubgraphStrategy criterion reaches the minted pattern bodies', () => {
    const store = seeded(MODERN_SEED);
    const crit = 'new SubgraphStrategy(vertices: __.has("name", P.within("marko","vadas")))';
    // Unfiltered, marko knows both vadas and josh. The criterion excludes josh, so only the
    // marko→vadas binding may survive — and the pattern body is where `b` is bound, so a criterion
    // that failed to reach it would leave josh in.
    const rows = exec(store).buffers(
      `g.withStrategies(${crit}).match("MATCH (a:person)-[:knows]->(b:person)").select("a","b").by("name")`, {});
    expect(rows.length).toBe(1);
  });

  test('the desugar leaves the chain end intact for stripTerminal', () => {
    // stripTerminal runs FIRST so the desugar sees the true last step; if the two were swapped, a
    // trailing discard would make the match look non-terminal.
    const store = seeded(MODERN_SEED);
    expect(exec(store).buffers('g.match("MATCH (a:person)-[:knows]->(b:person)").discard()', {}).length).toBe(0);
  });
});

// The feature's own expected rows, against the graph it names. This is the translator's real bar:
// the shape assertions above say we emitted what we intended, these say what we intended is right.
describe('GQL MATCH translation — executes to MatchString.feature\'s expected results', () => {
  const store = seeded(MODERN_SEED);
  /** Run a translated pattern with a Gremlin tail appended, as the scenarios do. */
  const runGql = async (gql: string, tail = '', params: Record<string, any> = {}) =>
    decodeAll(exec(store).buffers(`g.${translate(gql, { params })}${tail}`, {}));
  const bag = (xs: any[]) => xs.map((x) =>
    x instanceof Map ? JSON.stringify(Object.fromEntries(x)) : JSON.stringify(x)).sort();

  test('g_match_person_selectXpX_byXnameX', async () => {
    expect(bag(await runGql('MATCH (p:person)', '.select("p").by("name")')))
      .toEqual(bag(['marko', 'vadas', 'josh', 'peter']));
  });

  test('g_match_personXknowsX_person_selectXa_bX_byXnameX', async () => {
    expect(bag(await runGql('MATCH (a:person)-[:knows]->(b:person)', '.select("a","b").by("name")')))
      .toEqual(bag([{ a: 'marko', b: 'vadas' }, { a: 'marko', b: 'josh' }].map((m) => new Map(Object.entries(m)))));
  });

  test('g_match_softwareXreversedCreatedX_person_selectXp_sX_byXnameX', async () => {
    expect(bag(await runGql('MATCH (s:software)<-[:created]-(p:person)', '.select("p","s").by("name")')))
      .toEqual(bag([{ p: 'marko', s: 'lop' }, { p: 'josh', s: 'ripple' }, { p: 'josh', s: 'lop' }, { p: 'peter', s: 'lop' }]
        .map((m) => new Map(Object.entries(m)))));
  });

  test('g_match_personXundirectedKnowsX_person — both orientations', async () => {
    expect(bag(await runGql('MATCH (a:person)-[:knows]-(b:person)', '.select("a","b").by("name")')))
      .toEqual(bag([{ a: 'marko', b: 'vadas' }, { a: 'marko', b: 'josh' }, { a: 'vadas', b: 'marko' }, { a: 'josh', b: 'marko' }]
        .map((m) => new Map(Object.entries(m)))));
  });

  test('g_match_multiPattern_sharedVariable_whereXa_neqXbXX — the reversed second pattern', async () => {
    const rows = await runGql('MATCH (a:person)-[:created]->(s:software), (b:person)-[:created]->(s)',
      '.where("a",P.neq("b")).select("a","b","s").by("name")');
    expect(rows.length).toBe(6); // every ordered co-creator pair on lop
  });

  test('g_match_cyclicPattern — the back edge constrains rather than re-binds', async () => {
    expect(bag(await runGql('MATCH (a:person)-[:knows]->(b:person)-[:created]->(s:software)<-[:created]-(a)',
      '.select("a","b","s").by("name")')))
      .toEqual(bag([new Map(Object.entries({ a: 'marko', b: 'josh', s: 'lop' }))]));
  });

  test('g_match_absentAgeProperty — {age: null} is the software vertices', async () => {
    expect(bag(await runGql('MATCH (v {age: null})', '.select("v").by("name")'))).toEqual(bag(['lop', 'ripple']));
  });

  test('g_match_personXage_29iX / personXname_paramX — typed and parameterised literals', async () => {
    expect(await runGql('MATCH (p:person {age: 29i})', '.select("p").by("name")')).toEqual(['marko']);
    expect(bag(await runGql('MATCH (p:person {name: $who})-[:knows]->(f:person)', '.select("p","f").by("name")', { who: 'marko' })))
      .toEqual(bag([{ p: 'marko', f: 'vadas' }, { p: 'marko', f: 'josh' }].map((m) => new Map(Object.entries(m)))));
  });

  test('g_match_personXknowsXweight_1X_person — an edge property filter', async () => {
    expect(bag(await runGql('MATCH (a:person)-[:knows {weight: 1.0}]->(b:person)', '.select("a","b").by("name")')))
      .toEqual(bag([new Map(Object.entries({ a: 'marko', b: 'josh' }))]));
  });

  test('g_match_anonymousXknowsX_person — an anonymous seed', async () => {
    expect(bag(await runGql('MATCH ()-[:knows]->(b:person)', '.select("b").by("name")'))).toEqual(bag(['vadas', 'josh']));
  });

  test('g_match_personXknowsX_anyXcreatedX_software — an anonymous MIDDLE node', async () => {
    expect(bag(await runGql('MATCH (a:person)-[:knows]->()-[:created]->(s:software)', '.select("a","s").by("name")')))
      .toEqual(bag([{ a: 'marko', s: 'ripple' }, { a: 'marko', s: 'lop' }].map((m) => new Map(Object.entries(m)))));
  });

  test('g_match_noMatchPattern_emptyResult', async () => {
    expect(await runGql('MATCH (a:software)-[:knows]->(b)', '.select("a","b")')).toEqual([]);
  });

  test('g_match_terminalBindingMap — no tail at all', async () => {
    const rows = await decodeAll(exec(store).buffers(
      `g.${translate('MATCH (a:person)-[:knows]->(b:person)', { terminal: true })}`, {}));
    expect(rows.length).toBe(2);
    for (const r of rows) expect([...(r as Map<string, any>).keys()]).toEqual(['a', 'b']);
  });

  // The scenario that needed the by()-modulator work to land first — its concat argument is a
  // select(label).by(key) over a scalar parent.
  test('g_match_anyXknowsX_any_selectXaX_byXnameX_concatX…X', async () => {
    expect(bag(await runGql('MATCH (a)-[:knows]->(b)',
      '.select("a").by("name").concat(__.constant(" knows "),__.select("b").by("name"))')))
      .toEqual(bag(['marko knows vadas', 'marko knows josh']));
  });
});
