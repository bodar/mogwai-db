// L4 — the mogwai ADDENDUM conformance suite. Our own scenarios, authored in TinkerPop's exact
// Gherkin `.feature` format (test/L4-addendum/*.feature), for VALID traversals the
// official corpus doesn't cover. Each is a combination we implemented for combinatorial
// completeness; @gap:<area> tags the family for a possible gremlin-test PR (the give-back).
//
// The features are read by the REAL Gherkin parser (./read-features.ts — cucumber's own, compiled to
// PICKLES so `Background` and `Scenario Outline` work), which replaced a hand-rolled regex reader.
//
// The RUNNER is ours, and has to be. Upstream's step definitions look like they would fit — L4
// features are in upstream's exact format — but `feature-steps.js` implements
// `Given('the traversal of', …)` by IGNORING the docstring and looking the scenario NAME up in a
// pre-generated `gremlin.js` map. Our scenario names are not in that map, so its Given cannot run
// our traversals. L4 therefore executes the scenario's OWN embedded Gremlin STRING straight through
// our native stack: parse → compile → SQLite → frame → GraphBinary, then decode the response with
// the real `gremlin` client `ioc` (so our extended serializers — BigDecimal/Char/Duration +
// vertex/edge props — are exercised end-to-end, both directions). The expected `| result |` table is
// read in TinkerPop's typed notation (d[32].i / d[1].l / l[…] / null). Every scenario must pass
// (these are OURS); a failure is named with its diff.
//
// That split is also why each scenario is its own `bun test` rather than a cucumber run: the
// assertions are ours either way, and this way a failure reports under the scenario's name with a
// real diff.
//
// Add a scenario: drop it into a *.feature — no code change here. Because they are real Gherkin,
// parsed by the real parser, the @gap set harvests directly into an upstream PR.

import { test, expect, describe } from 'bun:test';
import { loadScenarios } from './read-features.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { exec, executeQuery } from '../support/executor.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { ZOO_SEED } from '../fixtures/seed-zoo.ts';
import { LabelCardinality } from '../../src/api.ts';
import { CREW_SEED } from '../fixtures/seed-crew.ts';
import { BigDecimal, Duration } from '../../src/gremlin/types.ts';
import { standardRegistry } from '../../src/services/standard.ts';
import { decodeAll } from '../support/decode.ts';
import { relirOff } from '../support/harness.ts';

// A vertex carrying one property of each type our extended GraphBinary serializers cover, so a
// `Given the typed graph` scenario can read each back and exercise serialize+decode end-to-end.
const TYPED_SEED = [
  'g.addV("typed")'
  + '.property("n", 9007199254740993L)'                          // long > 2^53 (lossless via CAST-as-text)
  + '.property("bd", 3.141592653589793238462643383279M)'          // BigDecimal beyond f64
  + '.property("du", Duration(90, 500000000))'                    // Duration (90.5s)
  + '.property("dt", datetime("2024-01-01T00:00:00Z"))'           // datetime
  + '.property("u", UUID("0263f28b-eff9-4c17-8e33-0b41c74b6d4c"))', // uuid
];

// A vertex carrying a stored MAP property (the official Map.feature @AllowMapPropertyValues
// graphs), so is(typeOf(GType.MAP)) → MapStream retype scenarios can read it back end-to-end.
const MAPDATA_SEED = [
  'g.addV("data").property("name", "test").property("m", ["a": 1, "b": 2, "c": 3])',
];

// A graph exercising tinker.search over collection + nested-JSON property values, so the
// ValueNode-aware write-path indexer (Step 6) is proven end-to-end: a list value matches via
// its toString AND via an element; a nested map value matches via a nested key/leaf.
const SEARCH_SEED = [
  'g.addV("doc").property("title", "chapter one").property("tags", ["brave", "bold"])',
  'g.addV("doc").property("title", "chapter two").property("addr", ["city": "london", "zone": "central"])',
];

/** The `.feature` files are read by the REAL Gherkin parser — `Scenario` and the assertion
 *  vocabulary live in ./read-features.ts, which maps a cucumber PICKLE onto what this file runs.
 *
 *  What each assertion pins, since this is where they are APPLIED:
 *    unordered/ordered — compare the whole multiset against the table
 *    empty             — no results
 *    count             — only the cardinality is pinned
 *    of                — every result must be ONE OF the table's rows (alternatives), which
 *                        upstream pairs with `count` when several answers are all correct
 *    error             — the traversal must THROW, optionally with a message the assertion
 *                        constrains. A refusal is a real answer here (a third of the write-path
 *                        messages belong to scenarios that pass BECAUSE they assert the throw), so
 *                        it needs to be pinnable without leaving the .feature format. */


