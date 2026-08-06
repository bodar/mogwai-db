// What a test run is allowed to say — the unix rule: silent when things are fine.
//
// A green run should be readable at a glance, so each test file gets at most a LINE or two of
// standing summary (a count, a percentage, a ratchet position — the numbers you actually watch move).
// The long instrument dumps every level used to print unconditionally — 25 corpus step frequencies,
// 20 unmodelled steps, one line per metamorphic law — are still worth having, but only when someone
// is asking; they go behind `$MOGWAI_VERBOSE`. Nothing is deleted and nothing is hidden from a
// failure: an assertion that fails prints its full diagnosis either way, and L3's telemetry summary
// is written to a JSON artifact regardless of what reaches the terminal.
export const VERBOSE = !!process.env.MOGWAI_VERBOSE;

/** A standing summary line — always printed. Reserve it for a number worth watching. */
export function summary(line: string): void {
  console.log(line);
}

/** An instrument dump — printed only under `$MOGWAI_VERBOSE`. Takes a THUNK so building the
 *  string (sorting a frequency table, joining thousands of rows) costs nothing on a quiet run. */
export function detail(lines: () => string): void {
  if (VERBOSE) console.log(lines());
}

/** Tell the reader where the detail went, without printing the detail. Use once per suppressed
 *  dump, and only when it names something specific — a bare "run with MOGWAI_VERBOSE" on every
 *  file is the noise this module exists to remove. */
export const verboseHint = (what: string) => `  (MOGWAI_VERBOSE=1 for ${what})`;
