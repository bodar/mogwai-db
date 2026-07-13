import { q } from '../q.ts';
import { rangeToOffsetLimit } from '../plan.ts';
import { advance, carryFrag, prevRel, type StepFn } from './context.ts';

// ---------- passthrough range/limit/skip (prefix phase) ----------
//
// limit/range/skip compose as CTEs while still on the id-relation — i.e. BEFORE
// any order(). Once order() appears they fall out of the prefix table (a name the
// dispatch has no entry for) and the tail folds them into ORDER BY/LIMIT/OFFSET
// instead. So mid-chain `out().limit(5).out()` truncates here, while
// `order().by(k).limit(5)` truncates after the sort — the split IS the dispatch
// boundary (see src/steps/index.ts).

// identity(): the no-op step — passes the current traverser set through unchanged
// (TinkerPop's own identity). IdentityRemovalStrategy exists to elide it; we keep the
// step so a traversal that names it explicitly (or one built by a client that doesn't
// run that strategy) compiles the same.
export const identity: StepFn = (_s, st) => st;

export const limit: StepFn = (s, st) => {
  const p = prevRel(st, 'p');
  return advance(st, q`SELECT ${p.c.id}${carryFrag(st, p)} FROM ${p} LIMIT ${Number(s.args[0])}`);
};

export const range: StepFn = (s, st) => {
  const { offset, limit } = rangeToOffsetLimit(s.args);
  const p = prevRel(st, 'p');
  return advance(st, q`SELECT ${p.c.id}${carryFrag(st, p)} FROM ${p} LIMIT ${limit} OFFSET ${offset}`);
};

export const skip: StepFn = (s, st) => {
  const p = prevRel(st, 'p');
  return advance(st, q`SELECT ${p.c.id}${carryFrag(st, p)} FROM ${p} LIMIT -1 OFFSET ${Number(s.args[0])}`);
};
