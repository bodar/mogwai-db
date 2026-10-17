// The ONE place the browser port waits for an OPFS access handle that an UN-CLOSED owner still holds.
//
// opfs-sahpool keeps an exclusive `FileSystemSyncAccessHandle` on every file of a graph's pool for as long
// as the pool is installed. OPFS refuses both a second handle on such a file and the removal of a directory
// containing one, with `NoModificationAllowedError`. An owner that CLOSES its pool (`GraphWorkerHost.close`
// → `pauseVfs()`) releases them synchronously, and that RPC resolving is the completion signal — no wait is
// needed or allowed then. But an owner can also stop WITHOUT closing: a Worker terminated mid-query
// (`destroyGraphWorker`'s bounded fallback), or one that died with its tab (cross-tab failover). Its
// handles are released only when its thread is eventually torn down, and the platform gives NO event for
// that (HTML `Worker.terminate()` is fire-and-forget; a closing document's Workers are torn down after the
// Web Lock it held is already released). So exactly there — and only there — the next touch of the files
// is retried while refused, within a bound, and then fails closed with the platform's own error.

/** How long a successor waits for a dead owner's handles before giving up (and failing loudly). */
export const HANDLE_RELEASE_BUDGET_MS = 15_000;

/** Run `attempt`, re-running it while it fails with `NoModificationAllowedError` (an access handle on the
 *  same file is still open) until `budgetMs` has elapsed; then that error propagates. Any other failure
 *  propagates at once. Only for a successor of an owner that did NOT close (see the module comment). */
export async function retryWhileHandleHeld<T>(attempt: () => Promise<T>, budgetMs = HANDLE_RELEASE_BUDGET_MS): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (let wait = 10; ; wait = Math.min(wait * 2, 250)) {
    try {
      return await attempt();
    } catch (e) {
      if (!isHandleHeld(e) || Date.now() + wait > deadline) throw e;
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

function isHandleHeld(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'NoModificationAllowedError';
}
