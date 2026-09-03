// ---------- MogwaiConfig — one config SHAPE, sourced per-runtime ----------
//
// The shared server code consumes ONE config object. Each runtime builds it from its NATIVE source —
// there is no cross-runtime config *file*, because the thing that differs between runtimes is only the
// source, never the structure:
//   - Bun   : CLI flags → env vars → defaults (`configFromBun`).
//   - Worker: the Worker's `env` — a single structured `CONFIG` object var (Wrangler `vars` can hold a
//             JSON object/array, so `env.CONFIG.httpAllowlist` is a real array), falling back to the
//             individual vars (`HTTP_ALLOWLIST`, `PATH_PREFIX`) — `configFromWorkerEnv`.
// So a Worker carries the SAME structure as a Bun config, just as an adjacent object in `env` rather
// than a file. Fields a given runtime doesn't use (port/dataDir/ioDir are Bun-only; a Worker's storage
// is its DO and io is the R2 binding) are simply absent there.

import { parseAllowlist } from './http-allowlist.ts';

export interface MogwaiConfig {
  /** Outbound-HTTP host allowlist for io()/federate. Empty ⇒ DENY ALL (fail closed). Both runtimes. */
  httpAllowlist: string[];
  /** Graph path prefix (`/gremlin/{id}`). Both runtimes. */
  pathPrefix?: string;
  /** One-line-per-query access log. Both runtimes (a Worker reads it from env). */
  log?: boolean;
  // ── Bun-only runtime settings (a Worker gets storage from its DO and io from the R2 binding) ──
  port?: number;
  dataDir?: string;
  ioDir?: string;
}

/** Normalise an allowlist that may arrive as a delimited string (env/CLI) or as an already-structured
 *  array (a Worker's `env.CONFIG.httpAllowlist`). */
export function toAllowlist(v: string | readonly string[] | undefined | null): string[] {
  return Array.isArray(v) ? v.map((h) => String(h).trim().toLowerCase()).filter(Boolean) : parseAllowlist(v as string | undefined);
}

/** Build a config from Bun CLI flag values (already parsed) and the process env. Flags win over env;
 *  env wins over the built-in default. `allowHost` is the repeatable `--allow-host` flag. */
export function configFromBun(
  flags: { port?: string; dataDir?: string; ioDir?: string; pathPrefix?: string; allowHost?: string[] },
  env: Record<string, string | undefined>,
): MogwaiConfig {
  const port = flags.port ?? env.MOGWAI_PORT;
  return {
    httpAllowlist: flags.allowHost?.length ? toAllowlist(flags.allowHost) : toAllowlist(env.MOGWAI_HTTP_ALLOWLIST),
    pathPrefix: flags.pathPrefix ?? env.MOGWAI_PATH_PREFIX,
    log: env.MOGWAI_LOG ? true : undefined,
    port: port ? Number(port) : undefined,
    dataDir: flags.dataDir ?? env.MOGWAI_DB_DIR,
    ioDir: flags.ioDir ?? env.MOGWAI_IO_DIR,
  };
}

/** The subset of a Worker/DO `env` this reads. `CONFIG` is the structured object var (preferred);
 *  the individual vars are the flat fallback. All optional — absent ⇒ deny-all + defaults. */
export interface WorkerConfigEnv {
  CONFIG?: Partial<MogwaiConfig> & { httpAllowlist?: string | readonly string[] };
  HTTP_ALLOWLIST?: string;
  PATH_PREFIX?: string;
  MOGWAI_LOG?: string;
}

/** Build a config from a Worker/DO `env`: a structured `CONFIG` object var takes precedence, else the
 *  individual vars. This is the "adjacent object" — same shape as Bun's, sourced from `env`. */
export function configFromWorkerEnv(env: WorkerConfigEnv): MogwaiConfig {
  const c = env.CONFIG;
  return {
    httpAllowlist: toAllowlist(c?.httpAllowlist ?? env.HTTP_ALLOWLIST),
    pathPrefix: c?.pathPrefix ?? env.PATH_PREFIX,
    log: c?.log ?? (env.MOGWAI_LOG ? true : undefined),
  };
}

/** Build a config from a value already parsed out of the browser's inline `<script>` JSON block (the
 *  page bootstrap reads the DOM; this stays DOM-free so it lives beside the other builders). Same shape,
 *  browser-sourced — the "lift and shift" the inline JSON gives you. A missing/garbage value ⇒ deny-all
 *  defaults. `pathPrefix`/`log` are carried for parity though the browser edge doesn't consume them yet. */
export function configFromBrowser(raw: unknown): MogwaiConfig {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    httpAllowlist: toAllowlist(o.httpAllowlist as string | readonly string[] | undefined),
    pathPrefix: typeof o.pathPrefix === 'string' ? o.pathPrefix : undefined,
    log: o.log === true || undefined,
  };
}
