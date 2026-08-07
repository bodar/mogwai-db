import { q, value, list } from '../../sql/kernel/q.ts';
import { toScalarStream } from '../../compiler/steps/context/stream.ts';
import { rootLayout, type LoweringState } from '../../compiler/steps/context/context.ts';
import type { Service, StreamCallSite } from '../spi/types.ts';
import { DIRECTORY_SERVICE_NAME } from '../spi/types.ts';
import type { AppScope } from '../../scopes.ts';

// ---------- --list (DirectoryService) — pure, Start ----------
//
// Enumerate the live ServiceRegistry (its own app scope's): emit each registered service NAME as a scalar
// string result (default), filtered by the `service` param, or — with `verbose` truthy —
// the JSON describe blob per service. The directory never lists itself (registry.list()
// already excludes it). Because it reads the live registry, a service added to the
// registry later shows up here with no change.

/** Build a scalar-string stream from a list of already-computed string rows, seeded from
 *  a VALUES CTE exactly like inject() does. An empty list yields the empty stream. */
function scalarStrings(ctx: StreamCallSite, rows: string[]) {
  const carry: LoweringState = { q: ctx.q, params: ctx.boundParams, traverserLayout: rootLayout() };
  const rel = rows.length
    ? ctx.q.cte(q`VALUES ${list(rows.map((r) => q`(${value(r)})`), ', ')}`, ['v'])
    : ctx.q.cte(q`SELECT NULL AS v WHERE 0`, ['v']);
  return toScalarStream(carry, rel, 'string');
}

/** The directory takes the registry it enumerates as a CONSTRUCTION dependency, read off the app
 *  scope. It is the scope entry it lives in, which is only safe because the read happens at BUILD
 *  time (compile), never at construction — see RegistryProvider in scopes.ts. */
export const createDirectoryService = (app: AppScope): Service => ({
  name: DIRECTORY_SERVICE_NAME,
  type: 'start',
  internal: true,   // TinkerPop's rule: the directory never lists itself.
  describeParams: () => ({ service: 'string (filter)', verbose: 'boolean' }),
  resolve: () => ({
    kind: 'stream',
    build: (c) => {
      const services = app.registry.list();
      const filter = c.params.service;
      const chosen = typeof filter === 'string' ? services.filter((s) => s.name === filter) : services;
      // verbose → the describe blob as a JSON string per service; default → the bare name.
      const rows = c.params.verbose
        ? chosen.map((s) => JSON.stringify({ name: s.name, type: s.type, params: s.describeParams() }))
        : chosen.map((s) => s.name);
      return scalarStrings(c, rows);
    },
  }),
});
