import { gremlinTypeOf, mapEntryType, type CanonicalType, type TypeNode } from '../../gremlin/types.ts';
import {
    argValues, isCardinalityArg, isCardinalityValueArg, isDirectionArg, isMergeArg, isNested, isTokenArg,
    stepChain, type Step,
} from '../../gremlin/frontend.ts';
import { validateLabel, validatePropertyKey } from '../../gremlin/validate.ts';
import { LABEL_MUTATION_UNSUPPORTED, type VertexCardinality } from '../../api.ts';
import type { IRStep } from './strategies.ts';
import { elementKindAt, LABEL_MUTATIONS } from './step.ts';

/**
 * WHAT A WRITE STEP'S ARGUMENTS MEAN — the ONE authority, above the routing switch (§6·5).
 *
 * `property(k, v)`, an `addV` label run, a `mergeV`/`mergeE` map and its `option()` arms are all
 * PARSED here and nowhere else. Both spines call these functions, and so does the `verifyWrite`
 * Pass that runs before either of them is chosen — which is the whole reason the module exists
 * separately from the write compilers that used to host it:
 *
 * - **A refusal on the traversal's own TEXT is not a spine's business.** `property()` with an odd
 *   number of meta arguments, a merge map keyed `T.key`, an `option()` whose selector is not
 *   `Merge.onCreate`/`onMatch`, a label that is not a legal identifier — every one of those is an
 *   ERROR, the same error whichever spine would have run the traversal. Raised from a `verify` Pass
 *   they are the answer once; raised from inside a lowering whose contract is `null` they became
 *   `catch { return null }` at every write site, and the census then counted a REFUSED traversal as
 *   an uncovered gap forever. That is what made the coverage counter unable to reach 100%.
 * - **A second parser is a second chance to disagree.** The cardinality position, the `T`-token
 *   forms, a `__.select(<withSideEffect const>)` key, `validateNoOverrides`, `Cardinality.x(v)`
 *   beating an enclosing `option()` default, and the per-argument type channel had already drifted
 *   between two copies inside the legacy file before they were merged. What each route re-expresses
 *   is the EMISSION; nothing here is re-expressed anywhere.
 * - **It survives legacy's deletion.** These functions used to live inside the legacy write
 *   interpreter, which Phase 2.6 removes. What Phase 2.6 deletes is the imperative closure around
 *   the parse, never the parse.
 *
 * PURE: no `Engine`, no `GraphStore`, no SQL. A value that can only be known against the GRAPH
 * (`mergeV`'s `T.id` availability, a label mutation under an immutable cardinality) is deliberately
 * NOT decided here — it is a run-time refusal and belongs to a guard the executor runs.
 *
 * The module sits in the IR tier because the Pass that consumes it does, and because the dependency
 * has to run that way: a step family may import the IR tier, never the reverse.
 */


// A nested `__.select(k)` where k is a withSideEffect(k, const) key resolves to the
// constant at compile time (correct-by-construction — the value never changes). Returns
// {has:false} for any other nested shape so the caller falls through to its own handling.
function constFromSelect(nested: any, sideEffects: Map<string, any> | undefined, params: Record<string, any>): { has: boolean; value: any } {
  if (!isNested(nested)) return { has: false, value: undefined };
  const inner = stepChain(nested.nested, params);
  if (inner.length === 1 && inner[0].name === 'select' && typeof inner[0].args[0].value === 'string' && sideEffects?.has(inner[0].args[0].value))
    return { has: true, value: sideEffects.get(inner[0].args[0].value) };
  return { has: false, value: undefined };
}

// A nested value that is a compile-time INVARIANT — no seed / no read spine needed:
//   __.select(k) of a withSideEffect(k, const)  (via constFromSelect), or
//   __.constant(v)  (source-less; the vtype comes from the constant's own parsed argType,
//                    so UUID(..)/datetime(..) keep their type, not a JS-inferred string/int).
// This is what lets a global mergeV (no driver to seed a V/E source at) resolve a nested
// value, and what resolves a nested property KEY. {has:false} → fall through to a seeded read.
export function constFromNested(nested: any, sideEffects: Map<string, any> | undefined, params: Record<string, any>): { has: boolean; value: any; vtype: CanonicalType | null; typeNode: TypeNode | null } {
  const c = constFromSelect(nested, sideEffects, params);
  // A `withSideEffect` constant is a raw JS value out of the registry with no wire arg behind it, so
  // it HAS no TypeNode and `null` is the honest answer rather than a gap — `gremlinTypeOf(v, null)`
  // infers the same way every JSON-path value does. The `constant(…)` arm below is the one that has a
  // declared type to carry, and the asymmetry is the provenance, not an omission.
  if (c.has) return { has: true, value: c.value, vtype: gremlinTypeOf(c.value, null), typeNode: null };
  if (isNested(nested)) {
    const inner = stepChain(nested.nested, params);
    // THE TYPE NODE RIDES ALONG, because the constant's own `Arg` already holds it and dropping it
    // here is §6·7's discard in miniature: `vtype` names only the OUTER stored shape, while the
    // TypeNode is the full recursive tree a COLLECTION needs to tag each element losslessly
    // (`valueNodeOf`). Returning the vtype alone forced every caller wanting a typed value to either
    // re-infer from the JS value — which cannot tell a uuid from a string — or decline the collection
    // case outright. It costs one field and helps every type at once.
    if (inner.length === 1 && inner[0].name === 'constant')
      return {
        has: true, value: inner[0].args[0].value,
        vtype: gremlinTypeOf(inner[0].args[0].value, inner[0].args[0]?.type ?? null),
        typeNode: inner[0].args[0]?.type ?? null,
      };
  }
  return { has: false, value: undefined, vtype: null, typeNode: null };
}

