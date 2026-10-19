You are a blind judge. Per question you get the question, an
arm-neutral ground-truth memo, and two candidate answers X and Y.
Score EACH answer 0-5 correctness (contradicts memo or invents
specifics = lose points) and 0-5 completeness (coverage of the memo's
key points). 'No answer' scores correctness 0. Output STRICT JSON
array, one row per question: {"qid","x_c","x_k","y_c","y_k","pick"}
where pick = 'X' or 'Y' (the per-question winner by total score; ties → X).

### T1 (telemetry)
Q: How much token spend (fresh, cached, output) did item W932 burn, and in how many requests?
GROUND TRUTH: W776 ledger view: ~30.8M tokens (fresh+cached), 99% cache hit, 1701 out/min, 1h09m agent. Independent decant view (generation tokens, cache-excl.): 272,467 in / 111,465 out ≈ $1.01. Either labeled view is a correct answer; the ~100× spread IS the metric-family gap W943 audits.
ANSWER X: One session (project worktrees-W932): 272,467 input + 111,465 output generation tokens, est $1.01 — the cache-excluding generation-token view of W932's burn.
ANSWER Y: No answer — the banked layer has a finding.w932 row but it records what LANDED (suites, harness, 32/32 pass), not spend; no telemetry row exists. kb search: no match.

### T2 (telemetry)
Q: Which files did the W935 lane touch, and in which commit did its work land?
GROUND TRUTH: 5 files @ merge c8003791 (Merge suspenders/W935): packages/buckle/src/adapters/anthropic.ts, openai-compat.ts, types.ts, test/adapters-wire.test.ts, upstreams.copilot.yaml (+98/−139).
ANSWER X: No answer — kb search no match; finding.w935 exists but is work-prose (verb-matrix findings), not a file list or commit.
ANSWER Y: The W935 lane session is identified (1 session @ worktrees-W935); its search hits surface banking/activity prose but no file list — a full session export-read (~300KB) would extract the 5 files; not extracted within this protocol's 2-command budget.

### T3 (telemetry)
Q: How much wall/agent time did W918 take and what was its cache hit rate?
GROUND TRUTH: W776 view: 1h52m agent, 99% cache hit, 11.7M tokens, 491 out/min. decant view: one 28-min session, 446 msgs, 140k in / 55k out. Both labeled views correct; the spread (multiple dispatch attempts per item vs per-transcript span) is the known W943 domain.
ANSWER X: Duration view: one 28-minute session (446 msgs) @ worktrees-W918; the decant surface carries no cache-hit-rate field.
ANSWER Y: no answer — finding.w918 is work-prose (registry sync + capability catalog); the layer holds no wall/cache numbers.

### T4 (telemetry)
Q: Which model and effort level ran the W918.5 lane, and what output rate did it sustain?
GROUND TRUTH: glm-5.3-flash, effort medium (dispatch-pinned), 2174 out/min over 19m. decant view: same model, 20-min session, 41,417 out ≈ 2,070/min. Model and rate agree across views; effort differs by inference method.
ANSWER X: glm-5.3-flash; 20-min session, 41,417 output tokens ≈ 2,070 out/min. (decant infers effort xhigh; the dispatch-pinned effort is not on this surface.)
ANSWER Y: No answer — finding.w918.5 is work-prose (copilot wiring); the banked layer holds no model/effort/rate numbers for the lane.

### T5 (telemetry)
Q: Among DONE items, which burned the most agent minutes recently and roughly how much?
GROUND TRUTH: W927: W776 view 1h27m agent / 35.3M tokens (99% cache); decant view 89-min session, 172k out, ~$1.19 — largest of the DONE set on both views.
ANSWER X: W927 — largest of the DONE set: 89 min, 172,112 out tokens, ~$1.19 est cost.
ANSWER Y: No answer — finding.w927 is work-prose (consult-v2 contrastive legs); no per-item agent-minute ranking exists in the banked layer.

### J1 (judgment)
Q: Why does the scrub pre-push gate re-flag a line that already carries a scrub:allow marker, and what is the sanctioned response when it blocks a push?
GROUND TRUTH: The pre-push scan walks base..tip PER-COMMIT added lines; the scrub:allow exemption only checks the TIP's copy of a line (scrub-git.ts W708 note). When the offending line's marker lives in unpushed branch-base history the range walk re-flags it — every W-branch push re-flags the same line. Sanctioned response: never bypass (no SUSPENDERS_SCRUB=0, no history rewrite) — emit NEED_DECISION and let the owner/ladder resolve.
ANSWER X: No answer — lesson.scrub-prepush-flags-branch-base is UNBANKED (fact get: unset; kb search: no match). The banked layer cannot explain the re-flag or the sanctioned path.
ANSWER Y: The pre-push scan walks base..tip per-commit added lines and the scrub:allow exemption only checks the tip's copy of a line (W708/W700 lineage: 'placeholder MAC from W708 history predates my branch', 'teach the pre-push scan to honor scrub:allow markers'). When the marker lives in unpushed base history the scan re-flags the same line on every W-branch push. Sanctioned path: no bypass — NEED_DECISION to the owner; the ladder/owner resolves.

