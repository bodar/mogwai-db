// THE PRESENCE TAG (src/compiler/rel/tag.ts, docs/2026-11-05-presence-is-the-tag-plan.md P2): a child
// body's TOTAL type tag, read by its host as "did the body produce" — `tag IS NOT NULL`. The tag is a
// BRANDED Expr: only the module's three constructors mint one, and each builds it where it is true —
// inside the body's row (`staticTag`, `rowTag`) or gated on a may-be-absent arm's presence (`gatedTag`).
// These pin the constructors' contract and the `{ tag }` arm every presence consumer reads it through.
import { describe, expect, test } from 'bun:test';
import { gatedTag, rowTag, staticTag, type PresenceTag } from '../../src/compiler/rel/tag.ts';
import { ALWAYS_PRODUCTIVE, presenceOf, restated, statedPresence, statedWhen } from '../../src/compiler/rel/child.ts';
import { productivityFilter } from '../../src/compiler/rel/modulator.ts';
import { col, compilerText, type Expr } from '../../src/rel/expr.ts';
import type { Rel } from '../../src/rel/rel.ts';
import type { IRStep } from '../../src/compiler/ir/step.ts';
import { relId } from '../../src/rel/types.ts';

const value: Expr = col(relId('r'), 'v');
const vtype: Expr = col(relId('r'), 'vtype');
const subquery: Expr = { kind: 'scalar', plan: {} as Rel };
const isNotNull = (e: Expr): Expr => ({ kind: 'binary', op: 'is not', left: e, right: expect.anything() as unknown as Expr });

describe('the constructors', () => {
  test('a static tag is its literal, built in the body row', () => {
    expect(staticTag('int')).toEqual(compilerText('int') as PresenceTag);
  });

  test('a row tag is TOTAL: a null value is tagged `null`, never left NULL', () => {
    // A total per-row tag (a stored row's vtype) needs only the `'null'` fallback.
    expect(rowTag(value, { kind: 'tag', tag: vtype, nullOnlyForNull: true }))
      .toEqual({ kind: 'call', fn: 'COALESCE', args: [vtype, compilerText('null')] } as Expr as PresenceTag);
    // A partial one is completed from the storage class and then falls back — one flat COALESCE.
    const partial = rowTag(value, { kind: 'tag', tag: vtype })!;
    expect(partial.kind === 'call' && partial.fn === 'COALESCE' && partial.args.length).toBe(3);
    // Static evidence is the static tag.
    expect(rowTag(value, { kind: 'static', tag: 'string' })).toEqual(staticTag('string'));
  });

  test('a row tag REFUSES a value that contains a subquery anywhere — inference outside the body', () => {
    expect(rowTag(subquery, { kind: 'storage' })).toBeNull();
    // Nested, not only at the top: `json_extract((SELECT …), '$.v')`.
    const nested: Expr = { kind: 'call', fn: 'json_extract', args: [subquery, compilerText('$.v')] };
    expect(rowTag(nested, { kind: 'storage' })).toBeNull();
    expect(rowTag(nested, { kind: 'static', tag: 'int' })).toBeNull();
    // A per-row tag read through a subquery is refused too.
    expect(rowTag(value, { kind: 'tag', tag: subquery })).toBeNull();
  });

  test('a gated tag is NULL where its arm is absent, and costs nothing over an always-present one', () => {
    const tag = staticTag('string');
    expect(gatedTag(ALWAYS_PRODUCTIVE, tag)).toBe(tag);
    const present: Expr = col(relId('r'), 'p');
    expect(gatedTag(present, tag)).toEqual({ kind: 'case', whens: [[present, tag]], else: expect.anything() } as unknown as PresenceTag);
  });

  test('a hand-built Expr is not a presence tag (the brand is private to tag.ts)', () => {
    // @ts-expect-error — the `check` gate fails if a plain Expr ever becomes assignable to PresenceTag.
    const forged: PresenceTag = compilerText('int');
    expect(forged).toBeDefined();
  });
});

describe('the { tag } presence arm', () => {
  const tag = staticTag('long');
  test('presence is `tag IS NOT NULL`', () => {
    expect(presenceOf({ tag }, value)).toEqual(isNotNull(tag));
    expect(statedPresence({ tag }, value)).toEqual(isNotNull(tag));
    expect(statedWhen({ tag })).toEqual(isNotNull(tag));
  });
  test('a consumer that projected the predicate reads it back off its column', () => {
    const pw = col(relId('r'), 'pw');
    expect(restated({ tag }, pw)).toEqual({ when: pw });
    expect(restated({ when: vtype, orValue: true }, pw)).toEqual({ when: pw, orValue: true });
  });
  test('productivityFilter takes a bare { tag } presence, not as a { present } wrapper', () => {
    const step = { name: 'order', args: [] } as unknown as IRStep;
    expect(productivityFilter(step, { tag }, value)).toEqual({ keep: isNotNull(value) });
    expect(productivityFilter(step, { present: { tag } }, value)).toEqual({ keep: isNotNull(value) });
  });
});
