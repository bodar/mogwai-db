// THE ONE PACKER — a data-sized set split into values a Durable Object can hold.
//
// The bind-count rule (root CLAUDE.md) puts every data-sized set into ONE `json_each(?)` value, which makes
// that value's SIZE the next wall: a DO caps one string/BLOB value at 2 MB (`do-limits.ts`). So a set past
// the cap crosses as several values, packed here at MEMBER boundaries, and its reader explodes each under
// `UNION ALL`. Three readers, one packer, so a set splits the same way wherever it crosses:
//   - the json_each builder (`compiler/rel/build.ts` `jsonEachRelation`) — a parameter, a landing, a value stream,
//     and a collection parameter's member explode (`explodeMembers`, the one `unfold()` explode);
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
  // An array member `JSON.stringify` cannot spell (`undefined`) is `null`, as in the whole-array spelling.
  return packMembers(members.map((member) => stringifyExact(member) ?? 'null'));
}

/**
 * An ALREADY-SPELLED JSON array, packed exactly as `jsonChunks` packs a set — for a producer that holds the
 * array as TEXT (a collection parameter's cell, spelled once by its literal encoder), where re-parsing and
 * re-writing it would re-spell its members (`1.0` would come back `1`, a Double an Int). The members are cut
 * out of the text verbatim, so the chunks hold the very bytes the whole held. Under the cap it is the text
 * itself; and since `stringifyExact(members)` IS its members' spellings joined by commas, one set packs to
 * the same chunks whichever entry point it arrives through — which is what lets two uses of one parameter
 * (an `inject($xs)` cell and a `within($xs)` set) share their chunk binds by name.
 */
export function jsonTextChunks(arrayText: string): readonly JsonChunk[] {
  if (fitsUtf8(arrayText, CF_MAX_VALUE_BYTES)) return [{ text: arrayText, offset: 0 }];
  return packMembers(jsonArrayMembers(arrayText));
}

/** The greedy packer behind both entry points: member texts, in order, into chunks of at most one DO value. */
function packMembers(texts: readonly string[]): readonly JsonChunk[] {
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
  for (const text of texts) {
    const size = utf8Bytes(text);
    // `bytes` is the open chunk's spelled size: its brackets, its members, and a comma between each two.
    if (open.length && bytes + 1 + size > CF_MAX_VALUE_BYTES) close();
    bytes += (open.length ? 1 : 0) + size;
    open.push(text);
  }
  close();
  return chunks;
}

/**
 * The top-level members of a JSON ARRAY text, each cut out verbatim — one linear scan that tracks string
 * and nesting state, so a comma inside a string or a nested value is not a boundary. Whitespace around a
 * member is dropped (our writers emit none). The input is JSON this process wrote; a text that is not an
 * array is a programming error, and says so rather than mis-splitting.
 */
export function jsonArrayMembers(arrayText: string): string[] {
  const text = arrayText.trim();
  if (text[0] !== '[' || text[text.length - 1] !== ']') throw new Error('jsonArrayMembers: not a JSON array text');
  const members: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 1;
  const cut = (end: number): void => {
    const member = text.slice(start, end).trim();
    if (member) members.push(member);
  };
  for (let at = 1; at < text.length - 1; at++) {
    const c = text.charCodeAt(at);
    if (inString) {
      if (c === 0x5c) at++; // a backslash escapes the next unit, a quote included
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) depth++;
    else if (c === 0x5d || c === 0x7d) depth--;
    else if (c === 0x2c && depth === 0) { cut(at); start = at + 1; }
  }
  cut(text.length - 1);
  return members;
}
