// L4 — the mogwai ADDENDUM conformance suite. Our own scenarios, authored in TinkerPop's exact
// Gherkin `.feature` format (test/conformance/addendum/*.feature), for VALID traversals the
// official corpus doesn't cover. Each is a combination we implemented for combinatorial
// completeness; @gap:<area> tags the family for a possible gremlin-test PR (the give-back).
//
// Unlike the official cucumber harness — which binds each scenario NAME to a pre-generated
// traversal in a vendored `gremlin.js` — L4 runs the scenario's OWN embedded Gremlin STRING
// straight through our native stack: parse → compile → SQLite → frame → GraphBinary, then
// decode the response with the real `gremlin` client `ioc` (so our extended serializers —
// BigDecimal/Char/Duration + vertex/edge props — are exercised end-to-end, both directions).
// The expected `| result |` table is parsed in TinkerPop's typed notation (d[32].i / d[1].l /
// l[…] / null). Every scenario must pass (these are OURS); a failure is named with its diff.
//
// Add a scenario: drop it into an addendum/*.feature — no code change here. Because they are
// real Gherkin, the @gap set harvests directly into an upstream PR.

import { test, expect, describe } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery } from '../../src/execute.ts';
import { ioc } from '../../src/io.ts';
import { MODERN_SEED } from './seed-modern.ts';
import { CREW_SEED } from './seed-crew.ts';

const ADDENDUM = new URL('./addendum/', import.meta.url).pathname;

interface Scenario { feature: string; name: string; graph: string; gremlin: string; expected: string[]; }

// A minimal Gherkin reader for our own feature files: name + `Given the X graph` + the
// `the traversal of """…"""` docstring + the `| result |` table. Deliberately tiny — it only
// has to read the subset we author, not the full Gherkin grammar.
function parseFeature(featureName: string, text: string): Scenario[] {
  const lines = text.split('\n');
  const out: Scenario[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(/^Scenario:\s*(.+)$/);
    if (!m) continue;
    const s: Scenario = { feature: featureName, name: m[1].trim(), graph: 'empty', gremlin: '', expected: [] };
    for (i++; i < lines.length && !/^\s*Scenario:/.test(lines[i]); i++) {
      const l = lines[i].trim();
      const g = l.match(/^(?:Given|And)\s+(?:the|an?)\s+(\w+)\s+graph$/);
      if (g) s.graph = g[1];
      if (l === '"""') {
        const body: string[] = [];
        for (i++; i < lines.length && lines[i].trim() !== '"""'; i++) body.push(lines[i].trim());
        s.gremlin = body.join(' ');
      } else if (l.startsWith('|')) {
        const cell = l.replace(/^\|/, '').replace(/\|$/, '').trim();
        if (cell !== 'result') s.expected.push(cell);
      }
    }
    i--; // the inner loop stepped onto the next Scenario line; let the outer loop see it
    out.push(s);
  }
  return out;
}

// TinkerPop typed-result notation → the JS value our GraphBinary decode produces. long → BigInt
// (matching the client's Int64 decode), int/double/float → number, l[…] → array (ordered),
// null → null, anything else → a bare string.
function parseTyped(tok: string): unknown {
  const t = tok.trim();
  if (t === 'null') return null;
  const num = t.match(/^d\[(-?[\d.eE+]+)\]\.([bsilfnmd])$/);
  if (num) return num[2] === 'l' || num[2] === 'n' ? BigInt(num[1]) : Number(num[1]);
  if ((t.startsWith('l[') || t.startsWith('s[')) && t.endsWith(']')) {
    const inner = t.slice(2, -1);
    return inner === '' ? [] : splitTopLevel(inner).map(parseTyped);
  }
  return t;
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
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return 'J' + JSON.stringify(v);
}

const GRAPHS: Record<string, readonly string[]> = { modern: MODERN_SEED, crew: CREW_SEED, empty: [] };

function loadScenarios(): Scenario[] {
  return readdirSync(ADDENDUM)
    .filter((f) => f.endsWith('.feature'))
    .flatMap((f) => parseFeature(f, readFileSync(ADDENDUM + f, 'utf8')));
}

describe('L4 addendum — mogwai gap scenarios (real end-to-end over GraphBinary)', () => {
  const scenarios = loadScenarios();
  test('the addendum is non-empty', () => expect(scenarios.length).toBeGreaterThan(0));

  for (const s of scenarios) {
    test(`[${s.graph}] ${s.name}`, () => {
      if (!(s.graph in GRAPHS)) throw new Error(`unknown graph '${s.graph}' (add its seed to GRAPHS)`);
      const store = new GraphStore(new BunSqlite(':memory:'));
      for (const w of GRAPHS[s.graph]) executeQuery(store, w, {});
      const decoded = executeQuery(store, s.gremlin, {}).map((b: Buffer) => ioc.anySerializer.deserialize(b, true).v);
      const got = decoded.map(canon).sort();
      const want = s.expected.map(parseTyped).map(canon).sort();
      expect(got).toEqual(want);
    });
  }
});