/**
 * A refusal that means **"not learned yet"**, as opposed to **"the answer is an ERROR"** (§6·5).
 *
 * Both used to be a plain `Error` and both arrived at a lowering as `catch { return null }`, which
 * conflated them where it mattered most: a traversal TinkerPop itself rejects counted as an
 * uncovered gap in the coverage census, forever — so the counter could not reach 100% and the
 * migration's exit criterion was unreachable BY CONSTRUCTION.
 *
 * Separating them needs a distinguishable throw and nothing else. `verifyWriteArgs` (a `verify`
 * Pass, above the routing switch) re-raises a plain `Error` — one authority, one message, whichever
 * spine would have run the traversal — and swallows a `Deferral`, leaving it to the spines: RelIR
 * declines to `null` and legacy raises the same message it always did.
 *
 * The distinction is about WHO OWES THE ANSWER, not about severity. "`mergeV()` with no argument"
 * is a `Deferral` because a lowering could learn it tomorrow; "`option()` selector must be
 * Merge.onCreate/onMatch" is an `Error` because no lowering ever will.
 */
export class Deferral extends Error {}

/** What the STEP declared. `null` is a real state, not a missing one: it means the traversal
 *  named no cardinality, so the graph's default applies — and only the storage waist may resolve
 *  it, because collapsing `null` to `'single'` here is exactly the bug that made a repeated
 *  `property(k, v)` overwrite. */
export type Cardinality = VertexCardinality | null;
// `vtype` names the OUTER stored shape (the value column's sibling type); `typeNode` is
// the FULL recursive type tree, threaded so a collection value tags each element/entry/key
// losslessly (valueNodeOf). A scalar's typeNode is redundant with vtype; a nested-traversal
// value has no literal typeNode (its type is resolved at run time as a scalar).
export interface PropSpec { key: string | { nested: any }; value: any; vtype: CanonicalType | null; typeNode: TypeNode | null; meta: Record<string, any> | null; cardinality: Cardinality; }



// A leading Cardinality token on property() args, else null (= the graph's default, applied at
// the storage waist). Returns it plus the remaining [key, value, ...metaArgs], and `off` — how
// many leading args were consumed (0 or 1) so the caller can index the parallel argTypes.
export function readCardinality(args: any[]): { cardinality: Cardinality; rest: any[]; off: number } {
  if (isCardinalityArg(args[0]))
    return { cardinality: args[0].cardinality as Cardinality, rest: args.slice(1), off: 1 };
  return { cardinality: null, rest: args, off: 0 };
}

/** The canonical stored type of a property()'s VALUE arg: the type its carrying
 *  channel declared (the value Arg's type), else inferred from the
 *  JS value. `off`+1 is the value's index in the original arg list (key is at off). */
const propVtype = (step: Step, val: any, off: number): CanonicalType | null =>
  gremlinTypeOf(val, step.args[off + 1]?.type ?? null);

/** The property()'s VALUE arg's full recursive TypeNode (the value Arg's type at the value's
 *  position) — carried alongside vtype so a collection value's elements/keys are tagged
 *  losslessly by valueNodeOf. null for an untyped channel (infer per element at storage). */
export const propTypeNode = (step: Step, off: number): TypeNode | null => step.args[off + 1]?.type ?? null;

/** One `property()` step, parsed. The three hosts differ ONLY in what they do with a T token —
 *  addV consumes `T.id`/`T.label` into the vertex it is about to create, a mutation on an existing
 *  element refuses (ids and labels are immutable there, which is TinkerPop's own rule), and a merge
 *  tail refuses for the same reason — so the token is REPORTED here rather than decided here. This
 *  loop existed twice before the merge tail needed it a third time; the copies had already drifted
 *  (only one of them collapsed a `__.select(sideEffectConst)` VALUE). */
