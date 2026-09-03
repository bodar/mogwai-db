import { test, expect, describe } from 'bun:test';
import { sha256Hex } from '../src/hash.ts';

// FIPS-180-4 known-answer vectors — the pure-JS SHA-256 (src/hash.ts) must match a reference exactly,
// since a rev hash is only useful if every mogwai instance computes it identically (§5·1).
describe('sha256Hex — known-answer vectors', () => {
  test('empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  test('"abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  test('the 448-bit boundary message (two blocks)', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });
  test('a long multi-block message', () => {
    expect(sha256Hex('a'.repeat(1000000)))
      .toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });
  test('deterministic + collision-free on distinct inputs', () => {
    expect(sha256Hex('marko')).toBe(sha256Hex('marko'));
    expect(sha256Hex('marko')).not.toBe(sha256Hex('vadas'));
  });
});
