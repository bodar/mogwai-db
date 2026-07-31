// Neptune / Neo4j CSV with typed headers — reader and writer. **INTEROP ONLY.**
//
// Design: docs/archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md §4/§4b, phase 6. The scope line is
// the important one and it is a decision, not an oversight: **this is not a backup format.** Typed
// GraphSON is lossless over our whole type channel (17 canonical types for 17, nesting with per-leaf
// types, typed `g:Map` keys, meta-properties), so the export/backup job is already done by
// `formats/graphson.ts`. What CSV buys is the one thing GraphSON cannot: a graph produced by, or
// consumable by, Amazon Neptune's bulk loader and `neo4j-admin import`. Its losses stop mattering
// once it is not also the backup path — and they are named, asserted and fail-closed here rather
// than left to be discovered.
//
// WHAT CSV CANNOT CARRY, and what each case does:
//
//  | our type / shape                            | CSV                     | this module        |
//  |---------------------------------------------|-------------------------|--------------------|
//  | string boolean byte short int long float double datetime | a native column type | round-trips  |
//  | bigint bigdecimal uuid char duration        | no column type exists   | WIDENED to String  |
//  | list/map/set VALUE (a typed collection)     | nothing                 | FAILS CLOSED       |
//  | meta-properties (`gcrew`)                   | nothing                 | FAILS CLOSED       |
//
// The split is the project's fail-closed rule applied twice, and the difference between the two rows
// is whether the loss is VISIBLE IN THE FILE. A widened scalar is declared in the header as
// `String`, so a reader is told exactly what it is getting and the text itself is exact — that is
// interop, not a wrong answer. A collection or a meta-property has no honest column at all: writing
// one would mean inventing a convention (a homegrown format inside a standard one, which §4's
// "no homegrown format" excludes) and reading it back would silently produce a DIFFERENT graph — a
// `list`-valued property and a multi-property are not the same thing. So those name the element,
// the key and GraphSON, and stop.
//
// TWO DIALECTS ON READ, ONE ON WRITE. Reading accepts Neptune (`~id`, `~label`, `~from`, `~to`) and
// Neo4j (`:ID`, `:LABEL`, `:START_ID`, `:END_ID`, `:TYPE`) headers, because interop means reading
// whatever the other tool wrote; writing emits Neptune. Neo4j's header vocabulary is the wider of
// the two (it has `char` and `duration`, which Neptune lacks), so an inbound Neo4j file keeps types
// our own output has to widen — the asymmetry is theirs, not ours.
//
// TWO FILES, and that is the format's shape rather than a choice: a vertex file and an edge file
// have different system columns, so they cannot share a header. `io("x.csv").read()` reads ONE file
// and detects which it is from the header; `io("x.csv").write()` emits BOTH, at the derived keys
// `csvPaths` names — and those derived keys are ordinary readable paths, so the round trip is two
// reads with nothing magic in between.
import { BulkLoader, type BulkEdge, type BulkProperty, type BulkStats } from '../bulk.ts';
import type { GraphStore } from '../storage.ts';
import { BigDecimal, Duration, exactInteger, type CanonicalType } from '../gremlin/types.ts';
import { keysetPages } from '../rowbatch.ts';
import { groupByOwner, rowsForOwners } from './drain.ts';

// ---------- RFC 4180 ----------

/**
 * One parsed field. `null` is the load-bearing part: an UNQUOTED empty field means the property is
 * ABSENT, a QUOTED empty field (`""`) means it is present and empty.
 *
 * Both spellings are an empty field to RFC 4180, and every CSV graph format treats a blank cell as
 * "no value" — which would make an empty-string property vanish on a round trip. Keeping the
 * quoted/unquoted distinction costs one boolean in the scanner and makes `property('x','')`
 * survive; a vendor file's blank cell still reads as absent, because a vendor writing an empty
 * string does not quote it either.
 */
