export const meta = {
  name: 'execute-workflow',
  description: 'Drive a plan doc on trunk in rounds: scout + sympathy plan review, then per item build -> two-lens review -> land serially, deferring what needs prerequisites; proposals feed the next round',
  whenToUse: 'The orchestrated alternative to the /execute-plan skill. args: {plan: "docs/…md", section?: "§10", fixRounds?: 3, maxItems?: <hard ceiling per round>, maxRounds?: 8}. Batch size and whether to start another round are judged by a steward from convergence, not fixed. Graceful stop: `touch .git/workflow-stop` — in-flight items finish and land, no new build starts, the run ends at the next steward.',
  phases: [
    { title: 'Scout', detail: 'verify plan items against current code, draft a design per item' },
    { title: 'Plan review', detail: 'one sympathy/substrate reviewer: revise designs, order by prerequisite, defer what cannot be built yet' },
    { title: 'Build', detail: 'one worktree per item, after its prerequisites land' },
    { title: 'Review', detail: 'depth lens + sympathy lens, skeptic triage of blockers, bounded fix rounds' },
    { title: 'Land', detail: 'serial: rebase, mise run ci, push, local plan-doc commit' },
    { title: 'Sweep', detail: 'can existing features reuse what landed? proposals only' },
    { title: 'Record', detail: 'write deferrals, follow-ups and proposals into the plan for the next round' },
    { title: 'Steer', detail: 'are we converging or just growing the list? continue/stop, next batch size and focus' },
  ],
}

if (!args || !args.plan) throw new Error('execute-workflow needs args.plan (path to the plan doc)')
// No machine paths: the main checkout is whatever `git worktree list` names first, which holds from
// the main checkout and from every linked worktree alike. Agents expand it in their shell commands.
const REPO = args.repo || '$(git worktree list --porcelain | sed -n 1s/^worktree.//p)'
// Graceful stop: `touch .git/workflow-stop` in the main checkout. In-flight items finish (fix, land); no new build starts; the steward ends the run and removes the file.
const STOP_FILE = `$(git -C ${REPO} rev-parse --path-format=absolute --git-common-dir)/workflow-stop`
const PLAN = args.plan
const SECTION = args.section ? ` (work ${args.section} only)` : ''
// Batch size and round count are a JUDGEMENT made by the steward after each round; these are only
// ceilings. MAX_ROUNDS is a runaway backstop, not a target.
const MAX_ITEMS = args.maxItems || 10
const MAX_ROUNDS = args.maxRounds || args.rounds || 8
const FIX_ROUNDS = args.fixRounds === undefined ? 3 : args.fixRounds
const MAX_MINORS = 5