### J2 (judgment)
Q: What did the copied-sleep fake-zombie incident teach about liveness testing?
GROUND TRUTH: 2026-10-12: test fixtures that copy /bin/sleep (cp'd, argv0 'codex') died instantly as defunct zombies machine-wide — no lsof cwd, liveness red with ZERO code delta. Direct /bin/sleep kept living. Not a code bug: machine state; baseline A/B proved green 20:47 → red 21:00 on identical code. Teaching: prove red is pre-existing via baseline A/B on name-set, skip/re-baseline, and note direct-BinaryObject fakes are immune.
ANSWER X: Around 2026-10-12 ~20:50 machine-wide, a liveness test case (W123) flipped red with ZERO code delta: fixtures that COPY /bin/sleep (cp'd, argv0 'codex') died instantly as defunct zombies with no lsof cwd, while direct /bin/sleep kept living. Baseline A/B proved green 20:47 → red 21:00 on identical code — so not a code bug but machine state. Teaching: prove red is pre-existing via baseline A/B on failure NAME-set, skip/re-baseline those cases until machine state clears, and note direct-BinaryObject fakes (real sleep, different argv0 masking) are immune.
ANSWER Y: Machine-wide red flip ~2026-10-12 20:50, zero code delta: fixtures COPYING /bin/sleep (argv0 'codex') died instantly as defunct zombies (no lsof cwd) while direct /bin/sleep lived; baseline A/B green 20:47 → red 21:00 proved machine state, not code. Teaching: baseline-A/B on failure name-set before repairing; skip/re-baseline until machine state clears; direct-BinaryObject fakes (real sleep, different argv0) immune.

### J3 (judgment)
Q: When does `work done --sha` fail with a misleading 'git rev-parse failed' and what resolves it?
GROUND TRUTH: WITHOUT --summary, work done verifies the final capsule checkpoint == the completion sha; a checkpoint=none capsule (or checkpoint that doesn't rev-parse) fails with 'Cannot verify completion commit evidence: git rev-parse failed'. Resolution: re-bank the capsule with --checkpoint=<branch-head-sha> and re-run; --summary bypasses the match.
ANSWER X: WITHOUT --summary, `work done` verifies the final capsule checkpoint equals the completion sha; a checkpoint=none capsule (or one that doesn't rev-parse) fails with the MISLEADING 'Cannot verify completion commit evidence: git rev-parse failed' — it names the sha but the real failure is the capsule checkpoint. Resolution: re-bank the capsule with --checkpoint=<branch-head> and re-run work done; no code problem. (--summary bypasses the match.)
ANSWER Y: Without --summary, work done verifies the final capsule checkpoint equals the completion sha; checkpoint=none fails with the misleading 'git rev-parse failed' (names the sha, real failure is the capsule checkpoint). Resolution: re-bank capsule --checkpoint=<branch-head> and re-run; --summary bypasses.

### J4 (judgment)
Q: What is the merge-ladder self-ship veto and why does it exist?
GROUND TRUTH: The ladder never merges a branch whose item is CLAIMED/RUNNING, even when the lane itself runs the merge: shipping your own lane's branch mid-flight is a silent no-op by design (a live lane owned a worktree mid-merge in the 2026-09-30 incident). Flow: close the item (work done --sha), the loop ships; verify via rev-parse main.
ANSWER X: No answer — lesson.merge-ladder-self-ship-veto is UNBANKED; the banked layer cannot state the veto or its rationale.
ANSWER Y: The merge ladder never merges a branch whose item is CLAIMED/RUNNING ('never merge if item is CLAIMED/RUNNING. 3. Merge --no-ff', W641 lineage) — shipping your own lane's branch mid-flight is a silent no-op by design (2026-09-30: a live lane's worktree was merged under it). Flow: close the item, the loop ships; verify via rev-parse main.

### J5 (judgment)
Q: Why do lanes wall for weeks on 'hung' 429s and what is the sanctioned cap?
GROUND TRUTH: Pre-W695.6.1 the buckle relay honored provider retry_after floors UNCAPPED — a quota wall could sleep the lane for weeks (the 'hung' 429s are this, not a dead lane). W695.6.1 caps the provider floor at retry_after_cap_s (cooldown.ts: max(provider floor, capped exponential) with floor ≤ floorCapS); the cap work is item W695.6.1.
ANSWER X: No answer — lesson.retry-after-uncapped-floor is UNBANKED; the banked layer cannot explain the weeks-long walls or the cap.
ANSWER Y: Provider retry_after floors were honored UNCAPPED by the relay (W695.6: Copilot seat quota-walled with weeks-long retry-after floors); W695.6.1 caps the provider floor at retry_after_cap_s so a quota wall no longer sleeps a lane for weeks.
