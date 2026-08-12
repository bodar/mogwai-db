import { DurableObject } from 'cloudflare:workers';

/**
 * A THROWAWAY WORKER whose only job is to run probe SQL inside a real Durable Object.
 *
 * It exists because a claim about what DO SQLite accepts can only be settled by asking DO SQLite.
 * `src/cf-limits.ts` covers the two limits that are COUNTABLE from Bun (100 bound parameters, 100 KB
 * of statement text); it cannot cover whether a CONSTRUCT is accepted at all, and the two constructs
 * the RelIR algebra already emits for writes — `RETURNING` and `ON CONFLICT DO UPDATE` — had never
 * been measured on the runtime we ship to. That is the exact species of wall that passes on the dev
 * runtime and fails in production, which is what the whole `cf-limits` seam exists to prevent.
 *
 * ## Why a SEPARATE worker rather than an endpoint on the real one
 *
 * This takes arbitrary SQL over HTTP. That must never be reachable from the shipped Worker, so it is
 * its own entry point with its own `wrangler.jsonc`, started by a test and killed by it — never
 * deployed, never imported by `src/`. The method is the one recorded in the build plan (§6·2): a
 * throwaway `wrangler dev` worker with its own DO measures production SQLite for real in about a
 * second, and any future "X is legal/faster on the platform" claim goes through here before it
 * becomes a rule.
 *
 * The probe reports per statement rather than failing the batch, because "which statement was
 * refused, and with what message" IS the measurement.
 *
 * TWO THINGS IT MEASURED ABOUT ITSELF before it measured anything about writes, both of them the
 * platform's AUTHORIZER rather than its SQL dialect: `PRAGMA writable_schema` is refused outright
 * (`not authorized: SQLITE_AUTH`), and so is dropping a Durable Object's own bookkeeping table — whose
 * name also DIFFERS between local dev (`__miniflare_do_name`) and production (`_cf_*`), so a wipe that
 * filtered by name would be brittle in exactly the direction this seam exists to catch. Hence no wipe
 * at all: a fresh DO per run instead.
 */

export interface Env {
  PROBE: DurableObjectNamespace<SqlProbe>;
}

interface Statement {
  readonly sql: string;
  readonly binds?: readonly unknown[];
}

/** One statement's outcome. An `error` is a finding, not a failure of the probe. */
type Outcome =
  | { readonly ok: true; readonly rows: readonly Record<string, unknown>[] }
  | { readonly ok: false; readonly error: string };

export class SqlProbe extends DurableObject<Env> {
  /**
   * Run statements in order against `ctx.storage.sql` — the same SQLite the graph store sits on,
   * reached the same way. Each outcome is captured so a batch can assert both that the legal
   * constructs are accepted and that the illegal one is refused, in one round trip.
   */
  run(statements: readonly Statement[]): Outcome[] {
    return statements.map((statement) => {
      try {
        const cursor = this.ctx.storage.sql.exec(statement.sql, ...(statement.binds ?? []));
        // `toArray()` drains the cursor here rather than at the caller: a DO cursor cannot cross an
        // await, which is the constraint the streaming work already recorded.
        return { ok: true, rows: cursor.toArray() as Record<string, unknown>[] };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // One DO per probe GROUP, named by the caller, so a group's schema and its id sequence are its
    // own. There is deliberately NO wipe: the caller makes the name unique per RUN, which is the same
    // trick the runtime contract uses and the reason nothing here needs a privileged operation.
    const probe = env.PROBE.get(env.PROBE.idFromName(url.pathname));
    if (request.method !== 'POST') return new Response('probe: POST a statement batch', { status: 405 });
    const body = await request.json() as { readonly statements: readonly Statement[] };
    return Response.json(await probe.run(body.statements));
  },
};
