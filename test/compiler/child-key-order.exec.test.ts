// A child `by()` key orders by its body's TYPE TAG (`ChildValue.vtype`): a stored BigDecimal is decimal
// TEXT, so the raw value sorted after every number. Values equal by value (`0m`/`-0.0d`/`0.0d`,
// `1m`/`1.0d`) are a TIE — a sort over them answers (feature-support-matrix.md, Deliberate divergences).
import { test, expect } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { typedAll } from '../support/decode.ts';

const store = seededStore();
for (const [label, rows] of Object.entries({
  q: [['five', '5m'], ['ten', '10.0d'], ['seven', '7n']],
  z: [['big', '0m'], ['neg', '-0.0d'], ['pos', '0.0d']],
  o: [['big', '1m'], ['dbl', '1.0d']],
})) for (const [name, x] of rows!) executeQuery(store, `g.addV('${label}').property('name','${name}').property('x', ${x})`, {});
const run = (q: string) => typedAll(executeQuery(store, q, {}));

test.each([
  "g.V().hasLabel('q').order().by(values('x')).values('name')",
  "g.V().hasLabel('q').order().by(coalesce(values('x'), constant(1))).values('name')",
  "g.V().hasLabel('q').order().by('x').values('name')",
])('%s orders 5m < 7n < 10.0d', (q) => expect(run(q)).toEqual(['"five"', '"seven"', '"ten"']));

test.each([
  ["g.V().hasLabel('z').values('x').order()", 3],
  ["g.V().hasLabel('z').order().by('x').values('x')", 3],
  ["g.V().hasLabel('z').order().by(values('x'), desc).values('x')", 3],
  ["g.V().hasLabel('o').values('x').order()", 2],
  ["g.V().hasLabel('o').order().by('x').values('x')", 2],
] as const)('%s answers every tied value', (q, n) => expect(run(q)).toHaveLength(n));