export type ParsedProperty =
  | { kind: 'prop'; spec: PropSpec }
  | { kind: 'token'; token: string; value: any; meta: boolean }
  /** `property(null, …)` — a null KEY adds nothing, which is TinkerPop's null case. (The map form
   *  never reaches here: `desugarPropertyMap` expanded it before lowering ever saw the chain.) */
  | { kind: 'none' };

export function parseProperty(s: Step, sideEffects: Map<string, any> | undefined, params: Record<string, any>): ParsedProperty {
  const { cardinality, rest, off } = readCardinality(argValues(s));
  let [key, val] = rest; const metaArgs = rest.slice(2);
  { const ck = constFromNested(key, sideEffects, params); if (ck.has) key = ck.value; }
  { const cv = constFromSelect(val, sideEffects, params); if (cv.has) val = cv.value; }
  if (key == null || (typeof key === 'object' && !isNested(key) && !isTokenArg(key))) return { kind: 'none' };
  if (isTokenArg(key)) return { kind: 'token', token: key.token, value: val, meta: metaArgs.length > 0 };
  return { kind: 'prop', spec: { key, value: val, vtype: propVtype(s, val, off), typeNode: propTypeNode(s, off), meta: metaOf(metaArgs), cardinality } };
}

/** What an EDGE property may not carry. TinkerPop's edge `Property` has neither a cardinality nor
 *  meta-properties (it is single-valued by spec — the `UNIQUE(edge,key)` constraint is the same
 *  rule at the schema level), so both are refusals wherever an edge property is written. */
export function assertEdgePropertySpec(sp: PropSpec): void {
  if (sp.cardinality !== null) throw new Error('Cardinality is not valid on an edge property');
  if (sp.meta) throw new Error('meta-properties are not valid on an edge property');
}

/** A run of `property()` steps → their specs, for a host on an element that ALREADY EXISTS (a
 *  mutation tail, a merge tail). A T token is immutable on such an element, so it is the refusal. */
export function parsePropertyTail(steps: readonly Step[], what: string, sideEffects: Map<string, any> | undefined, params: Record<string, any>): PropSpec[] {
  const specs: PropSpec[] = [];
  for (const s of steps) {
    if (s.name !== 'property') throw new Deferral(`step not implemented after ${what}: ${s.name}()`);
    const p = parseProperty(s, sideEffects, params);
    if (p.kind === 'token') throw new Deferral(`property(T.${p.token}) on an existing element not yet supported`);
    if (p.kind === 'prop') specs.push(p.spec);
  }
  return specs;
}

// Trailing property() args after (key, value) are meta-property key/value pairs
// (VertexProperty meta-properties). A meta value must be a scalar (no traversal / no
// meta-of-meta).
function metaOf(metaArgs: any[]): Record<string, any> | null {
  if (!metaArgs.length) return null;
  if (metaArgs.length % 2 !== 0) throw new Error('property() meta-properties must be key/value pairs');
  const m: Record<string, any> = {};
  for (let i = 0; i < metaArgs.length; i += 2) {
    const mk = metaArgs[i];
    if (typeof mk !== 'string') throw new Error('property() meta-property key must be a string');
    const mv = metaArgs[i + 1];
    if (isNested(mv)) throw new Error('property() meta-property value must be a scalar');
    m[mk] = mv;
  }
  return m;
}

// A single-cardinality prop bag (a merge map) → PropSpecs. The vtype comes from the
// captured propTypes (the map's TypeNode: a literal subtype or a typed client's wire
// DataType; a nested value's read-shape type), falling back to JS inference where the
// channel said nothing (a JS client that dropped the type / an untyped bound map).
export const singleProps = (rec: Record<string, any>, types: Record<string, TypeNode | null> = {}, cardinalities: Record<string, Cardinality> = {}): PropSpec[] =>
  Object.entries(rec).map(([key, value]) => ({
    key, value, typeNode: types[key] ?? null,
    vtype: gremlinTypeOf(value, types[key] ?? null), meta: null, cardinality: cardinalities[key] ?? null,
  }));


/**
 * WHICH map this is. The spec-mandated validation differs per role and cannot be re-derived from
 * the spec's contents — `option(onMatch)` admits only String keys (plus `T.label`, for multi-label
 * replacement) where the merge argument and `option(onCreate)` admit the element's id/label (and,
 * for `mergeE`, its endpoint directions). Carrying it on the spec is what lets ONE validation run
 * at the ONE place every map becomes concrete, instead of three near-copies at three call sites.
 */
interface MergeRole {
  readonly op: 'mergeV' | 'mergeE';
  readonly kind: 'merge' | 'onCreate' | 'onMatch';
}

