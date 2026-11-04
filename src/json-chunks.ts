// THE ONE PACKER — a data-sized set split into values a Durable Object can hold.
//
// The bind-count rule (root CLAUDE.md) puts every data-sized set into ONE `json_each(?)` value, which makes
// that value's SIZE the next wall: a DO caps one string/BLOB value at 2 MB (`do-limits.ts`). So a set past
// the cap crosses as several values, packed here at MEMBER boundaries, and its reader explodes each under
// `UNION ALL`. Three readers, one packer, so a set splits the same way wherever it crosses:
//   - the json_each builder (`compiler/rel/build.ts` `jsonEachRelation`) — a parameter, a landing, a value stream;
//   - the direct set-based statements (`setwrite.ts`);
//   - the binding executor (`program.ts` `runSteps`) — a statement's RETAINED rows, packed at RUN time
//     because only then is their size known.
//
// Runtime-neutral on purpose: it depends on the JSON writer and the platform numbers and nothing else, so
// the executor — the half that runs on the DO — does not pull the algebra or the emitter in to reach it.
import { stringifyExact } from './json-exact.ts';
import { CF_MAX_VALUE_BYTES, fitsUtf8, utf8Bytes } from './do-limits.ts';

/** One `json_each` value of a split set: its JSON array text and the index of its first member in the whole. */
export interface JsonChunk { readonly text: string; readonly offset: number }

/**
 * A data-sized set's members as JSON array texts, each at most a DO value (`CF_MAX_VALUE_BYTES`, UTF-8),
 * packed greedily in order. `stringifyExact` is the writer. A set under the cap is ONE chunk spelled
 * exactly as `stringifyExact(members)` spells the whole array — so every plan a test graph makes is
 * unchanged. A member that is alone past the cap is its own chunk — the platform's limit, not a split we
 * can make (there is no partial-member reassembly; a DO refuses it as its own per-value limit, which
 * `GraphStore.query` words in the user's terms).
 */
export function jsonChunks(members: readonly unknown[]): readonly JsonChunk[] {
  const whole = stringifyExact(members);
  if (fitsUtf8(whole, CF_MAX_VALUE_BYTES)) return [{ text: whole, offset: 0 }];
  const chunks: JsonChunk[] = [];
  let open: string[] = [];
  let bytes = 2;
  let offset = 0;
  const close = (): void => {
    if (open.length) chunks.push({ text: `[${open.join(',')}]`, offset });
    offset += open.length;
    open = [];
    bytes = 2;
  };
  for (const member of members) {
    // An array member `JSON.stringify` cannot spell (`undefined`) is `null`, as in the whole-array spelling.
    const text = stringifyExact(member) ?? 'null';
    const size = utf8Bytes(text);
    // `bytes` is the open chunk's spelled size: its brackets, its members, and a comma between each two.
    if (open.length && bytes + 1 + size > CF_MAX_VALUE_BYTES) close();
    bytes += (open.length ? 1 : 0) + size;
    open.push(text);
  }
  close();
  return chunks;
}
