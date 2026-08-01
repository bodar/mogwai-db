import type { Service, CallParams } from '../spi/types.ts';
import { IO_SERVICE_NAME } from '../spi/types.ts';
import type { IoStore } from '../../iostore.ts';
import type { GraphStore } from '../../storage.ts';
import { loadGraphson, writeGraphson } from '../../formats/graphson.ts';
import { csvPaths, loadCsv, writeCsv } from '../../formats/csv.ts';

// ---------- mogwai.io — what io() desugars to (async, Barrier, INTERNAL) ----------
//
// `g.io("data/modern.json").read()` is not new machinery: it is async, it collects, and it lowers
// to nothing at compile time — which is exactly `Contribution {kind:'barrier'}`, the shape
// mogwai.graph.federate already occupies, run by the executor's one await. So io() desugars to a
// call() on THIS service (ir/strategies.ts desugarIo) and inherits the whole async seam. The
// alternative — a second async step kind in the compiler — is the thing to avoid.
//
// INTERNAL (`internal: true`): resolvable by name, absent from `--list`. It is sugar's backing
// service, not part of the reference provider surface the official g_call/g_callXlistX scenarios
// assert, so it must be registered in BOTH registries and visible in neither.
//
// Both dependencies arrive at CONSTRUCTION off the app scope — the IoStore (where documents live)
// and this graph's rows. That is the whole point of the DI consolidation
// (docs/archive/2026-07-31-di-scopes-and-services-plan.md): `apply` needs no wider contract, because a
// service is not a module-level constant that can depend on nothing.

// The name itself lives in spi/types.ts (a dependency-free leaf), so the desugaring Pass in the
// compiler core can reach it without importing this module.
export { IO_SERVICE_NAME } from '../spi/types.ts';

/** `read` loads a document INTO this graph; `write` dumps this graph OUT to one. */
export type IoDirection = 'read' | 'write';

/** The `direction` param desugarIo stamps on the call. Present on every io() call by
 *  construction, so an absent/other value means someone called the service by hand. */
function directionOf(params: CallParams): IoDirection {
  const d = params.direction;
  if (d === 'read' || d === 'write') return d;
  throw new Error(`${IO_SERVICE_NAME}: a "direction" param of "read" or "write" is required`);
}

function pathOf(params: CallParams): string {
  const p = params.path;
  if (typeof p !== 'string' || p.length === 0)
    throw new Error(`${IO_SERVICE_NAME}: a "path" param (the document to read or write) is required`);
  return p;
}

/** `.with(IO.reader, …)` / `.with(IO.writer, …)` — a DECLARED format, overriding the extension.
 *  The front-end resolves the `IO.*` tokens to these exact strings (the GLV's own wire form). */
const READER_KEY = '~tinkerpop.io.reader';
const WRITER_KEY = '~tinkerpop.io.writer';

/** The formats this service serves. */
type Codec = 'graphson' | 'csv';

/** The format a path implies. `.json`/`.xml`/`.kryo` are TinkerPop's own extensions, so they name the
 *  same three formats the reference provider resolves them to; `.csv` is ours to define, since neither
 *  TinkerPop nor its `IO` enum has a CSV format at all (plan doc §3 — the io namespace is the
 *  server's). */
function formatOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (ext === '.json') return 'graphson';
  if (ext === '.csv') return 'csv';
  if (ext === '.xml') return 'graphml';
  if (ext === '.kryo') return 'gryo';
  throw new Error(`io("${path}"): unrecognized format "${ext}" — supported: typed GraphSON (.json), Neptune/Neo4j CSV (.csv)`);
}

/** Which codec serves this call: the DECLARED format if `.with(IO.reader|IO.writer, …)` named one,
 *  else the one the extension implies. An unsupported format fails closed NAMING the format —
 *  never a wrong-format parse:
 *   • GraphML is excluded by decision — its `attr.type` admits no date/uuid/nesting/meta, so it is
 *     lossier than CSV, and Workers has no XML DOM to parse it with anyway.
 *   • Gryo is a genuine wall: JVM serialization, not reimplementable without a dependency that
 *     does not exist.
 *  See docs/archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md §4. */
function codecFor(path: string, params: CallParams, direction: IoDirection): Codec {
  const declared = params[direction === 'read' ? READER_KEY : WRITER_KEY];
  const format = typeof declared === 'string' ? declared : formatOf(path);
  if (format === 'graphson') return 'graphson';
  if (format === 'csv') return 'csv';
  if (format === 'graphml')
    throw new Error(`io("${path}"): GraphML is not supported — its attribute types cannot carry date/uuid/nested/meta-property values. Use typed GraphSON (.json)`);
  if (format === 'gryo')
    throw new Error(`io("${path}"): Gryo is not supported — it is JVM serialization. Use typed GraphSON (.json)`);
  throw new Error(`io("${path}"): unrecognized format "${format}" — supported: typed GraphSON (.json), Neptune/Neo4j CSV (.csv)`);
}

/** The io service. `apply` returns NO rows in both directions, which is already the right answer:
 *  a read mutates this graph and the official scenarios assert an empty result, and a write
 *  produces bytes, not traversers. */
export const createIoService = (io: IoStore, store: GraphStore | undefined): Service => ({
  name: IO_SERVICE_NAME,
  type: 'barrier',
  internal: true,
  describeParams: () => ({
    path: 'string — the document to read or write, a key in the server-owned io namespace',
    direction: '"read" (load into this graph) or "write" (dump this graph out)',
  }),
  resolve: ({ params }) => ({
    kind: 'barrier',
    apply: async () => {
      const path = pathOf(params);
      const direction = directionOf(params);
      const codec = codecFor(path, params, direction);   // format check FIRST, so an unsupported one costs no io
      if (!store)
        throw new Error(`io("${path}"): this compile has no graph store behind it (io() needs the executor's data plane)`);
      if (direction === 'read') {
        const document = new TextDecoder().decode(await io.read(path));
        if (codec === 'graphson') loadGraphson(store, document);
        // CSV is TWO documents (a vertex file and an edge file cannot share a header), so a read takes
        // ONE of them and the header says which — load the vertex file first, then the edge file, whose
        // endpoints resolve against the vertices already in the graph.
        else loadCsv(store, document);
      } else if (codec === 'graphson') {
        await io.write(path, new TextEncoder().encode(writeGraphson(store)));
      } else {
        // …and a WRITE has to produce both halves, so it emits them at the two derived keys `csvPaths`
        // names. They are ordinary readable paths, so the round trip is two `read()`s.
        const keys = csvPaths(path);
        const dump = writeCsv(store);
        await io.write(keys.vertices, new TextEncoder().encode(dump.vertices));
        await io.write(keys.edges, new TextEncoder().encode(dump.edges));
      }
      return [];
    },
  }),
});