export interface MergeSpec {
  readonly role: MergeRole;
  /** A LIST because a merge map's T.label may be `["a","b"]`; null = the key was absent. */
  label: string[] | null | { nested: any };
  id: any;
  outV: any;
  inV: any;
  /** Props are keyed by a stable internal slot until resolveMergeSpec turns a nested
   * map key into its actual string. Static keys use themselves as the slot. */
  props: Record<string, any>;
  propTypes: Record<string, TypeNode | null>;
  propKeys: Record<string, string | { nested: any }>;
  /** The per-key property cardinality. A map's CardinalityValueTraversal wins over
   * its enclosing option(..., Cardinality.x) default, matching TinkerPop. */
  propCardinalities: Record<string, Cardinality>;
}

function classifyMergeKey(k: any): { kind: 'label' | 'id' | 'outV' | 'inV' | 'prop'; name?: string } {
  const enumName = (typeName: string) => k && typeof k === 'object' && k.typeName === typeName ? String(k.elementName).toLowerCase() : null;
  const t = enumName('T') ?? (isTokenArg(k) ? k.token : null);
  if (t) { if (t === 'label') return { kind: 'label' }; if (t === 'id') return { kind: 'id' }; throw new Deferral(`merge map key T.${t} not supported`); }
  const d = enumName('Direction') ?? (isDirectionArg(k) ? k.direction : null);
  if (d) {
    if (d === 'out' || d === 'from') return { kind: 'outV' };
    if (d === 'in' || d === 'to') return { kind: 'inV' };
    throw new Deferral(`merge map key Direction.${d} not supported`);
  }
  return { kind: 'prop', name: String(k) };
}

function classifyMergeVal(v: any): any {
  const m = v && typeof v === 'object' ? (v.typeName === 'Merge' ? String(v.elementName).toLowerCase() : (isMergeArg(v) ? v.merge : null)) : null;
  return m ? { incoming: m } : v;
}

// Resolve a WHOLE-ARG merge traversal (mergeV(__.…) / option(Merge.x, __.…)) to a
// concrete map. A withSideEffect(key, map) constant read back by __.select(key) is a
// per-driver-invariant constant, so substitute it directly (correct-by-construction).
// The other legal whole-arg forms each need substrate this seam doesn't own — fail
// CLOSED naming exactly what's missing (never mis-execute):
//   - __.identity() / any traversal reading the incoming traverser AS the map needs a
//     map-VALUED driver model (merge drivers are element rowids today).
//   - a compound slice (__.select(k).limit(Scope.local,1).unfold()) needs local map
//     ops in the resolver.
//   - a side-effecting body (__.sideEffect(__.properties(k).drop()).select(m)) needs
//     nested-WRITE execution (runNested runs reads only).
// Per-VALUE nested traversals inside a map literal ([k: __.trav]) do NOT come here —
// they stay in the map and resolveMergeSpec resolves them correlated per driver.
function resolveMergeArg(raw: any, sideEffects: Map<string, any> | undefined, params: Record<string, any>): any {
  if (!isNested(raw)) return raw;
  const inner = stepChain(raw.nested, params);
  if (inner.length === 1 && inner[0].name === 'select' && typeof inner[0].args[0].value === 'string') {
    const k = inner[0].args[0].value;
    if (sideEffects?.has(k)) return sideEffects.get(k);
    throw new Error(`merge with select('${k}') needs a withSideEffect('${k}', map) constant`);
  }
  const names = inner.map((s) => s.name).join('.');
  if (inner[0].name === 'identity' || inner.some((s) => s.name === 'select'))
    throw new Deferral(`merge whole-arg traversal __.${names} not yet supported (needs a map-valued driver / local-map / nested-write substrate; a map literal [k: __.trav] IS supported)`);
  throw new Deferral(`merge whole-arg traversal __.${names} not yet supported`);
}

/**
 * The spec-mandated shape of ONE merge map, checked against its role — `MergeElementStep.validate`
 * in gremlin-core, which we did not perform at all. Two rules, both about the KEY:
 *
 *  - a token key must be one this role admits (`getAllowedTokens`): `mergeV` takes `T.id`/`T.label`,
 *    `mergeE` adds `Direction.IN`/`OUT`, and `option(onMatch)` takes none of them except `T.label`,
 *    because onMatch writes properties onto an element whose identity is already settled;
 *  - a token key may not carry a null value, which would otherwise reach `labelNames(null)` and
 *    write the LABEL `"null"`.
 *
 * The rules about the identifier ITSELF (hidden namespace, empty) are `validate.ts`, and they run
 * on the RESOLVED spec instead — a nested map key produces its string per driver, so a compile-time
 * check would see a traversal, not `~id`.
 */
