// One reproducible generated corpus per commit. A manual L5_SEED remains the
// reproduction escape hatch for a failing draw; the fallback keeps source archives
// without Git metadata usable.
import { execFileSync } from 'node:child_process';

const explicit = process.env.L5_SEED;

export const L5_SEED = explicit === undefined
  ? (() => {
    try {
      // Seven hex digits fit fast-check's signed seed range while varying with HEAD.
      return Number.parseInt(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7), 16);
    } catch {
      return 42;
    }
  })()
  : Number(explicit);

export const L5_SEED_SOURCE = explicit === undefined ? 'HEAD-derived' : 'L5_SEED override';