// TinkerPop typed-result notation → the SAME canonical key `canon()` produces for the decoded
// value, so expected and actual compare directly. Numbers: d[n].i/.d/.f/.b/.s → number,
// d[n].l/.n → long/bigint (BigInt); bd[…] BigDecimal, dt[…] datetime, du[…] Duration (our
// nanos toString); l[…]/s[…] list/set (ordered within); null; anything else → a bare string.
// A parsed `m[…]` map (or nested leaf) → the SAME canonical key canon() yields for a decoded
// Map: string leaves reuse the typed notation (expectedCanon), arrays stay ordered, nested
// objects sort by entry. Mirrors the official parseMapValue recursion.
function canonMapExpected(v: unknown, refs?: ReadonlyMap<string, unknown>): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return expectedCanon(v, refs);
  if (Array.isArray(v)) return '[' + v.map((x) => canonMapExpected(x, refs)).join(',') + ']';
  if (typeof v === 'object')
    return 'm{' + Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => expectedCanon(k, refs) + '=' + canonMapExpected(x, refs)).sort().join(',') + '}';
  return 'N' + v;
}

function expectedCanon(tok: string, refs?: ReadonlyMap<string, unknown>): string {
  const t = tok.trim();
  if (t === 'null') return 'null';
  // v[marko].id — an element reference, resolved against the seeded store by the caller.
  if (refs?.has(t)) return canon(refs.get(t));
  // v[marko] / e[marko-knows->vadas] — the ELEMENT itself, not its id. Canonicalizes to the same
  // `E<id>` a decoded element does, because upstream compares element results by identity. Both
  // kinds resolve through `elementRefs`, which keys vertices by their `name` and edges by their
  // (outV, label, inV) triple — an edge's identity IS that triple, which is why upstream spells it
  // that way and why no fixture needs a synthetic edge name.
  const eref = t.match(/^[ve]\[(.+)\]$/);
  if (eref && refs?.has(`${t}.id`)) return 'E' + String(refs.get(`${t}.id`));
  // Match the JS client's actual GraphBinary decode: a bigint (`.n`, BigInteger 0x23) is ALWAYS a
  // JS BigInt; a long (`.l`, Int64 0x02) decodes to a Number within ±2^53 and a BigInt beyond
  // (the client's Long deserializer is magnitude-dependent) — so count()/groupCount() longs, which
  // are small, compare as Numbers, exactly as TinkerPop's own harness (parseFloat) treats `.l`.
  // int/double/float/byte/short → number.
  const num = t.match(/^d\[(-?[\d.eE+]+)\]\.([bsilfnd])$/);
  if (num) {
    if (num[2] === 'n') return 'L' + BigInt(num[1]).toString();
    if (num[2] === 'l') {
      const b = BigInt(num[1]);
      return b >= -9007199254740991n && b <= 9007199254740991n ? 'N' + Number(b) : 'L' + b.toString();
    }
    return 'N' + Number(num[1]);
  }
  const bd = t.match(/^bd\[(.+)\]$/); if (bd) return 'BD' + bd[1];
  const dt = t.match(/^dt\[(.+)\]$/); if (dt) return 'DT' + new Date(dt[1]).toISOString();
  const du = t.match(/^du\[(.+)\]$/); if (du) return 'DU' + du[1];
  // A SET compares unordered (sorted); a LIST keeps its written order.
  if (t.startsWith('s[') && t.endsWith(']')) {
    const inner = t.slice(2, -1);
    return 's[' + (inner === '' ? '' : splitTopLevel(inner).map((x) => expectedCanon(x, refs)).sort().join(',')) + ']';
  }
  if (t.startsWith('l[') && t.endsWith(']')) {
    const inner = t.slice(2, -1);
    return '[' + (inner === '' ? '' : splitTopLevel(inner).map((x) => expectedCanon(x, refs)).join(',')) + ']';
  }
  // t[id] / t[label] — a T token in a map key position.
  const ttok = t.match(/^t\[(\w+)\]$/); if (ttok) return 'T' + ttok[1];
  // p[…] — a Path, framed by its ordered objects (each in typed notation).
  if (t.startsWith('p[') && t.endsWith(']')) {
    const inner = t.slice(2, -1);
    return 'p[' + (inner === '' ? '' : splitTopLevel(inner).map((x) => expectedCanon(x, refs)).join(',')) + ']';
  }
  // m[{…}] — a Map (JSON object; values in typed-string notation, mirrors the official
  // parseMapValue). Same canonical form as canon() of a decoded Map so the two compare.
  if (t.startsWith('m[') && t.endsWith(']')) return canonMapExpected(JSON.parse(t.slice(2, -1)), refs);
  return 'S' + t;
}