function validateMergeKey(role: MergeRole, k: any, v: any, kind: ReturnType<typeof classifyMergeKey>['kind']): void {
  // A STATIC string key is decidable from the TEXT, so `MergeElementStep.validate`'s
  // `ElementHelper.validateProperty` call (gremlin-core
  // `.../step/map/MergeElementStep.java:278,314-316`) belongs HERE — in the shared parse, which the
  // `writeArguments` verify Pass runs above both spines (§6·5). It used to live only in legacy's
  // route (`validateResolvedMergeSpec`), so `g.mergeV([:]).option(onCreate, ['~label':'vertex'])`
  // was a REFUSAL one spine owned, and RelIR had to decline the whole traversal to reach it.
  // A NESTED key is not decidable here and stays legacy's per-driver check.
  if (kind === 'prop') { if (typeof k === 'string') validatePropertyKey(k); return; }
  const token = kind === 'label' ? 'T.label' : kind === 'id' ? 'T.id' : kind === 'outV' ? 'Direction.OUT' : 'Direction.IN';
  if (role.kind === 'onMatch') {
    // T.label survives: onMatch replaces/extends an element's labels where the graph allows it.
    if (kind !== 'label')
      throw new Error(`option(onMatch) expects keys in Map to be of String - check: ${token}`);
  } else {
    const allowed = role.op === 'mergeV' ? kind === 'label' || kind === 'id' : true;
    if (!allowed)
      throw new Error(`${role.op}() and option(onCreate) args expect keys in Map to be either String or [id, label] - check: ${token}`);
  }
  if (v === null || v === undefined)
    throw new Error(`${role.op}() does not allow null Map values - check: ${String(k && typeof k === 'object' && 'elementName' in k ? k.elementName : token)}`);
}

/**
 * The element-identifier rules over a RESOLVED merge map's property keys.
 *
 * The two storage waists (`labelNames`, `applyVertexProperty`/`insertEdgeProperty`) already reject
 * a bad identifier on the way IN, and a merge map's labels go through `labelNames` — but a merge
 * map's property keys are SEARCH criteria first and only reach a writer if the branch happens to
 * create. `g.mergeV(['~id':1])` against a graph that matches would otherwise write nothing, find
 * something, and never be told the key was illegal. So the map is validated as a map, whichever
 * branch it takes.
 */
export function validateResolvedMergeSpec(spec: MergeSpec): void {
  for (const k of Object.keys(spec.props)) validatePropertyKey(k);
}

/**
 * `MergeElementStep.validateNoOverrides`: `option(onCreate)` may RESTATE a key the merge argument
 * already bound, but not change it — the merge argument IS the existence criterion, so an onCreate
 * that contradicts it would create something the search could never have found.
 *
 * Compared over the normalized spec rather than the raw maps, which is why the four token slots are
 * named individually: `label`/`id`/`outV`/`inV` ARE the map's `T.label`/`T.id`/`Direction.*` keys
 * after classification. A slot still holding a nested traversal is skipped — two traversals are not
 * comparable, and the create-branch call sees them resolved.
 */
export function validateNoOverrides(merge: MergeSpec, onCreate: MergeSpec): void {
  const clash = (token: string, a: any, b: any) => {
    if (a === undefined || a === null || b === undefined || b === null) return;
    if (isNested(a) || isNested(b)) return;
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`option(onCreate) cannot override values from merge() argument: (${token}, ${JSON.stringify(b)})`);
  };
  clash('label', merge.label, onCreate.label);
  clash('id', merge.id, onCreate.id);
  clash('OUT', merge.outV, onCreate.outV);
  clash('IN', merge.inV, onCreate.inV);
  for (const [k, v] of Object.entries(onCreate.props))
    if (k in merge.props) clash(k, merge.props[k], v);
}

