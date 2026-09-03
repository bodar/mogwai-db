import { test, expect, describe } from 'bun:test';
import type { Http } from '../src/api.ts';
import { allowlistedHttp, parseAllowlist } from '../src/http-allowlist.ts';

// The SSRF guard over the outbound Http seam (src/http-allowlist.ts). io()/federate fetch a URL taken
// straight from a client's Gremlin query, so this decorator is the one chokepoint that keeps those
// fetches to an operator-configured host allowlist — empty = deny all (fail closed).

/** A base Http that records the hostnames it was actually asked to fetch and returns 200. */
function recordingBase(): { http: Http; hits: string[] } {
  const hits: string[] = [];
  const http: Http = (req) => {
    hits.push(new URL(req.url).hostname);
    return Promise.resolve(new Response('ok', { status: 200 }));
  };
  return { http, hits };
}

describe('parseAllowlist', () => {
  test('absent/empty → [] (deny all)', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist('   ')).toEqual([]);
  });
  test('splits on commas and whitespace, trims, lower-cases', () => {
    expect(parseAllowlist('A.com, b.example  c.example\nD.EXAMPLE')).toEqual(['a.com', 'b.example', 'c.example', 'd.example']);
  });
});

describe('allowlistedHttp', () => {
  test('empty allowlist blocks every host (fail closed)', async () => {
    const { http, hits } = recordingBase();
    const guarded = allowlistedHttp([], http);
    await expect(guarded(new Request('https://anything.example/x'))).rejects.toThrow(/no host allowlist is configured/);
    expect(hits).toEqual([]); // base was never reached
  });

  test('allowlisted host passes through to base', async () => {
    const { http, hits } = recordingBase();
    const guarded = allowlistedHttp(['backup.example'], http);
    const resp = await guarded(new Request('https://backup.example/graphs/modern.json'));
    expect(resp.status).toBe(200);
    expect(hits).toEqual(['backup.example']);
  });

  test('non-allowlisted host is refused even when others are permitted', async () => {
    const { http, hits } = recordingBase();
    const guarded = allowlistedHttp(['backup.example'], http);
    await expect(guarded(new Request('http://169.254.169.254/latest/meta-data/'))).rejects.toThrow(/not allowlisted/);
    await expect(guarded(new Request('http://localhost:6379/'))).rejects.toThrow(/not allowlisted/);
    expect(hits).toEqual([]);
  });

  test('host match is case-insensitive', async () => {
    const { http } = recordingBase();
    const guarded = allowlistedHttp(['backup.example'], http);
    expect((await guarded(new Request('https://BACKUP.Example/x'))).status).toBe(200);
  });

  test('a non-http(s) scheme is refused', async () => {
    const { http } = recordingBase();
    const guarded = allowlistedHttp(['backup.example'], http);
    await expect(guarded(new Request('ftp://backup.example/x'))).rejects.toThrow(/not http\(s\)/);
  });

  test('a redirect off an allowlisted host is not followed', async () => {
    const redirecting: Http = () => Promise.resolve(new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } }));
    const guarded = allowlistedHttp(['backup.example'], redirecting);
    await expect(guarded(new Request('https://backup.example/x'))).rejects.toThrow(/redirect, which is not followed/);
  });
});
