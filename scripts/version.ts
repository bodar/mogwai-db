#!/usr/bin/env bun
import { $ } from 'bun';
import pkg from '../package.json' with { type: 'json' };

/**
 * The version, DERIVED from the repository rather than stored in it.
 *
 * Only the MAJOR is committed (in package.json) — it is the one part that is a deliberate decision.
 * MINOR is the commit count, so it only ever rises and names exactly one commit. PATCH is the CI run
 * number (`GITHUB_RUN_NUMBER`) or a local timestamp, separating two builds of the same commit — a re-run
 * or a manual build — and making a developer build sort after CI's and obviously not one of CI's.
 *
 * (Scheme from dragoman's scripts/version.ts, which lifted it from tidewaiter.)
 */
export async function version(): Promise<string> {
  const major = pkg.version.split('.')[0];

  // Counted from HEAD, not a branch name: on Actions the checkout is detached, and a PR ref is not a rev.
  if ((await $`git rev-parse --is-shallow-repository`.quiet()).text().trim() === 'true') {
    throw new Error('this is a shallow clone, so the commit count (and the version) is wrong. In Actions, checkout with `fetch-depth: 0`.');
  }

  const revisions = (await $`git rev-list --count HEAD`.quiet()).text().trim();
  const build = process.env.GITHUB_RUN_NUMBER || new Date().toISOString().replace(/[-:T]/g, '').split('.')[0];

  return `${major}.${revisions}.${build}`;
}

// Runnable directly so the package/release tasks can read the version without importing.
if (import.meta.main) {
  console.log(await version());
}