export type CsvField = string | null;

/**
 * Scan a whole document into records. A generator, so a reader never holds more than one record
 * beyond what it has already landed.
 *
 * Cannot be `split('\n')`: a quoted field may CONTAIN a newline (RFC 4180 §2.6), so records are only
 * discoverable by scanning. `\r\n` and `\n` both terminate a record; a `\r` inside a quoted field is
 * kept verbatim.
 */
export function* csvRecords(text: string): Generator<CsvField[]> {
  let record: CsvField[] = [];
  let field = '';
  let quoted = false;      // this field was opened with a quote
  let inQuotes = false;
  let started = false;     // anything at all seen since the last delimiter (an empty last line is not a record)
  const endField = () => { record.push(quoted || field.length ? field : null); field = ''; quoted = false; };
  const endRecord = () => { endField(); const r = record; record = []; started = false; return r; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      // A doubled quote inside a quoted field is one literal quote; a single quote closes it.
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && !field.length) { inQuotes = true; quoted = true; started = true; continue; }
    if (c === ',') { endField(); started = true; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (started || record.length) yield endRecord();
      continue;
    }
    field += c;
    started = true;
  }
  if (started || record.length) yield endRecord();
}

/** One record → its CSV line. A field is quoted when it must be (a delimiter, a quote, a newline, or
 *  surrounding space) and when it is an EMPTY STRING, which is what carries the present/absent
 *  distinction `CsvField` documents. `null` renders as nothing at all. */
