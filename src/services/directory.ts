import { q, value, list } from '../sql/kernel/q.ts';
import { toScalarStream } from '../steps/stream.ts';
import type { Carry } from '../steps/context.ts';
import type { Service, ServiceCallCtx } from './types.ts';
import { DIRECTORY_SERVICE_NAME } from './types.ts';

// ---------- --list (DirectoryService) — pure, Start ----------
//
// Enumerate the live ServiceRegistry: emit each registered service NAME as a scalar
// string result (default), filtered by the `service` param, or — with `verbose` truthy —
// the JSON describe blob per service. The directory never lists itself (registry.list()
// already excludes it). Because it reads the live registry, a service added to the
// registry later shows up here with no change.

/** Build a scalar-string stream from a list of already-computed string rows, seeded from
 *  a VALUES CTE exactly like inject() does. An empty list yields the empty stream. */
function scalarStrings(ctx: ServiceCallCtx, rows: string[]) {
  const carry: Carry = { q: ctx.q, params: ctx.compileParams, carried: { aliases: new Map(), origins: [] } };
  const rel = rows.length
    ? ctx.q.cte(q`VALUES ${list(rows.map((r) => q`(${value(r)})`), ', ')}`, ['v'])
    : ctx.q.cte(q`SELECT NULL AS v WHERE 0`, ['v']);
  return toScalarStream(carry, rel, 'string');
}

export const directoryService: Service = {
  name: DIRECTORY_SERVICE_NAME,
  type: 'start',
  describeParams: () => ({ service: 'string (filter)', verbose: 'boolean' }),
  resolve: (ctx) => ({
    kind: 'stream',
    build: (c) => {
      const services = c.registry.list();
      const filter = c.params.service;
      const chosen = typeof filter === 'string' ? services.filter((s) => s.name === filter) : services;
      // verbose → the describe blob as a JSON string per service; default → the bare name.
      const rows = c.params.verbose
        ? chosen.map((s) => JSON.stringify({ name: s.name, type: s.type, params: s.describeParams() }))
        : chosen.map((s) => s.name);
      return scalarStrings(c, rows);
    },
  }),
};
