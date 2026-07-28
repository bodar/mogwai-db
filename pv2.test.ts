import { test } from 'bun:test';
import { seeded } from './test/L5-properties/oracle.ts';
import { exec } from './test/support/executor.ts';
import { MODERN_SEED } from './test/fixtures/seed-modern.ts';
import { decodeAll } from './test/support/decode.ts';
const names = async (q: string) => {
  const s = seeded(MODERN_SEED);
  try {
    const v = await decodeAll(exec(s).framed(q + '.values("name")', {}).map(f => f.buf));
    return JSON.stringify(v.sort());
  } catch (e) { return 'THREW ' + (e as Error).message.slice(0, 45); }
};
test('verify', async () => {
  const pairs: [string, string, string][] = [
    ['simplePath + bothE.otherV vs both',
     "g.V().out().simplePath().bothE('created').otherV()", "g.V().out().simplePath().both('created')"],
    ['no simplePath (control)',
     "g.V().out().bothE('created').otherV()", "g.V().out().both('created')"],
    ['simplePath alone (control)',
     "g.V().out().simplePath()", "g.V().out()"],
    ['dedup + fold.unfold vs q',
     "g.V().out().dedup().fold().unfold()", "g.V().out().dedup()"],
    ['fold.unfold no dedup (control)',
     "g.V().out().fold().unfold()", "g.V().out()"],
  ];
  for (const [n, a, b] of pairs) {
    const x = await names(a), y = await names(b);
    console.log(`${x===y?'SAME ':'DIFF '} ${n}\n   A ${a}\n     ${x.slice(0,110)}\n   B ${b}\n     ${y.slice(0,110)}`);
  }
});