// Every agent gets this — builders as much as reviewers. Steering the first attempt is cheaper than
// reviewing it back into shape.
const PRINCIPLES = `
THE MAIN CHECKOUT is written below as \`${REPO}\` — a shell expression; let your shell expand it (it works from any worktree), and expand it once to learn the path when you need it in prose.
mogwai-db (TinkerPop 4 Gremlin compiled to SQLite). CLAUDE.md is injected — its "Semantics traps" section is binding. The ones that steer this work:
- FAITHFUL, NOT EXACT. A faithful port MECHANICALLY SYMPATHETIC to SQLite and the JS runtime — not a port of Java's execution. The reference decides WHICH rows and values a query returns, not HOW Java computes them. Do NOT emulate: laziness/pull order, LazyBarrierStrategy/NoOpBarrier/TraverserSet merge order, when an error fires, number spelling, signed zero, UTF-16 code units, java.util.regex, Java number towers. Use JS RegExp, SQLite code-point order and length/substr, JS doubles, a write sees a SNAPSHOT of its input. Accepted divergences are listed in docs/feature-support-matrix.md §17; the 2026-10 overreach that motivated this (≈8k lines of Java emulation, +77% SQL, production-only declines) is docs/archive/2026-10-18-simplification-plan.md "Why" — read it once if you are tempted to match Java's output exactly.
- If exactness would cost much SQL/JS code or runtime, or a decline, take the natural JS/SQLite answer instead and add one §17 line.
- STILL NEVER: lost/duplicated rows, wrong counts, wrong element written/dropped, a wrong number class where it shows (3 vs 3.0), a crash, an internal/bare Error reaching the user.
- NEVER DECLINE ON DATA SIZE. A decline is a property of the query text. A decline costs the user something — never add one to protect an emulation.
- EXPLAIN, DON'T BAFFLE. When a shape almost certainly signals a confused query (e.g. \`select('a').V()\` over a label bound on only some rows: the selected value is discarded, so the answer silently depends on which rows matched), a clear decline beats a faithful-but-baffling answer — the user would otherwise be debugging a weird result. The message names the problem and suggests the likely intent (\`select('a').out()\`? \`V().has(…, select('a'))\`?). Ordinary row-dependent idioms (\`optional(…as('a')).select('a')\`) keep answering. Every decline message, explanatory or not, says what is unsupported in the user's terms.
- Every new per-row SQL term needs a user-visible reason; an expression used N times is computed once. No bind list sized by row count (one json_each bind).
- PERFORMANCE IS SEMANTICS AT PRODUCTION SIZE. A query that is correct on the 6-vertex modern graph but quadratic in traverser/row count is a production outage that no test graph reveals — the same class as a data-size decline. Cost must grow ~linearly (N log N at worst) in the rows flowing through it. Watch for: a join between two json_each snapshots or two CTEs with no index or positional key (nested loop = N²), a correlated subquery re-evaluated per outer row, a window or guard re-inlined in several statements. SCALING PROBE: time each witness at N≈1,000 and N≈8,000 traversers (seed a synthetic graph into a harness store — a bulk addV/addE or the formats loader); linear is ≈8×, N log N ≈10×; above ≈16× it is super-linear. Report the two timings. \`bun scripts/sql-plan.ts\` (EXPLAIN QUERY PLAN) shows a missing index path; it does NOT see json_each-to-json_each nested loops, so measure.
- GENERIC AT DEPTH. Extend the generic seam so the family composes anywhere — inside local/flatMap/map, union/choose/coalesce/optional arms, by() of a by(), where/filter/not, repeat bodies, after as()/select() — never special-case the named scenario. Prefer the existing authority over a new one (find it with \`bun scripts/refs.ts\`, not grep). Remove duplication you touch.
- DEFER, DON'T SHOEHORN. If an item needs a substrate that does not exist yet, say so and name the prerequisite. A clean UnsupportedTraversal now is better than a special case we will have to unpick.
- Cite vendor/tinkerpop/... (WHAT/WHY) and vendor/calcite/... (algebra) paths for semantics decisions; in doubt, read the reference rather than reasoning it out.
- GATE: \`mise run ci\` UNPIPED; the verdict is "CI passed" vs "ERROR task failed" in the output; on red read .logs/<task>.log. Baselines (l3-state, census, sql-hygiene) move only for an intended change, said in the commit. No new deps, never edit parser/, never force-push.
- Probe with bun + test/support/harness.ts (\`import { seededStore, run, bare } from '<checkout>/test/support/harness.ts'\`); \`bun scripts/rel-blockers.ts --step <name>\` lists blocked corpus traversals.
`

// One rubric for every reviewer and the skeptic, so severity cannot drift between prompts.
const RUBRIC = `
REACH (state it for every issue, naming the query): common = an ordinary app query (has/out/in/values/project/group/order/dedup/count, select/where over labels, property/addV/addE/mergeV upserts) at realistic sizes; plausible = real but less usual (side effects, map-valued properties, choose/coalesce/optional arms, federate, parameters at depth); contrived = only a constructed composition reaches it (e.g. a label, a map key and a side effect sharing one name; a label bound to null in one arm; sample() under nested coupling barriers). The 2026-11-03 audit found the loop spending ~650 lines and most of its fix-on-fix churn on contrived reach — do not repeat that.
WHERE PROBES COME FROM: the space of compositions is infinite, so a reviewer can always construct one more — that is the generator, not evidence about the system. Draw probes from (1) the .feature corpus: scenarios that use the changed steps, and their one-step neighbours; (2) ordinary app queries over the feature at realistic sizes; (3) L5 random traversals restricted to realistic shapes. A shape you had to CONSTRUCT (two names colliding, a null bound in one arm, barriers nested for their own sake) is contrived: report it with reach contrived and it is counted and dropped, never recorded as work.
DESIGN-SMELL SIGNALS (report as major, kind special-case, whatever the reach): a fix that adds a peephole, a next-step lookahead or a hand-written per-shape list where a fact should decide; the same common-reach wrong answer reappearing in a new place; a common query getting slower or gaining a per-row term.
SEVERITY (use exactly):
- blocker: a concrete traversal, NEWLY REACHABLE through this change (trunk declined it, answered it correctly, or ran it in linear time), that now gives a genuinely WRONG answer (rows, counts, elements, number class), crashes, leaks an internal or bare Error, declines on data size, or runs SUPER-LINEAR in traverser/row count (scaling probe ratio above ≈16× from N≈1k to N≈8k). Newly reachable is the whole test: it is a blocker EVEN WHEN the root cause predates this commit — this commit is what puts it in front of users. Contrived reach is NEVER a blocker and never a follow-up: report it with reach contrived (it is counted and dropped) unless the fix is a deletion or a consolidation onto an existing authority. Must include the traversal, its reach, and either what we return vs what the reference returns, or the two timings.
- major: built as a special case where an existing/obvious generic seam was available; duplicates an existing authority; Java-execution emulation with real SQL/JS/runtime cost; a per-row SQL term with no user-visible reason.
- major also: a fix whose cost is out of proportion to its reach — new per-row SQL, or more than ~100 src lines, for a contrived case.
- minor: citations, tests, naming, comments, docs.
NOT a defect: a divergence a user would find sensible under JS/SQLite semantics (see §17); a clean decline of a legal-but-unsupported composition (report it as a depth gap, minor).`