function normalizeMergeMap(role: MergeRole, raw: any, typeNode: TypeNode | null, sideEffects?: Map<string, any>, params: Record<string, any> = {}, defaultCardinality: Cardinality = null): MergeSpec {
  raw = resolveMergeArg(raw, sideEffects, params);
  const spec: MergeSpec = { role, label: null, id: null, outV: undefined, inV: undefined, props: {}, propTypes: {}, propKeys: {}, propCardinalities: {} };
  if (raw == null) return spec; // mergeV(null) — match anything
  if (!(raw instanceof Map))
    throw new Error('merge argument must be a map ([k:v] / bound Map), null, or empty ([:])');
  for (const [k, v] of raw) {
    // Parameters resolves map KEYS with TraversalUtil.apply as well as values. A
    // traversal key cannot be classified until it has the incoming driver, so retain it
    // under an internal slot for resolveMergeSpec rather than coercing it to
    // "[object Object]" at parse time.
    if (isNested(k)) {
      const slot = `@nested-key:${Object.keys(spec.props).length}`;
      spec.props[slot] = v;
      spec.propTypes[slot] = null;
      spec.propKeys[slot] = k;
      spec.propCardinalities[slot] = defaultCardinality;
      continue;
    }
    const c = classifyMergeKey(k);
    validateMergeKey(role, k, v, c.kind);
    // label/id/prop VALUES may be nested traversals — keep them UNRESOLVED (deferred to
    // resolveMergeSpec, per driver). Only a non-nested label collapses to a string now.
    if (c.kind === 'label') spec.label = isNested(v) ? v : labelNames(v, true, 'mergeV');
    else if (c.kind === 'id') spec.id = v;
    else if (c.kind === 'outV') spec.outV = classifyMergeVal(v);
    else if (c.kind === 'inV') spec.inV = classifyMergeVal(v);
    else {
      const cardinalityValue = isCardinalityValueArg(v) ? v : null;
      const value = cardinalityValue ? cardinalityValue.value : v;
      const cardinality = cardinalityValue?.cardinality ?? defaultCardinality;
      if (cardinality !== null && cardinality !== 'single' && cardinality !== 'list' && cardinality !== 'set')
        throw new Error(`unsupported merge property cardinality '${cardinality}'`);
      spec.props[c.name!] = value;
      spec.propKeys[c.name!] = c.name!;
      // A literal value's FULL type tree comes from the map's TypeNode (the parser subtype /
      // the typed client's wire DataType) — kept whole so a collection value's elements/keys
      // stay typed; a nested value's type is filled per driver (a scalar, in resolveMergeSpec).
      spec.propTypes[c.name!] = isNested(value) ? null : mapEntryType(typeNode, String(k));
      spec.propCardinalities[c.name!] = cardinality;
    }
  }
  return spec;
}

/**
 * THE MERGE MAPS — the merge argument, its `option()` arms and the `property()` tail after them,
 * normalized against their roles and cross-validated.
 *
 * Exported because the RelIR write route needs the identical parse (§6·6, and the same argument
 * `parseProperty` already carries): the role-dependent token rules, the `validateNoOverrides` check,
 * `Cardinality.x(v)` beating an enclosing option default, and the per-argument type channel are five
 * things a second parser would have five chances to get differently — and one of them had already
 * drifted between two copies inside this file. What the other route re-expresses is the EMISSION.
 *
 * `validateNoOverrides` runs STATICALLY, before anything else — TinkerPop's
 * `validateStaticNoOverrides`, which is why the corpus expects a contradicting onCreate to raise even
 * where the merge argument MATCHES and no create would have happened. The create branch re-checks the
 * RESOLVED specs, for the slots that still held a nested traversal here.
 *
 * The `option()`s must come FIRST and the `property()` tail after them: an option modulates the merge,
 * the tail acts on its OUTPUT. The tail is not a merge feature at all — `mergeV(map).property(k, v)` is
 * an ordinary AddPropertyStep over whatever the merge emitted, matched and created alike, and TinkerPop
 * compiles it as exactly that. So it goes through the same `parsePropertyTail` a mutation tail uses,
 * which is what makes a meta-property or a declared cardinality work in that position without either
 * merge lowering knowing they exist.
 *
 * This absorbed `parseMergeOptions`, which was on §8's deletion list and could not honestly reach zero
 * once the parse became SHARED: what Phase 2.6 deletes is the imperative closure around it, never the
 * parse, so the name had to become this one rather than linger as a target nothing could remove.
 */
export interface MergeMaps {
  readonly match: MergeSpec;
  readonly onCreate: MergeSpec | null;
  readonly onMatch: MergeSpec | null;
  readonly tail: readonly PropSpec[];
  /**
   * `option(Merge.outV, …)` / `option(Merge.inV, …)` — WHERE AN ENDPOINT TOKEN IS RESOLVED, raw.
   *
   * **A `Merge.outV` in the merge map does NOT mean "the incoming traverser".** It means "look at
   * `option(Merge.outV, …)`", and `MergeEdgeStep.resolveVertex`
   * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeEdgeStep.java:231-251`)
   * throws `option(outV) must be specified if it is used for OUT` when the option is absent. Both
   * spines used to substitute the current traverser instead — the same wrong answer on both, which
   * is why no differential could see it and why the corpus could not either: every scenario that
   * uses the token also supplies the option.
   *
   * Left RAW rather than resolved, because the two spines resolve it differently and neither belongs
   * in a parse: the value is a nested traversal evaluated AT the incoming traverser, so it is an
   * alias read on one side and a correlated child on the other.
   */
  readonly outV?: unknown;
  readonly inV?: unknown;
}

