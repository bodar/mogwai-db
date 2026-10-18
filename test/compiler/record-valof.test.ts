// `recordValOf` (src/compiler/rel/record.ts) is the ONE authority for what a project() record's MAP holds
// on its value side once it collapses (fold/unfold/as/union demotion/a group member). It must never claim
// `scalar` for an element field: the scalar side decodes `{t,v}` into a per-row value, and an element node
// decoded that way framed the vertex as a JSON string or failed to parse — an internal error L5 drew at
// seed 0x84ce2d9 (`…project('a','b').by(identity())…fold().order(local).unfold().select('b')…`).
import { test, expect, describe } from 'bun:test';
import { recordValOf } from '../../src/compiler/rel/record.ts';
import type { RecordField, RelFraming } from '../../src/compiler/rel/framing.ts';
import { STATIC, TYPED_MEMBERS } from '../../src/sql/kernel/render.ts';

const field = (key: string, framing: RelFraming): RecordField =>
  ({ key, prefix: `f_${key}`, framing, optional: false });
const vertex: RelFraming = { kind: 'elements', elem: 'vertex' };
const edge: RelFraming = { kind: 'elements', elem: 'edge' };
const name: RelFraming = { kind: 'scalar', type: STATIC('string') };
const list: RelFraming = { kind: 'list', of: TYPED_MEMBERS };

describe('recordValOf — a record map never claims a scalar side it cannot decode', () => {
  test('value-only fields keep the scalar side (a list node re-frames by its own tag)', () => {
    expect(recordValOf([field('a', name), field('b', list)])).toEqual({ kind: 'scalar' });
  });
  test('one element kind is the element-node side', () => {
    expect(recordValOf([field('a', vertex), field('b', vertex)])).toEqual({ kind: 'elem', elem: 'vertex' });
  });
  test('an element beside a value is MIXED, so a decoding reader declines', () => {
    expect(recordValOf([field('a', vertex), field('b', name)]))
      .toEqual({ kind: 'mixed', arms: [{ kind: 'elem', elem: 'vertex' }, { kind: 'scalar' }] });
  });
  test('two element kinds are MIXED too', () => {
    expect(recordValOf([field('a', vertex), field('b', edge)]))
      .toEqual({ kind: 'mixed', arms: [{ kind: 'elem', elem: 'vertex' }, { kind: 'elem', elem: 'edge' }] });
  });
});
