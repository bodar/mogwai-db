// Drive the real `gremlin` client against a `fetch` HANDLER instead of a socket.
//
// A Bun server, a Cloudflare Worker and `fetch` itself all agree on one shape —
// `(Request) => Promise<Response>` — so a client that issues its requests through `fetch` can be
// pointed straight at a handler with no TCP, no port and no listening socket. That is the whole
// mechanism here, and it is why L3 owns no port at all.
//
// The seam is UPSTREAM'S OWN, not a patch and not a private hook. `lib/driver/dispatcher.ts` keeps
// `fetch` in a holder object precisely so it can be replaced:
//
//     // A holder object, not a bare export, so tests can swap `fetch` (an ESM export can't be
//     // reassigned, an object property can).
//     export const httpFetch: { fetch: typeof globalThis.fetch } = { … };
//
// and `Connection.request` reads `httpFetch.fetch(…)` at call time.
//
// WHY SEVERAL HOLDERS, when the seam is one object. Two independent copies of the driver can be
// live in one process, and for L3 both are:
//
//   - the PACKAGED client — `import 'gremlin'` resolves the `exports` map to `build/esm/…`, which is
//     what our own code and `conformance.test.ts` use;
//   - the SOURCE client — upstream's cucumber world (`test/cucumber/world.js` → `../helper.js`)
//     imports `../../lib/driver/…`, the TypeScript source.
//
// Separate module instances, separate `httpFetch` objects. On top of that, `package.json` has a
// `browser` field remapping `build/esm/driver/dispatcher.js` → `dispatcher.browser.js`, which Bun
// honours, so the packaged copy has two candidates. We swap every one we can resolve rather than
// reason about which the caller will reach — cheap, and the alternative is a silent miss.
//
// A MISS IS THE DANGEROUS OUTCOME, so this fails closed. If the swap does not take, the client does
// not error: it tries the real address and either hangs or reports a connection failure that reads
// like a broken server. `assertUsed()` turns that into an explicit failure naming this file.
// (Measured while building it: a spike that swapped only the packaged holder sat there until it was
// killed, because upstream's world was reading the source holder.)

const HERE = new URL('.', import.meta.url).pathname;
const GLV = `${HERE}../../vendor/tinkerpop/gremlin-js/gremlin-javascript`;

/** Every module that might own the live `httpFetch` holder. Missing ones are skipped, not fatal —
 *  `dispatcher.browser` is absent from older client trees, and the SOURCE pair only exists while the
 *  submodule is provisioned. What must never be silent is zero holders, or zero use. */
const HOLDER_MODULES = [
  `${GLV}/lib/driver/dispatcher.ts`,
  `${GLV}/lib/driver/dispatcher.browser.ts`,
  `${HERE}../../node_modules/gremlin/build/esm/driver/dispatcher.js`,
  `${HERE}../../node_modules/gremlin/build/esm/driver/dispatcher.browser.js`,
];

type Holder = { fetch: typeof globalThis.fetch };

export interface InMemoryTransport {
  /** Requests served. Zero after a run means the swap did not take — see `assertUsed`. */
  readonly calls: number;
  /** Throw unless the client actually went through us. Call it after the run, not before. */
  assertUsed(): void;
  /** Put the real `fetch` back on every holder we replaced. */
  restore(): void;
}

/**
 * Route every `gremlin` client request in this process at `handler`.
 *
 * The URL the client was configured with becomes a LABEL: it is still parsed (so it must be a valid
 * absolute URL, and its path still selects the route) but nothing dials it. Tests can therefore
 * point the client at a deliberately unroutable authority and any escape becomes obvious.
 */
export async function installInMemoryTransport(
  handler: (req: Request) => Promise<Response>,
): Promise<InMemoryTransport> {
  const swapped: { holder: Holder; original: typeof globalThis.fetch }[] = [];
  let calls = 0;

  const inMemory = (async (input: unknown, init?: RequestInit) => {
    calls++;
    // The client always passes a URL STRING (`httpRequest.url`); the other forms are accepted so a
    // future caller shape cannot silently bypass us.
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as { url: string }).url;
    // Rebuild the request rather than forwarding `init`: the client passes an undici `dispatcher`
    // field, which is meaningless to a handler and not part of `RequestInit`. `signal` IS forwarded —
    // the driver aborts it to tear a stream down, and dropping it would leak that teardown.
    return handler(new Request(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal ?? undefined,
    }));
  }) as unknown as typeof globalThis.fetch;

  for (const path of HOLDER_MODULES) {
    let mod: { httpFetch?: Holder };
    try {
      mod = await import(path);
    } catch {
      continue; // not present in this tree — see HOLDER_MODULES
    }
    const holder = mod.httpFetch;
    if (!holder) continue;
    swapped.push({ holder, original: holder.fetch });
    holder.fetch = inMemory;
  }

  if (swapped.length === 0) {
    throw new Error(
      'in-memory transport: found no `httpFetch` holder to swap — the gremlin client moved its '
      + `transport seam. Looked in:\n  ${HOLDER_MODULES.join('\n  ')}`,
    );
  }

  return {
    get calls() { return calls; },
    assertUsed() {
      if (calls > 0) return;
      throw new Error(
        `in-memory transport: swapped ${swapped.length} holder(s) but served 0 requests. The client `
        + 'reached a different copy of the driver, so it tried the real network instead of the '
        + 'in-process handler. See test/support/in-memory-transport.ts (HOLDER_MODULES).',
      );
    },
    restore() {
      for (const { holder, original } of swapped) holder.fetch = original;
      swapped.length = 0;
    },
  };
}