const DESIGN = { type: 'object', properties: {
  key: { type: 'string', description: 'kebab-case, unique' }, title: { type: 'string' },
  status: { type: 'string', enum: ['live', 'stale', 'needs-human'] },
  evidence: { type: 'string', description: 'what the probes showed on current trunk' },
  witnesses: { type: 'array', items: { type: 'string' } },
  seam: { type: 'string', description: 'the generic seam/authority it should extend (file:function)' },
  approach: { type: 'string' },
  sympathy: { type: 'string', description: 'how it stays natural to SQLite/JS; what it deliberately does not emulate' },
  after: { type: 'array', items: { type: 'string' }, description: 'keys of items that must land first' },
  human_question: { type: 'string' } }, required: ['key', 'title', 'status', 'evidence', 'seam', 'approach', 'sympathy'] }
const SCOUT = { type: 'object', properties: { items: { type: 'array', items: DESIGN } }, required: ['items'] }
const PLAN_REVIEW = { type: 'object', properties: {
  items: { type: 'array', items: { type: 'object', properties: {
    ...DESIGN.properties,
    decision: { type: 'string', enum: ['build', 'defer', 'merge', 'drop'] },
    merged_into: { type: 'string' }, prerequisite: { type: 'string', description: 'for defer: the missing substrate, phrased as a plan item' },
    review_notes: { type: 'string' } }, required: [...DESIGN.required, 'decision'] } } }, required: ['items'] }
const BUILD = { type: 'object', properties: {
  status: { type: 'string', enum: ['ready', 'deferred', 'stale', 'blocked', 'needs-human'] },
  sha: { type: 'string' }, base: { type: 'string', description: 'full sha you branched from (git rev-parse HEAD before checkout -b)' }, branch: { type: 'string' }, summary: { type: 'string' }, ci_passed: { type: 'boolean' },
  scaling: { type: 'string', description: 'per witness: time at N≈1k and N≈8k, and the ratio' },
  needs: { type: 'string', description: 'for deferred: the missing prerequisite' },
  needs_item: { type: 'string', description: 'for deferred: key of an item in THIS round that would unblock it, if any' },
  remaining: { type: 'string' }, human_question: { type: 'string' } }, required: ['status', 'summary'] }
const ISSUES = { type: 'object', properties: { issues: { type: 'array', items: { type: 'object', properties: {
  severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, detail: { type: 'string' }, file: { type: 'string' },
  reach: { type: 'string', enum: ['common', 'plausible', 'contrived'], description: 'who would write the query that shows it (see REACH)' },
  kind: { type: 'string', enum: ['wrong-answer', 'super-linear', 'decline', 'special-case', 'other'] } },
  required: ['severity', 'detail', 'reach', 'kind'] } }, probes_run: { type: 'number' } }, required: ['issues'] }
const TRIAGE = { type: 'object', properties: { confirmed: { type: 'array', items: { type: 'object', properties: {
  detail: { type: 'string' }, why: { type: 'string' } }, required: ['detail', 'why'] } } }, required: ['confirmed'] }
const LAND = { type: 'object', properties: { pushed: { type: 'boolean' }, pushed_sha: { type: 'string' }, ci_passed: { type: 'boolean' }, notes: { type: 'string' } }, required: ['pushed', 'notes'] }
const STEER = { type: 'object', properties: {
  trend: { type: 'string', enum: ['converging', 'flat', 'diverging'] },
  continue: { type: 'boolean' }, reason: { type: 'string' },
  next_batch: { type: 'number' }, focus: { type: 'string' } }, required: ['trend', 'continue', 'reason'] }
const SWEEP = { type: 'object', properties: { proposals: { type: 'array', items: { type: 'object', properties: {
  title: { type: 'string' }, existing: { type: 'string', description: 'file:function that could be re-expressed' },
  payoff: { type: 'string', description: 'lines removed / SQL or runtime / fewer concepts' } }, required: ['title', 'existing', 'payoff'] } } }, required: ['proposals'] }

const probeCheckout = (sha) => `For probes make a detached checkout: \`d=$(mktemp -d) && git -C ${REPO} worktree add --detach "$d" ${sha}\`, \`mise run install\` there, and \`git -C ${REPO} worktree remove --force "$d"\` when done. Never modify ${REPO}.`