// Split a comma list, not descending into nested […] brackets.
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']') depth--;
    else if (s[i] === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

// A canonical, type-aware key so results compare unordered while lists stay ordered within.
function canon(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'bigint') return 'L' + v.toString();
  if (typeof v === 'number') return 'N' + v;
  if (typeof v === 'string') return 'S' + v;
  if (v instanceof BigDecimal) return 'BD' + v.toString();
  if (v instanceof Duration) return 'DU' + v.toString();
  if (v instanceof Date) return 'DT' + v.toISOString();
  if (v && typeof v === 'object' && Array.isArray((v as { objects?: unknown }).objects))
    return 'p[' + (v as { objects: unknown[] }).objects.map(canon).join(',') + ']';
  // A decoded Map (group()/project()/valueMap() etc.) — entries key-sorted so compare is
  // unordered by key, each key+value recursively canonicalized (lists stay ordered within).
  if (v instanceof Map)
    return 'm{' + [...v.entries()].map(([k, val]) => canon(k) + '=' + canon(val)).sort().join(',') + '}';
  // A SET is unordered, so it canonicalizes sorted — unlike a list, which keeps its order. This is
  // what `t[label]` frames as under the multi-label regime.
  if (v instanceof Set) return 's[' + [...v].map(canon).sort().join(',') + ']';
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  // A T token (`t[id]`/`t[label]` as a map KEY) decodes to the client's EnumValue; match the token
  // spelling the feature table uses rather than its JSON shape.
  if (v && typeof v === 'object' && (v as any).typeName === 'T' && typeof (v as any).elementName === 'string')
    return 'T' + (v as any).elementName;
  // A decoded ELEMENT compares BY ID, which is upstream's rule for `v[marko]`/`e[marko-knows->vadas]`
  // — its runner resolves the reference to a cached element and compares identity, so a label or
  // property difference is deliberately NOT part of the comparison (see outstanding-work 19, where
  // that is exactly why no corpus scenario could catch a wrong vertex label).
  const el = elementId(v);
  if (el !== null) return 'E' + String(el);
  return 'J' + JSON.stringify(v);
}

/** The id of a decoded Vertex/Edge/VertexProperty, or null for anything else. The client decodes
 *  an element to a plain object carrying `id` plus `label`; a Path carries `objects` and a Map is a
 *  real Map, so both are already claimed above and cannot be mistaken for one. */
function elementId(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as { id?: unknown; label?: unknown };
  return o.id !== undefined && o.label !== undefined ? o.id : null;
}

/** A fixture is a seed AND the capability the graph declares — `multilabel`/`zoo` need
 *  ZERO_OR_MORE, everything else keeps TinkerGraph's ONE default. */
interface Fixture { seed: readonly string[]; labelCardinality?: LabelCardinality; }
const GRAPHS: Record<string, Fixture> = {
  modern: { seed: MODERN_SEED }, crew: { seed: CREW_SEED }, typed: { seed: TYPED_SEED },
  mapdata: { seed: MAPDATA_SEED }, search: { seed: SEARCH_SEED }, empty: { seed: [] },
  multilabel: { seed: [], labelCardinality: LabelCardinality.ZERO_OR_MORE },
  zoo: { seed: ZOO_SEED, labelCardinality: LabelCardinality.ZERO_OR_MORE },
};

/** Resolve upstream's element REFERENCES — `v[marko].id` is "the id of the vertex named marko".
 *  The official runner does this from a cache it builds with `g.V().group().by('name').by(tail())`;
 *  L4 reads the same thing straight off the store after seeding, so a scenario can be copied in
 *  verbatim instead of being rewritten around literal ids. */
function elementRefs(store: GraphStore): Map<string, unknown> {
  const refs = new Map<string, unknown>();
  for (const r of store.query<{ name: unknown; id: unknown }>(
    'SELECT vp.value AS name, vp.node AS id FROM vertex_properties vp WHERE vp.key = ?', ['name']))
    refs.set(`v[${String(r.name)}].id`, r.id);
  // EDGES, keyed by upstream's own notation — `e[marko-knows->vadas].id`. Until this existed L4
  // could not assert ANY edge-valued result: the cache was keyed on a `name` property, which no
  // fixture edge carries, so `e[…]` fell through to a bare string and compared against `E<id>`.
  // An edge has no name of its own, but it has something better — it IS its (outV, label, inV)
  // triple, which is exactly why upstream spells it that way. Resolved by joining both endpoints
  // back to their names, so it needs no fixture change and reads the same as the corpus.
  for (const r of store.query<{ out: unknown; label: unknown; in: unknown; id: unknown }>(
    `SELECT ov.value AS "out", l.name AS label, iv.value AS "in", e.id AS id
       FROM edges e
       JOIN labels l ON l.id = e.label
       JOIN vertex_properties ov ON ov.node = e.src AND ov.key = ?
       JOIN vertex_properties iv ON iv.node = e.tgt AND iv.key = ?`, ['name', 'name']))
    refs.set(`e[${String(r.out)}-${String(r.label)}->${String(r.in)}].id`, r.id);
  return refs;
}

