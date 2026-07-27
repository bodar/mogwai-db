import { test } from 'bun:test';
import { seeded } from './test/L5-properties/oracle.ts';
import { exec } from './test/support/executor.ts';
import { MODERN_SEED } from './test/fixtures/seed-modern.ts';
import { decodeAll } from './test/support/decode.ts';
test('t', async () => {
  const s = seeded(MODERN_SEED);
  for (const q of ['g.V().local(__.order().by("age")).values("name")', 'g.V().order().by("age").values("name")'])
    console.log(q + '\n  => ' + JSON.stringify(await decodeAll(exec(s).framed(q, {}).map(f=>f.buf))));
});