export function mergeMaps(
  step: IRStep, mods: readonly Step[], op: MergeRole['op'],
  sideEffects: Map<string, any> | undefined, params: Record<string, any>,
): MergeMaps {
  if (step.args.length === 0)
    throw new Deferral(`${op}() with no argument (uses the incoming traverser as the map) not yet supported`);
  const match = normalizeMergeMap({ op, kind: 'merge' }, step.args[0].value, step.args[0]?.type ?? null, sideEffects, params);

  let onCreate: MergeSpec | null = null, onMatch: MergeSpec | null = null;
  let outV: unknown, inV: unknown;
  const optionCount = mods.findIndex((s) => s.name !== 'option');
  const tail = optionCount < 0 ? [] : parsePropertyTail(mods.slice(optionCount), `${op}()`, sideEffects, params);
  for (const s of optionCount < 0 ? mods : mods.slice(0, optionCount)) {
    if (s.name !== 'option') throw new Deferral(`step not implemented after ${op}(): ${s.name}()`);
    const [sel, mapArg, cardinalityArg] = argValues(s);
    if (!isMergeArg(sel))
      throw new Error(`${op} option() selector must be Merge.onCreate/onMatch`);
    if (cardinalityArg != null && (!isCardinalityArg(cardinalityArg) || isCardinalityValueArg(cardinalityArg)))
      throw new Error(`${op} option() third argument must be Cardinality.single/list/set`);
    const defaultCardinality = cardinalityArg?.cardinality ?? null;
    if (defaultCardinality !== null && defaultCardinality !== 'single' && defaultCardinality !== 'list' && defaultCardinality !== 'set')
      throw new Error(`${op} option() has unsupported cardinality '${defaultCardinality}'`);
    // `Merge.outV`/`Merge.inV` name an ENDPOINT rather than an arm: the option supplies the vertex a
    // `Direction` slot holding that token resolves to. Kept raw (see `MergeMaps.outV`), and only for
    // `mergeE` — a vertex merge has no endpoints, so the selector there is the reference's own error.
    if (sel.merge === 'outv' || sel.merge === 'inv') {
      if (op !== 'mergeE') throw new Error(`${op} option(Merge.${sel.merge}) is not valid — only an edge has endpoints`);
      if (cardinalityArg != null) throw new Error(`${op} option(Merge.${sel.merge}) does not take a cardinality`);
      if (sel.merge === 'outv') outV = mapArg; else inV = mapArg;
      continue;
    }
    const kind = sel.merge === 'oncreate' ? 'onCreate' : sel.merge === 'onmatch' ? 'onMatch' : null;
    if (!kind) throw new Deferral(`${op} option(Merge.${sel.merge}) not supported`);
    const spec = normalizeMergeMap({ op, kind }, mapArg, s.args[1]?.type ?? null, sideEffects, params, defaultCardinality);
    if (kind === 'onCreate') onCreate = spec; else onMatch = spec;
  }

  if (onCreate) validateNoOverrides(match, onCreate);
  // THE TOKEN REQUIRES ITS OPTION, and the check is decidable from the TEXT — so it belongs here and
  // therefore fires from the `writeArguments` verify Pass, above both spines (§6·5). `resolveVertex`
  // raises it per traverser; raising it once, before either spine is chosen, is the same answer.
  requireEndpointOption(match, onCreate, outV, 'outV');
  requireEndpointOption(match, onCreate, inV, 'inV');
  return { match, onCreate, onMatch, tail, ...(outV === undefined ? {} : { outV }), ...(inV === undefined ? {} : { inV }) };
}

/** `Merge.outV` in a `Direction` slot is a REFERENCE to `option(Merge.outV, …)`, so the option has to
 *  be there — `MergeEdgeStep.resolveVertex`'s own refusal, worded as it words it. A slot holding a
 *  plain id needs no option, and an option with no slot to fill is simply unread (the reference
 *  returns early on `!map.containsKey(direction)`), so neither is an error. */
function requireEndpointOption(
  match: MergeSpec, onCreate: MergeSpec | null, option: unknown, side: 'outV' | 'inV',
): void {
  if (option !== undefined) return;
  const token = side === 'outV' ? 'outv' : 'inv';
  const uses = (spec: MergeSpec | null): boolean => {
    const slot = spec?.[side];
    return slot !== null && typeof slot === 'object' && (slot as { incoming?: unknown }).incoming === token;
  };
  if (uses(match) || uses(onCreate))
    throw new Error(`option(${side}) must be specified if it is used for ${side === 'outV' ? 'OUT' : 'IN'}`);
}

/** A label value in a merge map / an addV() argument is a string OR a list of strings; a list is
 *  only legal as the sole argument (TinkerPop rejects mixing, with a message naming Collection).
 *  Returns the flattened names. `sole` says whether this value was the only argument. */
