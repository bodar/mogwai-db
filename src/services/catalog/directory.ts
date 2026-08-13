import * as make from '../../rel/factory.ts';
import { compilerText } from '../../rel/expr.ts';
import { meta, typeOf } from '../../compiler/rel/build.ts';
import { STATIC } from '../../sql/kernel/render.ts';
import type { Service, RelCallSite, RelContribution } from '../spi/types.ts';
import { DIRECTORY_SERVICE_NAME } from '../spi/types.ts';
import type { AppScope } from '../../scopes.ts';

// ---------- --list (DirectoryService) — pure, Start ----------
//
// Enumerate the live ServiceRegistry (its own app scope's): emit each registered service NAME as a scalar
// string result (default), filtered by the `service` param, or — with `verbose` truthy —
// the JSON describe blob per service. The directory never lists itself (registry.list()
// already excludes it). Because it reads the live registry, a service added to the
// registry later shows up here with no change.

/** The already-computed string rows as a RelIR scalar source — a `Values` relation and the framing
 *  that says it holds strings. The same thing `injectSource` builds for `g.inject('a','b')`, minus
 *  the coercion fold, which is why this service is the one that proves the `rel` arm.
 *
 *  NO CHANNELS: each row is one traverser by construction, so there is no multiplicity to carry and
 *  nothing has established an emission order — `injectSource`'s reasoning verbatim.
 *
 *  An EMPTY list declines (`null`) rather than emitting `Values([])`, which §3.3 records as
 *  unrepresentable: it rendered as invalid SQL that only failed at the database. The algebra's empty
 *  relation is a `Filter(false)` over something, and here there is nothing to be over. Reachable via
 *  `--list` with a `service` filter matching nothing, so it declines rather than guessing. */
function scalarStrings(site: RelCallSite, rows: string[]): RelContribution | null {
  if (!rows.length) return null;
  return {
    kind: 'relation',
    rel: make.values({
      id: site.fresh('svc'), channels: [], type: typeOf(meta('v', 'text')),
      rows: rows.map((r) => [compilerText(r)]),
    }),
    framing: { kind: 'scalar', type: STATIC('string') },
  };
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
    kind: 'rel',
    buildRel: (c) => {
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