export function csvLine(fields: readonly CsvField[]): string {
  return fields.map((f) => {
    if (f === null) return '';
    if (f === '' || /[",\r\n]/.test(f) || f !== f.trim()) return `"${f.replace(/"/g, '""')}"`;
    return f;
  }).join(',');
}

// ---------- the header vocabulary ----------

/** CSV column type names → our canonical types. Neptune's are capitalized, Neo4j's lower-case, and
 *  both are accepted case-insensitively (the lookup lower-cases), so ONE table serves both dialects.
 *
 *  Deliberately NOT extended with names for the five types we have to widen: a `uuid:` or
 *  `duration:`-style column of our own invention would look standard and load nowhere, which is a
 *  worse outcome than the declared `String` widening. Neo4j's `duration`/`char` are here because
 *  they are ITS names, not ours. Its spatial/partial-time types (`point`, `time`, `localtime`) have
 *  no canonical type at all, so they fail closed as unknown. */
const CSV_TYPES: Record<string, CanonicalType> = {
  string: 'string',
  bool: 'boolean', boolean: 'boolean',
  byte: 'byte', short: 'short', int: 'int', integer: 'int', long: 'long',
  float: 'float', double: 'double',
  char: 'char',
  date: 'datetime', datetime: 'datetime', localdatetime: 'datetime',
  duration: 'duration',
};

/** The inverse, for the writer: Neptune's spellings. The five absent types are the widened set. */
const CSV_NAMES: Partial<Record<CanonicalType, string>> = {
  string: 'String', boolean: 'Bool', byte: 'Byte', short: 'Short', int: 'Int', long: 'Long',
  float: 'Float', double: 'Double', datetime: 'DateTime',
};

/** The types with no CSV column type, which the writer declares as `String`. Exact as TEXT in every
 *  case (that is why the widening is honest) but read back as `string` — the documented loss. */
const WIDENED = new Set<CanonicalType>(['bigint', 'bigdecimal', 'uuid', 'char', 'duration']);

/** A file is a vertex file or an edge file; the header says which. */
type CsvKind = 'vertices' | 'edges';

/** What one header cell means. `ignore` covers the columns a vendor file carries and we do not need
 *  (`~fromLabels`, Neo4j's `:IGNORE`, an unnamed trailing column). */
type SystemRole = 'id' | 'label' | 'from' | 'to' | 'ignore';
type Column =
  | { role: SystemRole }
  | { role: 'property'; key: string; type: CanonicalType; array: boolean };

/** Neptune / Neo4j system columns, both dialects in one map — the two vocabularies never collide, so
 *  a file may not mix them but this table needs no dialect flag to read either. */
const SYSTEM_COLUMNS: Record<string, SystemRole> = {
  '~id': 'id', '~label': 'label', '~from': 'from', '~to': 'to',
  '~fromlabels': 'ignore', '~tolabels': 'ignore',
  ':id': 'id', ':label': 'label', ':start_id': 'from', ':end_id': 'to', ':type': 'label',
  ':ignore': 'ignore',
};

/**
 * Parse one header cell.
 *
 * A property column is `key:Type`, `key:Type[]` (a `;`-separated array — Neptune's and Neo4j's
 * multi-value form) or `key:Type(single|set)` (Neptune's cardinality suffix, read for its TYPE and
 * otherwise ignored: TinkerPop's single/list/set cardinality is not something our schema records —
 * a multi-property IS several rows — so honoring it would mean claiming a fidelity we do not have).
 * A bare `key` with no type is `String`, which is what both loaders default to.
 */
function headerColumn(cell: string): Column {
  // Neo4j writes `personId:ID(Group)` / `:START_ID(Group)`: a system column may carry a NAME before
  // the token (the name is for a human, the token is the meaning) and a group qualifier after it (an
  // import-time namespace for id uniqueness, not part of the id). Both are stripped before the
  // lookup, and the token is matched on the `:token` SUFFIX so `personId:ID` resolves like `:ID`.
  const name = cell.trim().replace(/\(.*\)$/, '');
  const colonAt = name.indexOf(':');
  const system = SYSTEM_COLUMNS[name.toLowerCase()]
    ?? (colonAt === -1 ? undefined : SYSTEM_COLUMNS[name.slice(colonAt).toLowerCase()]);
  if (system) return { role: system };
  if (!name) return { role: 'ignore' };
  const colon = colonAt;
  const key = colon === -1 ? name : name.slice(0, colon);
  let spec = colon === -1 ? 'string' : name.slice(colon + 1);
  const array = spec.endsWith('[]');
  if (array) spec = spec.slice(0, -2);
  spec = spec.replace(/\((?:single|set|list)\)$/i, '');
  const type = CSV_TYPES[spec.toLowerCase() || 'string'];
  if (!type)
    throw new Error(`CSV: unknown column type "${spec}" in header "${cell}" `
      + `(known: ${Object.keys(CSV_TYPES).sort().join(', ')})`);
  if (!key) throw new Error(`CSV: header "${cell}" declares a type with no property name`);
  return { role: 'property', key, type, array };
}

/** An array cell → its values. `\;` is a literal semicolon and `\\` a literal backslash (Neptune's
 *  escape), so a value containing the delimiter survives; `renderArray` is the exact inverse. */
function splitArray(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && (text[i + 1] === ';' || text[i + 1] === '\\')) { cur += text[++i]; continue; }
    if (c === ';') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const renderArray = (values: readonly string[]): string =>
  values.map((v) => v.replace(/\\/g, '\\\\').replace(/;/g, '\\;')).join(';');

// ---------- the reader ----------

/**
 * One cell's text → the JS carrier its declared type wants, matching exactly what the wire
 * front-end produces for the same type (so a CSV load stores what a client write would).
 *
 * Fails closed on text the type cannot hold. A `NaN` in an `Int` column is the CSV equivalent of a
 * silent wrong answer: it would land as a property whose value is not a number at all.
 */
function csvScalar(type: CanonicalType, text: string): unknown {
  switch (type) {
    case 'boolean': {
      const t = text.toLowerCase();
      if (t === 'true' || t === '1') return true;
      if (t === 'false' || t === '0') return false;
      throw new Error(`CSV: "${text}" is not a Bool`);
    }
    // A Long may exceed 2^53; `exactInteger` picks the narrowest carrier that holds it exactly,
    // which is the same call the GraphSON reader and the bind seam make.
    case 'byte': case 'short': case 'int': case 'long': return exactInteger(digits(type, text));
    case 'float': case 'double': {
      const n = Number(text);
      if (!Number.isFinite(n)) throw new Error(`CSV: "${text}" is not a ${type}`);
      return n;
    }
    // A bigint keeps its bigint carrier whatever its magnitude, as the GraphSON reader does: it is
    // `coerceBindValue` that decides number-vs-decimal-TEXT at the bind, not the reader.
    case 'bigint': return BigInt(digits(type, text));
    case 'bigdecimal': return BigDecimal.from(text);
    // Internally a datetime is epoch-millis (gremlin/types leafStore, and the `datetime('…')` literal).
    case 'datetime': {
      const ms = Date.parse(text);
      if (Number.isNaN(ms)) throw new Error(`CSV: "${text}" is not a DateTime`);
      return ms;
    }
    case 'duration': return Duration.fromIso(text);
    default: return text;   // string, char, uuid
  }
}

/** Integer digits, or a throw naming the column type. */
function digits(type: CanonicalType, text: string): string {
  const t = text.trim();
  if (!/^[-+]?\d+$/.test(t)) throw new Error(`CSV: "${text}" is not a ${type}`);
  return t;
}

/** An element id from the file: DECIMAL TEXT becomes the rowid, anything else a `uid`.
 *
 *  The same rule `formats/graphson.ts` follows and the same one `BulkVertex.id` documents, applied
 *  to text — and it is what makes OUR OWN round trip id-exact, since a drain writes
 *  `COALESCE(uid,id)` and a seeded graph's ids are `1`, `2`, … The cost is that a Neptune file whose
 *  ids happen to be numeric strings lands them as integer ids rather than as the strings Neptune
 *  considers them; the graph is the same shape either way, and preserving our own ids is worth more
 *  than preserving a vendor's id TYPE. */
const csvId = (text: string): number | string => (/^\d+$/.test(text) ? Number(text) : text);

/** `;`-separated labels, both dialects. Empty = a vertex with no labels, which `vertex_labels`
 *  represents natively (and only `LabelCardinality.ZERO_OR_MORE` accepts). */
const csvLabels = (text: CsvField): string[] =>
  text === null || text === '' ? [] : splitArray(text).filter((l) => l.length);

/** Which kind of file this header describes: the presence of BOTH endpoint columns. A file with one
 *  of them is malformed, and saying so beats loading half an edge list as vertices. */
function kindOf(columns: readonly Column[], header: readonly CsvField[]): CsvKind {
  const roles = new Set(columns.map((c) => c.role));
  if (roles.has('from') && roles.has('to')) return 'edges';
  if (roles.has('from') || roles.has('to'))
    throw new Error(`CSV: header has one endpoint column but not the other (${header.join(',')})`);
  if (!roles.has('id'))
    throw new Error('CSV: header has no id column — expected Neptune "~id" or Neo4j ":ID"');
  return 'vertices';
}

/** Every property a record carries, in header order. An ARRAY column contributes one property
 *  INSTANCE per value, which is exactly a multi-property; a non-array column contributes one. */
function recordProperties(columns: readonly Column[], record: readonly CsvField[]): BulkProperty[] {
  const out: BulkProperty[] = [];
  columns.forEach((col, i) => {
    if (col.role !== 'property') return;
    const cell = record[i] ?? null;
    if (cell === null) return;                 // absent, not empty — see CsvField
    for (const text of col.array ? splitArray(cell) : [cell])
      out.push({ key: col.key, value: csvScalar(col.type, text), vtype: col.type });
  });
  return out;
}

/** The one cell a role must have. */
function required(record: readonly CsvField[], columns: readonly Column[], role: 'id' | 'label' | 'from' | 'to'): CsvField {
  const i = columns.findIndex((c) => c.role === role);
  return i === -1 ? null : record[i] ?? null;
}

/**
 * Load ONE CSV document — a vertex file or an edge file, decided by its header.
 *
 * Streams: `csvRecords` yields one record at a time and the loader buffers rows, so peak memory is
 * the loader's batches rather than the document.
 *
 * An edge file may be loaded on its own, after its vertex file: an endpoint this call has not seen
 * resolves against the store at `flush` (`BulkLoader.resolveEndpoint`) and fails closed naming the
 * vertex if it is not there either. That is the whole reason the two files need no shared state.
 *
 * Fails closed with the RECORD NUMBER, for the same reason the GraphSON reader does: a partially
 * loaded graph is only diagnosable if the failure says where it stopped.
 */
export function loadCsv(store: GraphStore, document: string): BulkStats {
  const loader = new BulkLoader(store);
  let columns: Column[] | undefined;
  let kind: CsvKind | undefined;
  let n = 0;
  for (const record of csvRecords(document)) {
    n++;
    if (!columns) {
      columns = record.map((cell) => headerColumn(cell ?? ''));
      kind = kindOf(columns, record);
      continue;
    }
    try {
      const id = required(record, columns, 'id');
      const properties = recordProperties(columns, record);
      if (kind === 'vertices') {
        loader.vertex({
          id: id === null ? undefined : csvId(id),
          labels: csvLabels(required(record, columns, 'label')),
          properties,
        });
      } else {
        const from = required(record, columns, 'from');
        const to = required(record, columns, 'to');
        if (from === null || to === null) throw new Error('edge record has an empty endpoint');
        const label = required(record, columns, 'label');
        if (label === null || label === '') throw new Error('edge record has no label');
        const edge: BulkEdge = {
          id: id === null ? undefined : csvId(id),
          label, src: csvId(from), tgt: csvId(to), properties,
        };
        loader.edge(edge);
      }
    } catch (e) {
      throw new Error(`CSV record ${n}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!columns) throw new Error('CSV: empty document (no header)');
  return loader.flush();
}

// ---------- the writer ----------

interface PropRow { id: number; owner: number; key: string; value: unknown; vtype: string | null; meta: string | null }

/** One property column of the output: a (key, type) pair the graph actually contains. */
interface PropColumn { key: string; vtype: CanonicalType | null; array: boolean; header: string }

/**
 * The property columns of one table, from the data.
 *
 * A CSV header is per-FILE, so the column set has to be known before the first row — which is the
 * one thing about this format that is not streamable. It costs ONE statement, not a pre-pass over
 * the rows: the distinct (key, vtype) pairs, plus whether any single owner has more than one
 * instance of a pair (which is what decides an `[]` array column).
 *
 * A key with more than one canonical type across the graph gets ONE COLUMN PER TYPE. The header
 * stays unique, each row fills only its own type's column, and no row loses its type — where
 * widening the whole column to `String` would lose it for every row that had one. It is also the
 * point at which an export stops being portable, since both vendors key a property by name alone;
 * that is a property of a heterogeneous graph, not of this writer.
 */
function propColumns(store: GraphStore, table: 'vertex_properties' | 'edge_properties', owner: string): PropColumn[] {
  const rows = store.query<{ key: string; vtype: string | null; most: number }>(
    `SELECT key, vtype, max(n) AS most FROM
       (SELECT ${owner} AS owner, key, vtype, count(*) AS n FROM ${table} GROUP BY ${owner}, key, vtype)
     GROUP BY key, vtype ORDER BY key, vtype`);
  return rows.map(({ key, vtype, most }) => {
    const canonical = (vtype ?? null) as CanonicalType | null;
    const array = most > 1;
    return { key, vtype: canonical, array, header: `${key}:${csvTypeName(key, canonical)}${array ? '[]' : ''}` };
  });
}

/** The CSV type name for a stored `vtype`. A collection FAILS CLOSED here — at header time, before
 *  a single row is drained, which is where the caller can still do something about it. An UNTYPED
 *  column (`vtype` NULL — the type channel said nothing) declares `String`, the same default both
 *  loaders apply to an untyped header. */
function csvTypeName(key: string, vtype: CanonicalType | null): string {
  if (vtype === null) return 'String';
  if (vtype === 'list' || vtype === 'map' || vtype === 'set')
    throw new Error(`CSV: property "${key}" holds a ${vtype}, which no CSV column type can carry — `
      + 'export as typed GraphSON (.json), which round-trips nesting and per-leaf types');
  if (WIDENED.has(vtype)) return 'String';
  const name = CSV_NAMES[vtype];
  if (!name) throw new Error(`CSV: no column type for "${vtype}" (property "${key}")`);
  return name;
}

/** One stored scalar → its CSV text. The inverse of `csvScalar`, and exact in every case including
 *  the widened five — a widened value loses its TYPE TAG, never its digits or characters. */
function csvText(vtype: CanonicalType | null, stored: unknown): string {
  switch (vtype) {
    // Stored as 1/0 (coerceBindValue — DO SQLite rejects a boolean bind).
    case 'boolean': return stored === 1 || stored === true ? 'true' : 'false';
    case 'datetime': return new Date(Number(stored)).toISOString();
    // Stored as total nanos; every external format spells a duration ISO-8601.
    case 'duration': return Duration.from(String(stored)).toIso();
    default: return String(stored);
  }
}

/** One element's cells for the property columns, or a throw for a meta-property.
 *
 *  Meta-properties are the second fail-closed case and the reason `gcrew` cannot go through CSV:
 *  neither vendor's format has any representation for a property ON a property, so there is nowhere
 *  to put one and dropping it silently would export a graph that is not this graph. */
function propCells(columns: readonly PropColumn[], rows: readonly PropRow[], element: string): CsvField[] {
  for (const r of rows)
    if (r.meta !== null)
      throw new Error(`CSV: ${element} property "${r.key}" carries meta-properties, which no CSV `
        + 'format represents — export as typed GraphSON (.json), which nests them inside the VertexProperty');
  return columns.map((col) => {
    const values = rows.filter((r) => r.key === col.key && (r.vtype ?? null) === col.vtype)
      .map((r) => csvText(col.vtype, r.value));
    if (!values.length) return null;                       // absent — an unquoted empty cell
    return col.array ? renderArray(values) : values[0];
  });
}

/**
 * Drain the vertices as Neptune CSV — the header line, then one line per vertex.
 *
 * Streaming past the header, by the same argument as the GraphSON writer: keyset pages over `nodes`,
 * and each page reads its labels and properties in bind-bounded chunks (`rowsForOwners`). Peak
 * memory is one page plus the column set.
 */
export function* csvVertexLines(store: GraphStore, pageSize = 200): Generator<string> {
  const columns = propColumns(store, 'vertex_properties', 'node');
  yield csvLine(['~id', '~label', ...columns.map((c) => c.header)]);
  for (const page of keysetPages<{ id: number; uid: string | null }>(store, 'nodes', ['id', 'uid'], pageSize)) {
    const ids = page.map((v) => v.id);
    const labels = groupByOwner(rowsForOwners<{ owner: number; name: string }>(store,
      (ph) => `SELECT vl.node AS owner, l.name AS name FROM vertex_labels vl JOIN labels l ON l.id = vl.label
               WHERE vl.node IN (${ph}) ORDER BY vl.node, vl.label`, ids));
    const props = groupByOwner(rowsForOwners<PropRow>(store,
      (ph) => `SELECT id, node AS owner, key, value, vtype,
                      CASE WHEN meta IS NULL THEN NULL ELSE json(meta) END AS meta
               FROM vertex_properties WHERE node IN (${ph}) ORDER BY node, id`, ids));
    for (const v of page) {
      const ext = String(v.uid ?? v.id);
      yield csvLine([
        ext,
        renderArray((labels.get(v.id) ?? []).map((l) => l.name)),
        ...propCells(columns, props.get(v.id) ?? [], `vertex ${ext}`),
      ]);
    }
  }
}

/** Drain the edges as Neptune CSV. Endpoints are written as the vertices' EXTERNAL ids
 *  (`COALESCE(uid,id)`), which is what the vertex file's `~id` column carries, so the two files
 *  agree without either of them knowing about rowids. */
export function* csvEdgeLines(store: GraphStore, pageSize = 200): Generator<string> {
  const columns = propColumns(store, 'edge_properties', 'edge');
  yield csvLine(['~id', '~from', '~to', '~label', ...columns.map((c) => c.header)]);
  const labelNames = new Map<number, string>();
  const extIds = new Map<number, string>();
  for (const page of keysetPages<{ id: number; uid: string | null; src: number; label: number; tgt: number }>(
    store, 'edges', ['id', 'uid', 'src', 'label', 'tgt'], pageSize)) {
    // Two lookups per page, both over a chunked id set and both cached ACROSS pages: a graph has few
    // distinct labels, and an endpoint recurs constantly.
    fill(store, 'labels', 'name', page.map((e) => e.label), labelNames);
    fill(store, 'nodes', 'COALESCE(uid, id)', [...page.map((e) => e.src), ...page.map((e) => e.tgt)], extIds);
    const props = groupByOwner(rowsForOwners<PropRow>(store,
      (ph) => `SELECT id, edge AS owner, key, value, vtype, NULL AS meta FROM edge_properties
               WHERE edge IN (${ph}) ORDER BY edge, id`, page.map((e) => e.id)));
    for (const e of page) {
      const ext = String(e.uid ?? e.id);
      yield csvLine([
        ext, extIds.get(e.src)!, extIds.get(e.tgt)!, labelNames.get(e.label)!,
        ...propCells(columns, props.get(e.id) ?? [], `edge ${ext}`),
      ]);
    }
  }
}

/** Cache-filling lookup: read only the ids not already known, chunked. */
function fill(store: GraphStore, table: string, expr: string, ids: readonly number[], into: Map<number, string>): void {
  const missing = [...new Set(ids.filter((id) => !into.has(id)))];
  if (!missing.length) return;
  for (const row of rowsForOwners<{ owner: number; v: string | number }>(store,
    (ph) => `SELECT id AS owner, ${expr} AS v FROM ${table} WHERE id IN (${ph})`, missing))
    into.set(row.owner, String(row.v));
}

/** The two documents of one CSV export. */
export interface CsvDump { vertices: string; edges: string }

/** The whole graph as a vertex document and an edge document. A caller streaming to a sink should
 *  iterate `csvVertexLines`/`csvEdgeLines` instead of joining. */
export const writeCsv = (store: GraphStore, pageSize?: number): CsvDump => ({
  vertices: [...csvVertexLines(store, pageSize)].join('\n'),
  edges: [...csvEdgeLines(store, pageSize)].join('\n'),
});

/**
 * The two keys `io("<path>").write()` writes, derived from one path.
 *
 * A trailing `-vertices`/`-edges` on the stem is stripped first, so writing to a key this function
 * produced derives the same pair rather than `-vertices-vertices.csv` — i.e. the derivation is
 * idempotent, which matters because those keys are what a user has in hand after an export.
 */
export function csvPaths(path: string): CsvDump {
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const ext = dot > slash ? path.slice(dot) : '';
  const stem = (dot > slash ? path.slice(0, dot) : path).replace(/-(vertices|edges)$/, '');
  return { vertices: `${stem}-vertices${ext}`, edges: `${stem}-edges${ext}` };
}