const LENSES = [
  { key: 'depth', prompt: (it, b) => `${PRINCIPLES}${RUBRIC}
You are the DEPTH reviewer — adversarial. Item: ${it.title}. Commit ${b.sha}; diff \`git -C ${REPO} log -p HEAD..${b.sha}\` (or origin/trunk..). Builder's summary: ${b.summary}
${probeCheckout(b.sha)}
Try to REFUTE it, with probes drawn as WHERE PROBES COME FROM says. Aim for ~20: at least half ordinary queries a user of this feature writes, at N≈1k and 8k; the rest the corpus scenarios touching the changed steps and their one-step neighbours (one level of the GENERIC AT DEPTH hosts, each traverser shape the step admits, empty input, self-loops, multiplicity). Do not construct name collisions or nest barriers for their own sake. Label each finding's reach. For each that ANSWERS, check the rows against the reference's WHAT (the .feature corpus, then gremlin-core) — not Java's evaluation order. Also: does anything trunk DECLINED now answer differently from the reference?` },
  { key: 'sympathy', prompt: (it, b) => `${PRINCIPLES}${RUBRIC}
You are the SYMPATHY + SUBSTRATE reviewer. Item: ${it.title}. Commit ${b.sha}; diff \`git -C ${REPO} log -p HEAD..${b.sha}\`. Approved design: seam=${it.seam}; sympathy=${it.sympathy}. Builder's summary: ${b.summary}
Builder's scaling report: ${b.scaling || 'NONE — treat as unmeasured and measure it yourself'}
${probeCheckout(b.sha)}
Read the diff, not just the summary. Check: (1) does it emulate Java EXECUTION anywhere (ordering, laziness, error timing, number/text emulation) — what would the natural SQLite/JS answer be and would a user call it wrong? (2) PERFORMANCE GUARD — mandatory: re-run the SCALING PROBE yourself on the witnesses AND on every route the change newly opens (do not trust the builder's numbers); a super-linear ratio on a newly reachable route is a BLOCKER, with both timings. Then SQL cost: \`mise run sql-hygiene\`, compare emitted SQL for the witnesses before/after; any new per-row term or re-inlined subquery without a user-visible reason? (3) did it extend the generic seam or add a parallel one; did it duplicate an existing authority (\`bun scripts/refs.ts\`)? (4) any decline that depends on data size, or one added only to protect an emulation? (5) tests/citations/§17 lines — minor.` },
]

let landChain = Promise.resolve()
const onLandChain = (fn) => { const p = landChain.then(fn); landChain = p.catch(() => null); return p }

