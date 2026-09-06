// ---------- SSRF guard: an allowlist decorator over the outbound `Http` seam ----------
//
// io() and federate both fetch a URL that comes STRAIGHT from a client's Gremlin query
// (`g.io("https://…").read()`, `federate("https://…")`) — an attacker-controlled server-side fetch,
// i.e. a textbook SSRF. Both route through the injected `Http` seam (`(Request)=>Promise<Response>`),
// so ONE decorator on that seam closes the hole everywhere at once (io + federate, Bun + Worker/DO).
//
// The control is a host ALLOWLIST, empty by default → DENY ALL (fail closed): outbound HTTP is off
// until an operator opts specific hosts in at server start. This is deliberately simpler and more
// portable than "resolve DNS and reject private ranges": that Node/Bun pattern cannot run on a
// Cloudflare Worker (no in-isolate DNS resolution, no view of the resolved IP before fetch), whereas
// a hostname allowlist needs nothing but the URL, so it behaves IDENTICALLY on every runtime. It also
// resists DNS rebinding for free: an attacker cannot get their own hostname into the operator's list.

import type { Http } from './api.ts';
import { defaultHttp } from './http-federation.ts';

/** Parse an allowlist string (a CLI value / env var / config field) into normalised hostnames, split
 *  on commas or whitespace. Absent or empty → `[]`, which the decorator treats as DENY ALL. Hosts are
 *  lower-cased (hostnames are case-insensitive) so matching is exact. */
export function parseAllowlist(raw: string | undefined | null): string[] {
  return (raw ?? '').split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/** Options for {@link allowlistedHttp} beyond the host allowlist itself. */
export interface AllowlistOptions {
  /**
   * An ORIGIN (`scheme://host[:port]`) permitted IN ADDITION to the allowlist — the ONLY thing that
   * may set it is a BROWSER entry, to its own `self.location.origin`. A browser fetching its OWN origin
   * is the user's own browser reaching the page's own server, not a server-side request forgery: the
   * classic SSRF danger (an isolate tricked into fetching an internal target the CLIENT could not reach)
   * does not exist when the "server" IS the client's browser and the target is the page it is already
   * on. So the GitHub Pages demo can `g.io("https://owner.github.io/mogwai-db/data/modern.json").read()`
   * with no operator allowlist, out of the box, while EVERY OTHER origin still goes through the allowlist.
   *
   * A SERVER runtime never sets this: a Bun server or a Durable Object does not know its own public
   * origin (behind a proxy / a `*.workers.dev` alias / a custom domain, the request `Host` is
   * attacker-influenced), so trusting "same origin" there would be trusting an unknown, not a safe
   * self-reference. Cross-origin io() on Bun/CF goes through the allowlist exactly like federate.
   *
   * Same-origin bypasses ONLY the host-allowlist check — the http(s) scheme guard and the redirect
   * refusal below still apply, so a same-origin document that 3xx-redirects off-origin is still refused
   * (it could otherwise be a same-origin open redirect onto an internal target).
   */
  readonly trustedOrigin?: string;
}

/**
 * Wrap an `Http` transport so it reaches ONLY allowlisted hosts. An empty `allowlist` blocks every
 * outbound call (the secure default). Matches on the URL's hostname (never a resolved IP), so it is
 * runtime-agnostic. Refusals throw a clear, actionable error — the same channel a query failure already
 * uses (returned to the client on the wire, not a crash).
 *
 * A redirect off an allowlisted host is NOT followed (`redirect: 'manual'` + refuse 3xx): silently
 * following one could land on an internal target and reopen the very SSRF the allowlist closes. If a
 * redirect is intended, allowlist its target host too.
 *
 * `opts.trustedOrigin` (browser-only — see {@link AllowlistOptions}) additionally permits the browser's
 * OWN origin without an allowlist entry, so the same-origin docs demo loads its dataset out of the box.
 */
export function allowlistedHttp(allowlist: readonly string[], base: Http = defaultHttp, opts: AllowlistOptions = {}): Http {
  const allowed = new Set(allowlist.map((h) => h.toLowerCase()));
  const trustedOrigin = opts.trustedOrigin;
  return async (request) => {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error(`outbound request refused: scheme "${url.protocol}" is not http(s) (${url.href})`);
    // Permitted by same-origin trust (browser only) OR by the host allowlist. Same-origin skips only the
    // hostname check — scheme (above) and redirect (below) guards still run.
    const sameOrigin = trustedOrigin !== undefined && url.origin === trustedOrigin;
    if (!sameOrigin && !allowed.has(url.hostname.toLowerCase()))
      throw new Error(
        allowed.size === 0
          ? `outbound HTTP is disabled — no host allowlist is configured, so io()/federate cannot reach "${url.hostname}". `
            + 'Set an allowlist at server start (Bun: --allow-host / MOGWAI_HTTP_ALLOWLIST; Worker: HTTP_ALLOWLIST).'
          : `outbound HTTP to "${url.hostname}" is not allowlisted. Permitted hosts: ${[...allowed].join(', ')}.`,
      );
    const resp = await base(new Request(request, { redirect: 'manual' }));
    if (resp.type === 'opaqueredirect' || (resp.status >= 300 && resp.status < 400))
      throw new Error(
        `outbound HTTP to "${url.hostname}" returned a ${resp.status || '3xx'} redirect, which is not followed `
        + '(allowlist guard). Allowlist the redirect target host if the redirect is intended.',
      );
    return resp;
  };
}