export function labelNames(v: any, sole: boolean, step: string): string[] {
  // THE waist every label name passes through — addV, addLabel, mergeV and mergeE alike — so the
  // element-identifier rules (validate.ts) are enforced once here rather than at each caller.
  if (!Array.isArray(v)) return [validateLabel(v)];
  // Upstream words the two rejections differently and the scenarios match on the text, so this
  // is not one shared message: AddVertex asserts "must produce a scalar String when multiple
  // traversals are provided", AddLabel asserts "Collection".
  if (!sole) throw new Error(step === 'addV'
    ? `${step}(): a label traversal must produce a scalar String when multiple traversals are provided`
    : `${step}(): a Collection argument must be the only argument`);
  return v.map(validateLabel);
}


/**
 * THE WRITE-ARGUMENT VERIFIER — a `verify` Pass's body, run ABOVE the routing switch (§6·5).
 *
 * It parses every write step's arguments and throws away the result. That is the whole mechanism:
 * the parse is the authority on what a write step's text MEANS, so running it early turns a
 * text-level refusal into the traversal's ANSWER — once, from one place, whichever spine would
 * have run it — instead of a `catch { return null }` at each write site that the census then read
 * as uncovered vocabulary.
 *
 * A `Deferral` is swallowed here on purpose: "not learned yet" is the spines' business, and raising
 * it above them would freeze a shape a lowering could learn tomorrow.
 *
 * **The `mergeV`/`mergeE` slice is the RUN of `option()`/`property()` steps, not the rest of the
 * chain.** Legacy hands `mergeMaps` everything after the merge and lets `parsePropertyTail` refuse
 * whatever is not a `property()` — which is legacy's own "step not implemented after mergeV()"
 * deferral, and slicing the same way here would raise it for `mergeV(…).values('name')`, a
 * traversal the RelIR fold continues past perfectly well. A verifier must never narrow what the
 * lowerings may attempt.
 *
 * It does NOT recurse into nested bodies. Each is normalized through this same pipeline when its
 * host lowers it, with that call site's own parameters and side-effect registry — so a nested
 * write is verified where it can be verified CORRECTLY, rather than here against an environment
 * that may not be its own.
 */
export function verifyWriteArgs(steps: readonly IRStep[], params: Record<string, any>, sideEffects: Map<string, any>): void {
  const guarded = (run: () => void): void => {
    try { run(); } catch (e) { if (!(e instanceof Deferral)) throw e; }
  };
  for (let at = 0; at < steps.length; at++) {
    const step = steps[at]!;
    if (step.name === 'property') { guarded(() => { parseProperty(step, sideEffects, params); }); continue; }
    if (step.name !== 'mergeV' && step.name !== 'mergeE') continue;
    let end = at + 1;
    while (end < steps.length && (steps[end]!.name === 'option' || steps[end]!.name === 'property')) end++;
    guarded(() => { mergeMaps(step, steps.slice(at + 1, end), step.name as 'mergeV' | 'mergeE', sideEffects, params); });
  }
}

/**
 * A LABEL MUTATION ON AN EDGE IS A SPECIFIED REFUSAL, and it belongs above the routing switch.
 *
 * TinkerPop fixes an edge's label cardinality at exactly one and immutable, so `addLabel`,
 * `dropLabel` and `dropLabels` on an edge stream are errors rather than gaps — the conformance suite
 * asserts the message directly (`g_E_addLabelXfriendX_labels_fold`, `g_E_dropLabelXknowsX_labels`,
 * `g_E_dropLabels_labels`, each *"the traversal will raise an error with message containing text of
 * 'Label mutation is not supported'"*, `gremlin-test .../features/sideEffect/{AddLabel,DropLabel}.feature`).
 *
 * **It lived in `steps/write/write.ts` and that made three passing scenarios the property of a route
 * with an end date.** They pass today on BOTH spines only because RelIR declines the shape and legacy's
 * write dispatcher raises on the way past; deleting that dispatcher would have deleted the answer. This
 * is §6·5 and the "legacy must not be the authority" rule in one: an ERROR is never a capability, so it
 * is owed by whichever spine runs the traversal, which means it is owed above both.
 *
 * ⚠️ **It is the STREAM's element kind, not an argument** — the one write refusal here that is — so it
 * asks `elementKindAt`, whose third answer is `undefined`. A chain whose prefix this cannot type
 * (a branch, a re-entry, a child host) is left to the lowerings rather than raised on: a verifier must
 * never narrow what the lowerings may attempt, and never raise on a traversal it has not understood.
 * The immutable-graph sibling refusal does NOT move with it and could not: it reads a graph capability,
 * while this is a fact about Gremlin.
 */
export function verifyLabelMutationTarget(steps: readonly IRStep[]): void {
  for (let at = 0; at < steps.length; at++) {
    const step = steps[at]!;
    if (!LABEL_MUTATIONS.has(step.name)) continue;
    if (elementKindAt(steps, at) === 'edge')
      throw new Error(`${LABEL_MUTATION_UNSUPPORTED}: ${step.name}() on an edge`);
  }
}