describe('L4 addendum — mogwai gap scenarios (real end-to-end over GraphBinary)', () => {
  const scenarios = loadScenarios();
  test('the addendum is non-empty', () => expect(scenarios.length).toBeGreaterThan(0));

  // The differential's OFF position runs the same suite through the legacy spine, so a scenario whose
  // answer only that spine's replacement can give is not a failure there — it is the divergence the
  // tag declares. It is not SKIPPED there either: the declared divergence is "RelIR answers this and
  // the legacy spine refuses it", and both halves are checkable, so with RelIR off the scenario
  // asserts the REFUSAL. A skip would say the same thing right up until the two spines started both
  // answering and answering differently, which is not a divergence to declare but a defect.
  for (const s of scenarios) {
    test(`[${s.graph}] ${s.name}`, async () => {
      if (!(s.graph in GRAPHS)) throw new Error(`unknown graph '${s.graph}' (add its fixture to GRAPHS)`);
      const fixture = GRAPHS[s.graph];
      const store = new GraphStore(new BunSqlite(':memory:'), fixture.labelCardinality);
      for (const w of fixture.seed) executeQuery(store, w, {});
      // A scenario's own `graph initializer` runs after the fixture seed and before its traversal,
      // exactly as upstream orders them.
      if (s.initializer) executeQuery(store, s.initializer, {}, {}, standardRegistry);
      // The scenario's OWN traversal, with its spine pinned when the scenario asked for one
      // (`@SpineRel`/`@SpineLegacy` — see `pinSpine` in read-features.ts). The fixture seed and the
      // initializer stay ambient on purpose: they are writes that set up a graph, not the answer
      // under test, so pinning them would widen what the tag claims.
      const runTraversal = () => s.pinSpine
        ? exec(store, standardRegistry, undefined, s.pinSpine).buffers(s.gremlin, {}, {})
        : executeQuery(store, s.gremlin, {}, {}, standardRegistry);
      // An `error` scenario asserts the REFUSAL, so it runs the traversal expecting a throw and
      // nothing below it applies. Upstream compares the message case-insensitively; so do we.
      // An `@RelIR` scenario becomes one of these when RelIR is off — its message is the legacy
      // spine's and not ours to pin, so only the throw itself is asserted.
      if (s.assertion === 'error' || (s.relirOnly && relirOff)) {
        let thrown: unknown;
        try { await decodeAll(runTraversal()); }
        catch (e) { thrown = e; }
        expect(thrown).toBeInstanceOf(Error);
        if (s.error && s.assertion === 'error') {
          const msg = String((thrown as Error).message).toUpperCase();
          const want = s.error.text.toUpperCase();
          if (s.error.comparison === 'containing') expect(msg).toContain(want);
          else if (s.error.comparison === 'starting') expect(msg.startsWith(want)).toBe(true);
          else expect(msg.endsWith(want)).toBe(true);
        }
        return;
      }
      // The standard service registry is injected so call() scenarios (tinker.search / degree)
      // resolve; a non-call scenario is unaffected (it never looks a service up).
      const decoded = await decodeAll(runTraversal());
      const got = decoded.map(canon);
      // Element references (`v[marko].id`) resolve against the seeded store, so a scenario copied
      // in verbatim from gremlin-test needs no rewriting around literal ids.
      const refs = elementRefs(store);
      const want = s.expected.map((e) => expectedCanon(e, refs));

      if (s.count !== null) expect(got.length).toBe(s.count);
      switch (s.assertion) {
        case 'empty': expect(got).toEqual([]); break;
        // Ordered compares as written; unordered sorts BOTH sides. (`ordered` used to sort too —
        // it did not actually assert order — so this is a tightening, not just a move.)
        case 'ordered': expect(got).toEqual(want); break;
        case 'unordered': expect([...got].sort()).toEqual([...want].sort()); break;
        // `of` — every result must be one of the listed alternatives; the count (if given) is
        // already checked above, and that pair is how upstream pins a legitimately ambiguous answer.
        case 'of': for (const g of got) expect(want).toContain(g); break;
        case 'count': break; // the count above IS the assertion
        // 'error' returned above, before the traversal was run for results — TS narrows it out here.
      }
      // Graph-state checks last: they read the store the traversal just mutated.
      for (const g of s.graphChecks)
        expect(
          (await decodeAll(executeQuery(store, g.gremlin, {}, {}, standardRegistry))).length,
        ).toBe(g.count);
    });
  }
});