const allRounds = []
// The steward's verdict carries forward: how many items the next scout should pick, and what to focus on.
let steer = { next_batch: 0, focus: '' }
let barren = 0
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const batchRule = steer.next_batch
    ? `Pick ${Math.min(steer.next_batch, MAX_ITEMS)} open items (the steward's judgement from the last round).`
    : `Pick the items that are READY — prerequisites landed, design clear — one per independent seam, usually 4–8; items that chain are fine (set \`after\`), items that touch ONE seam merge into one. Never more than ${MAX_ITEMS}.`
  const focusRule = steer.focus ? `\nSTEWARD'S FOCUS for this round: ${steer.focus}` : ''
  phase('Scout')
  const scout = await agent(`${PRINCIPLES}
You are the SCOUT for round ${round}. Plan: ${REPO}/${PLAN}${SECTION}. The plan is a STALE POINTER, not a spec — the code is the authority. \`git -C ${REPO} fetch origin trunk\`; read the plan and the CLAUDE.md of each subsystem it touches. ${batchRule} Prefer, in order: substrate that other open items depend on (a prerequisite before its dependents — never pick an item whose prerequisite is still open unless that prerequisite is also picked), confirmed wrong answers already on trunk, items the plan's "next round" notes name, then the rest.${focusRule} For each, probe current trunk to confirm it is still real (status stale if not), then DRAFT A DESIGN: the generic seam it should extend, the approach, how it stays sympathetic to SQLite/JS, and which other items must land first (after). Read-only.`, { label: `scout#${round}`, phase: 'Scout', schema: SCOUT })
  if (!scout || !scout.items.length) { log('scout found nothing to do'); break }

  phase('Plan review')
  // A barrier on purpose: ordering, merging and deferral are cross-item decisions.
  const reviewed = await agent(`${PRINCIPLES}${RUBRIC}
You are the SYMPATHY PLAN REVIEWER — the earliest and cheapest place to stop Java emulation and one-off special cases. Below are the scout's draft designs for round ${round} of ${PLAN}. For EACH: is the seam really the generic one (check the code)? Does the approach emulate Java execution, add per-row SQL, or decline on data size? What is its REACH (common / plausible / contrived, with the query)? Drop or defer an item whose whole value is contrived reach unless it deletes code or consolidates an authority, and order common-reach items first. Revise the design where it does. Then decide across items: build | merge (two items share one seam — merge into the substrate item) | defer (needs a substrate that does not exist and is not in this round — name it as \`prerequisite\`, phrased as a plan item) | drop (stale/not worth it). Set \`after\` so substrate lands before what uses it; no cycles. Read-only.
DRAFTS:\n${JSON.stringify(scout.items, null, 1)}`, { label: `plan-review#${round}`, phase: 'Plan review', schema: PLAN_REVIEW, effort: 'high' })
  const designs = (reviewed ? reviewed.items : scout.items.map((i) => ({ ...i, decision: 'build' })))
  const toBuild = designs.filter((d) => d.decision === 'build' && d.status === 'live')
  const notBuilt = designs.filter((d) => !toBuild.includes(d))

  // Prerequisite DAG: unknown keys are dropped, and an edge that would close a cycle is dropped and logged.
  const keys = new Set(toBuild.map((d) => d.key))
  const deps = {}
  for (const d of toBuild) deps[d.key] = (d.after || []).filter((k) => keys.has(k) && k !== d.key)
  const reaches = (from, to, seen = new Set()) => from === to || (!seen.has(from) && (seen.add(from), deps[from].some((n) => reaches(n, to, seen))))
  for (const d of toBuild) deps[d.key] = deps[d.key].filter((k) => { const cyc = reaches(k, d.key); if (cyc) log(`dropped cyclic prerequisite ${d.key} -> ${k}`); return !cyc })

  const landed = {}
  for (const d of toBuild) { let resolve; landed[d.key] = { promise: new Promise((r) => { resolve = r }) }; landed[d.key].resolve = resolve }

  const runItem = async (it) => {
    const out = { key: it.key, title: it.title, followups: [] }
    try {
      const pre = await Promise.all(deps[it.key].map((k) => landed[k].promise))
      if (pre.some((p) => !p)) { out.outcome = 'deferred'; out.needs = `prerequisite in this round did not land: ${deps[it.key].join(', ')}`; return out }

      const buildPrompt = (base, issues, n) => `${PRINCIPLES}
YOUR ITEM: ${it.title}
Approved design (from the plan reviewer — follow it, or say why it is wrong): seam=${it.seam}; approach=${it.approach}; sympathy=${it.sympathy}${it.review_notes ? `; reviewer notes=${it.review_notes}` : ''}
Witnesses: ${JSON.stringify(it.witnesses || [])}
You are in an ISOLATED worktree. Provision with \`mise run submodule\` / \`mise run install\` if needed. \`git checkout -b wf/${it.key}-${round}-${n} ${base}\` and report the sha you branched from as \`base\`. Never merge: history stays linear.
${issues ? `A reviewer's CONFIRMED blockers on the previous attempt:\n${JSON.stringify(issues, null, 1)}\nFix each one generically, and look for siblings with the same root cause. If one cannot be fixed without missing substrate, narrow to a clean decline instead.` : `FIRST: if \`test -e ${STOP_FILE}\` succeeds, a graceful stop was requested — do nothing and return status blocked with needs "stop requested". Otherwise first re-probe the witnesses. If the approved design turns out to need a prerequisite that does not exist, STOP: return status deferred with \`needs\` (and \`needs_item\` if one of this round's items is it). Do not shoehorn it in.`}
Build at depth in the seam, probe a few deeper compositions, add tests the ladder expects. Before committing, run the SCALING PROBE on the witnesses and the deeper compositions; if a ratio is super-linear, fix the shape (an indexed or positional join, one MATERIALIZED relation) — or, if that needs substrate that does not exist, return deferred naming it rather than landing a quadratic route. Report the timings in \`scaling\`. \`mise run ci\` green, commit. Do not push.`

      let b = await agent(buildPrompt('HEAD', null, 0), { label: `build:${it.key}`, phase: 'Build', isolation: 'worktree', schema: BUILD })
      // Dynamic re-ordering: the builder found that another item in this round is its prerequisite.
      if (b && b.status === 'deferred' && b.needs_item && landed[b.needs_item] && !deps[it.key].includes(b.needs_item) && !reaches(b.needs_item, it.key)) {
        log(`${it.key}: waits for ${b.needs_item}, then retries`)
        deps[it.key].push(b.needs_item)
        if (await landed[b.needs_item].promise) b = await agent(buildPrompt('HEAD', null, 1), { label: `build:${it.key}#retry`, phase: 'Build', isolation: 'worktree', schema: BUILD })
      }
      if (!b || b.status !== 'ready' || !b.ci_passed || !b.sha) { Object.assign(out, { outcome: b ? b.status : 'failed', needs: b && b.needs, human_question: b && b.human_question, summary: b && b.summary }); return out }

      let lenses = LENSES
      for (let fix = 0; ; fix++) {
        const reviews = await parallel(lenses.map((l) => () => agent(l.prompt(it, b), { label: `review:${l.key}:${it.key}${fix ? '#' + fix : ''}`, phase: 'Review', schema: ISSUES }).then((r) => ({ lens: l, issues: r ? r.issues : [] }))))
        const found = reviews.filter(Boolean)
        // Contrived reach is counted, not recorded (a design smell is kept whatever its reach). Majors are all kept;
        // minors are capped so the plan doc does not fill with noise. Both drops are logged.
        const all = found.flatMap((r) => r.issues.filter((i) => i.severity !== 'blocker').map((i) => ({ lens: r.lens.key, ...i })))
        const nonBlocking = all.filter((i) => i.reach !== 'contrived' || i.kind === 'special-case')
        out.contrived = (out.contrived || 0) + all.length - nonBlocking.length
        out.contrivedFindings = (out.contrivedFindings || []).concat(all.filter((i) => !nonBlocking.includes(i)).map((i) => i.detail.slice(0, 300)))
        if (all.length > nonBlocking.length) log(`${it.key}: dropped ${all.length - nonBlocking.length} contrived-reach finding(s)`)
        const minors = nonBlocking.filter((i) => i.severity === 'minor')
        if (minors.length > MAX_MINORS) log(`${it.key}: kept ${MAX_MINORS} of ${minors.length} minor follow-ups`)
        out.followups.push(...nonBlocking.filter((i) => i.severity === 'major'), ...minors.slice(0, MAX_MINORS))
        const blockers = found.flatMap((r) => r.issues.filter((i) => i.severity === 'blocker').map((i) => ({ lens: r.lens.key, ...i })))
        let confirmed = []
        if (blockers.length) {
          const t = await agent(`${PRINCIPLES}${RUBRIC}
You are the SKEPTIC. Reviewers flagged these as BLOCKERS on commit ${b.sha} (${it.title}). For each, try to REFUTE it: reproduce the traversal yourself, and ask whether a user would actually call our answer wrong or whether it is a sensible JS/SQLite divergence or a Java-execution detail. Also refute on REACH: if only a contrived composition reaches it, downgrade it to a minor marked contrived and say so. Keep only what survives. Default to refuted when uncertain.
${probeCheckout(b.sha)}
BLOCKERS:\n${JSON.stringify(blockers, null, 1)}`, { label: `skeptic:${it.key}${fix ? '#' + fix : ''}`, phase: 'Review', schema: TRIAGE })
          confirmed = t ? t.confirmed : blockers
        }
        if (!confirmed.length) break
        if (fix >= FIX_ROUNDS) { Object.assign(out, { outcome: 'parked', open: confirmed, sha: b.sha }); return out }
        log(`${it.key}: ${confirmed.length} confirmed blocker(s), fix round ${fix + 1}`)
        const f = await agent(buildPrompt(b.sha, confirmed, fix + 2), { label: `fix:${it.key}#${fix + 1}`, phase: 'Review', isolation: 'worktree', schema: BUILD })
        if (!f || f.status !== 'ready' || !f.ci_passed) { Object.assign(out, { outcome: 'parked', open: confirmed, sha: b.sha, needs: f && f.needs }); return out }
        // The item's commits start at the ORIGINAL build's base; a fix stacks on b.sha.
        b = { ...f, base: b.base }
        const blocked = new Set(confirmed.map((c) => c.lens).concat(blockers.map((x) => x.lens)))
        lenses = LENSES.filter((l) => blocked.has(l.key))
      }

      const l = await onLandChain(() => agent(`${PRINCIPLES}
You are the LANDER in the MAIN checkout ${REPO} (branch trunk). Land ${b.sha} (${it.title}): its commits are exactly \`git -C ${REPO} log --reverse --format=%H ${b.base || 'HEAD'}..${b.sha}\` — take that range from its base, NOT from HEAD: the main checkout has moved (and its local doc commits were rewritten by rebase) since the builder branched, so HEAD..sha would drag stale commits in.
1. \`git fetch origin trunk\`; tree clean; \`git rebase origin/trunk\` (local plan-doc commits ride along). 2. cherry-pick that range on top (never merge — trunk stays linear); resolve conflicts preserving both intents; baselines: take trunk's and re-record via the proper task. 3. \`mise run ci\` UNPIPED; red -> small principled fix-forward, or reset to the pre-cherry-pick tip and report pushed=false. 4. green -> \`git push origin trunk\` (fetch-first rejection: fetch, rebase, re-run ci, push; never force). 5. Mark the item in ${PLAN} (what landed, one-line mechanism pointer, what remains: ${b.remaining || 'nothing'}) and commit that LOCALLY — do not push it.`, { label: `land:${it.key}`, phase: 'Land', schema: LAND }))
      Object.assign(out, { outcome: l && l.pushed ? 'landed' : 'land-failed', pushed_sha: l && l.pushed_sha, summary: b.summary, remaining: b.remaining, notes: l && l.notes })
      return out
    } finally {
      landed[it.key].resolve(out.outcome === 'landed')
      log(`${it.key}: ${out.outcome}`)
    }
  }

  const results = (await parallel(toBuild.map((it) => () => runItem(it)))).filter(Boolean)
  const shipped = results.filter((r) => r.outcome === 'landed')

  phase('Sweep')
  // Proposals only — they become next-round plan items, never edits in this round.
  const sweep = shipped.length ? await agent(`${PRINCIPLES}
You are the REUSE SWEEPER. These landed on trunk this round:\n${JSON.stringify(shipped.map((s) => ({ title: s.title, sha: s.pushed_sha, summary: s.summary })), null, 1)}
For each new seam/authority, look for EXISTING features that hand-roll the same thing or could be re-expressed on it (\`bun scripts/refs.ts\`, read the callers). Propose only moves with a concrete payoff (lines removed, less SQL, one fewer concept) and no change in answers. Read-only; do not edit.`, { label: `sweep#${round}`, phase: 'Sweep', schema: SWEEP }) : null

  phase('Record')
  const record = await onLandChain(() => agent(`${PRINCIPLES}
You are the RECORDER in the MAIN checkout ${REPO} (trunk). Update ${PLAN} so the NEXT round can start from it, then commit LOCALLY:
- DEFERRED/PARKED items: why, and the prerequisite phrased as a plan item ordered BEFORE the item it unblocks. Where several parked items share a root cause, say so once and propose the one substrate item.
- Follow-ups from review (major first; skip minor unless cheap and concrete).
- Reuse-sweep proposals, under a "next round" heading.
- Needs-human questions, verbatim.
- CONTRIVED findings (each result's `contrivedFindings`) do NOT go in ${PLAN}. Append each as ONE line to `${REPO}/.logs/contrived-findings.md` (gitignored, local, a lookup for when a user reports a bug — never a worklist): `<date> | <item key> | <the query> | <what we return vs the reference>`, ≤200 chars, no prose.
Then check CI of each pushed sha (\`gh run list --commit <sha>\`, \`gh run view <id> --log-failed\` if red) and report. If no code was pushed this round, push the doc commit so it is not stranded (fetch/rebase first, never force).
CLEANUP — only what THIS round created, only what is provably on trunk. Candidates are the local branches named \`wf/<key>-${round}-<n>\` (every n — the build and its fix branches) for the keys in ROUND RESULTS whose outcome is \`landed\`. Proof of landing is the lander's \`pushed_sha\`, NOT \`git cherry\` (a cherry-pick that resolved conflicts changes the patch-id, so cherry reports landed work as unlanded): \`git fetch origin trunk && git merge-base --is-ancestor <pushed_sha> origin/trunk\` must succeed. If it does, for each of that key's branches remove the worktree that has it checked out (\`git worktree list --porcelain\` gives the path). Git refuses to remove a worktree containing submodules without --force, and every worktree here has them, so: confirm \`git -C <path> status --porcelain\` is EMPTY and every entry under \`<path>/vendor/\` is a SYMLINK into the main checkout (that is how worktrees share vendor — see CLAUDE.md; removing the link does not touch the shared submodule), and only then \`git worktree remove --force <path>\`. If either check fails, leave the worktree and say why. Then remove the branch (\`git branch -D <branch>\` — -D only because a cherry-picked branch is never an ancestor, which is why the pushed_sha check comes first). Leave every branch of an item that did not land, or whose pushed_sha is missing or not on origin/trunk, untouched (unlanded work — a parked item's branch is the resume point; name it in the plan). Do not touch any other branch or worktree; list stale \`wf/*\` branches from earlier rounds in your report instead. If a removal is refused, record it and carry on.
ROUND RESULTS:\n${JSON.stringify({ results, notBuilt: notBuilt.map((d) => ({ key: d.key, title: d.title, decision: d.decision, status: d.status, prerequisite: d.prerequisite, merged_into: d.merged_into, human_question: d.human_question })), proposals: sweep ? sweep.proposals : [] }, null, 1)}`, { label: `record#${round}`, phase: 'Record' }))

  // Counted in code so the steward judges a trend from facts, not from re-reading prose.
  const earlierParked = new Set(allRounds.flatMap((r) => r.tally.parked))
  const followups = results.flatMap((r) => r.followups || [])
  const tally = {
    picked: designs.length, built: toBuild.length,
    landed: shipped.map((r) => r.key),
    parked: results.filter((r) => r.outcome === 'parked').map((r) => r.key),
    deferred: results.filter((r) => r.outcome === 'deferred').map((r) => r.key).concat(notBuilt.filter((d) => d.decision === 'defer').map((d) => d.key)),
    reparked: results.filter((r) => r.outcome === 'parked' && earlierParked.has(r.key)).map((r) => r.key),
    new_majors: followups.filter((f) => f.severity === 'major').length,
    new_minors: followups.filter((f) => f.severity === 'minor').length,
    new_proposals: sweep ? sweep.proposals.length : 0,
    // The stopping signal: wrong answers / super-linear routes a real user's query reaches. Zero in a round = converged.
    real_findings: followups.filter((f) => f.reach !== 'contrived' && (f.kind === 'wrong-answer' || f.kind === 'super-linear')).length,
    design_smells: followups.filter((f) => f.kind === 'special-case').length,
    contrived_dropped: results.reduce((n, r) => n + (r.contrived || 0), 0),
  }
  allRounds.push({ round, tally, results, notBuilt, proposals: sweep ? sweep.proposals : [], record })
  log(`round ${round}: landed ${tally.landed.length}/${tally.built}, parked ${tally.parked.length}, deferred ${tally.deferred.length}; added ${tally.new_majors} majors, ${tally.new_proposals} proposals`)

  // Hard stops only; everything else is the steward's call.
  barren = shipped.length ? 0 : barren + 1
  if (barren >= 2) { log('two rounds in a row landed nothing — stopping'); break }
  if (round === MAX_ROUNDS) { log(`hit the maxRounds backstop (${MAX_ROUNDS}) — stopping; the steward would have been asked next`); break }

  phase('Steer')
  const s = await agent(`${PRINCIPLES}
You are the STEWARD of a multi-round run over ${PLAN}${SECTION}. Decide whether another round is worth it, and shape it. Read-only, with one exception: if \`test -e ${STOP_FILE}\` succeeds, a graceful stop was requested — \`rm ${STOP_FILE}\` and return continue=false, reason "stop requested", without further analysis.
Read the plan's "Next round" sections (newest first) and §10's open items, then judge the TREND across rounds from these tallies:
${JSON.stringify(allRounds.map((r) => ({ round: r.round, ...r.tally })), null, 1)}
CONVERGING looks like: what lands closes more than review and the sweep add (weigh majors and confirmed wrong answers heavily, minors and reuse proposals lightly); prerequisites land and the items waiting on them become unblocked; parked items stop recurring; the confirmed-wrong-answers-on-trunk list shrinks.
DIVERGING looks like: each round adds more majors/wrong answers than it resolves; the same root cause parks again (reparked is a strong signal); items keep deferring on a prerequisite no round picks; the work drifts out of ${SECTION || 'the plan'} into an ever-wider list.
Decide:
- continue=false, reason "converged", when the latest round's real_findings is 0: no common/plausible wrong answer or super-linear route turned up, so what is left is the contrived tail, and chasing it is drift (contrived_dropped is NOT work remaining). Also continue=false when the trend is diverging for a second round, when what remains needs a human design decision, or when the section's real work is done (only minors/proposals left). Say which.
- Watch design_smells: special-case fixes recurring, common wrong answers reappearing in new places, or common queries slowing are signs of a missing abstraction — name them in reason for the owner, and stop if they recur across two rounds.
Surfacing PRE-EXISTING wrong answers on trunk is the run doing its job, not divergence, when they collapse onto a named substrate root with a concrete fix: count that as progress toward maturity. It is divergence only when the new majors are scattered one-offs or the same root keeps parking.
- continue=true otherwise, with next_batch (1–${MAX_ITEMS}): fill one slot per INDEPENDENT seam — parallel agents are welcome, so be generous. Chaining is NOT a reason to shrink (the round orders items by \`after\` and a dependent simply waits for its prerequisite); shrink only when items parked or two items collided on ONE seam — fold those into one item instead.
- Rank by REACH: common-reach wrong answers, data-size declines and super-linear routes first; a family whose witnesses are all contrived is low priority however many root causes it surfaces — never the focus.
- focus: the one or two things the next scout must pick first — usually the substrate a parked/deferred item is waiting on, or a recurring root cause — so the next round resolves rather than widens.`, { label: `steward#${round}`, phase: 'Steer', effort: 'high', schema: STEER })
  allRounds[allRounds.length - 1].steer = s
  if (!s || !s.continue) { log(`steward: stop — ${s ? s.reason : 'no verdict'}`); break }
  steer = s
  log(`steward: ${s.trend}, continue with ${s.next_batch} — ${s.focus}`)
}

return allRounds
