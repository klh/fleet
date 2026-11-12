## Official Pi Durable seed recovery smoke (W2960)

The experimental ARM64 OCI seed ran Earendil Pi Durable 1.5.0 on Docker
Desktop. Five warm-image one-shot readiness runs took 186, 217, 206, 220
and 199 ms from `docker run` through exit (median 206 ms). This is a
readiness check, separate from the OpenHands persistent service startup
measurement.

An offline in-flight replacement witness used a host-mounted fsynced JSONL
store. A task committed its effect intent, appended a marker, and was held
before committing its outcome. The container was killed with SIGKILL
(exit 137) and removed. A new container reopened the same conversation
and task, settled the task as completed, and observed one marker. This
covers loss after the effect and before its outcome. Loss before the
effect, model credential rotation, and real microVM recovery remain open.

A separate offline scripted tool smoke ran the official CodingTools in a
host harness against a fixed-path ExecutionEnv fixture. A non-root Docker
guest supplied the bytes, accepted the edit, and verified the changed
content through a shell command. The fixture did not implement the full
remote environment contract or guest replacement.

### Buckle output-budget control

On the W2960 Anthropic Messages route, a single GLM-5.3 Flash request
with `max_tokens: 8192` returned HTTP 200, `end_turn`, 57 input tokens
and 7,809 output tokens in 112.019 seconds. The response contained all
600 requested synthetic lines. The scoped five-minute key was revoked.
This establishes that the route can exceed the previous 4,096-token
request setting on a plain-text turn. It does not measure an agentic
patch or establish how the upstream accounts for a tool-heavy failed
turn. Use the same 8,192 limit in both arms of the next comparison and
record per-request stop reasons and usage.

### Anthropic baseline and native Buckle catalog

At the higher turn budget, both Anthropic benchmark arms completed
the same Relay revision and passed 22/22. Pi took 157.893 s and
OpenHands 313.281 s. The pair is an observation with one run per arm,
different harness turn semantics and uncontrolled provider cache.

With the Anthropic shim omitted in the isolated fixture, both clients
discovered 21 routes from Buckle and selected the same GLM-5.3 Flash
route. Pi completed in 206.787 s with a 21/22 patch. OpenHands produced
a 21/22 patch before the 451.616 s wall-time cutoff. The first OpenHands
native attempt was excluded because the test relay rejected the
OpenAI `max_completion_tokens` spelling. The retry enforced the same
8,192-token bound for both spellings and forwarded the body unchanged.
Both patches missed the version-00 trace requirement. Native routing
worked in the fixture, but the pair did not match the baseline quality.
The scoped keys were revoked. No production route changed.

## Pi Durable delegation

Track supervisor and worker results separately from container startup and
microVM performance. The comparison is a single Pi Durable runner versus
a Pi Durable supervisor that launches separate Pi Durable workers and
joins their patches. Judge both with the same private oracle, fixture
revision, model route, and aggregate budget. Record total parent and child
usage, completion, and isolation outcomes. Local worker sessions do not
establish Fleet dispatch or restart-safe admission. W2971 and W2973
track the Fleet integration and matched benchmark.

Measure four orchestration arms on a larger held-out task: one session
with serial tools, one session with parallel tools and Fleet locks,
one Pi supervisor with independent Pi workers, and peer Pi lanes with
Fleet coordination. Pin the total budget and judge the integrated patch.
Include lock wait, file conflicts, worktree reconciliation and review
in elapsed time. Keep multi-level delegation a separate arm. The pinned
SDK exposes `toolExecution` with parallel and sequential modes. Actual
tool overlap requires asynchronous dispatch and timestamped tool results.

The initial local Relay fan-out completed in 230.980 s with 70,929
reported tokens across supervisor and workers. The supervisor settled,
but the trace worker was unanswered and produced no assigned patch.
Claim and cache patches imported cleanly, for 15/22 overall. The earlier
single-runner control on the same fixture and model passed 22/22 in
157.893 s with 45,074 reported tokens. These are diagnostic observations,
not a matched aggregate-budget comparison. The worker arm overlapped
with a separate routing test and used separate briefs and independent
per-run limits. No Fleet dispatch or microVM was involved.

The larger canonical fixture is SWE-bench Verified
`sphinx-doc__sphinx-9461` at `939c7bb7ff7c53a4d27df067cea637540f0e1dad`.
Its reference change spans three source files. The official evaluation
spec has 3 fail-to-pass and 59 pass-to-pass checks. Keep the official
patches and tests outside agent worktrees and verify the evaluator
controls before collecting timings. The case is public, so treat
possible training overlap as a limitation.

With SWE-bench 4.1.0 and the pinned amd64 evaluator image, the base
failed all three target checks and passed all 59 regressions. The
reference passed 62/62. The first serial Pi arm used the official issue
brief and Buckle's native OpenAI-compatible route. It reached the 450 s
deadline without a source edit. The tool sandbox was writable, ran as
UID 1000, and had Python available. The scoped key was revoked and the
container removed. This is a timed-out baseline with no accepted patch.
The driver did not retain per-turn telemetry on timeout, so the delay
cannot yet be attributed to inference, tool execution or exploration.


The instrumented serial retry and parallel-tool arm used the same
fixture, model route and 8,192-token per-call limit.

| Sphinx arm | Wall time | Tool calls | Reported tokens | Result |
| --- | ---: | ---: | ---: | --- |
| Serial tools | 237.982 s | 30 | 210,554 | Unanswered, no patch |
| Parallel tools with read-only inspection and Fleet-locked writes | 450.256 s | 23 | 233,857 | Deadline, no patch |

Parallel starts 1–2 ms apart overlapped calls lasting about 80–290 ms.
One 162 s gap between command groups dominated those savings. The trace
does not isolate model generation from routing delay. No speed or cost
per accepted patch can be reported. Both scoped keys were revoked.
Parallel tool-end logging reused the latest call counter, so the early
overlap evidence relies on start timestamps and measured durations.

The first built-in subagent arm exhausted its shared 30-command
allowance before the parent could integrate. It timed out at 450.216 s
with 249,701 reported tokens, 51 command attempts and no patch. Exclude
that setup from comparison. A retry reserved 20 commands for the parent
and 5 for each of two read-only children. It dispatched 10 commands
and timed out at 450.244 s with 66,011 reported tokens. No child
settlement was observed and no patch was produced. The reservation
prevented budget starvation, but did not establish a completed
handoff. Both scoped keys were revoked.

A separately traced serial run joined client SSE timing to Buckle
attempts. Two expensive requests took 82.904 s and 40.845 s with no
recorded provider queue wait and one upstream attempt each. The first
streamed for about 79.5 s after headers before usable content and
reported 5,113 reasoning tokens. Across the first 15 completed requests,
model calls took 219.880 s. The first 24 shell calls took 11.080 s
combined. The request body grew from about 3 KB to 85 KB. This establishes
where wall time accrued, without attributing the longer generation
to prompt size alone.

The traced run ended unanswered at 280.803 s with 33 attempted tool
calls and 30 dispatched. Its 24 completed model requests accounted for
266.119 s and the dispatched tools for 14.350 s. It created reproduction
tests, with no production patch. A separate slow request took 27.050 s
to upstream headers with no recorded queue wait, showing that not every
slow turn was post-header reasoning.


An isolated environment probe also reproduced the agent's failed
`import pytest`: the benchmark runner defaulted to the base Conda
interpreter, while `/opt/miniconda3/envs/testbed/bin/python` had pytest
8.3.3 and Sphinx 4.2.0. Set the testbed environment consistently in both
arms before comparing their test and integration behavior.

A clean serial rerun started with the correct Conda interpreter on
PATH. It still produced no source patch, ending unanswered at 322.010 s
after 35 command attempts and 314,773 reported tokens. The trace shows
attempts to download packages despite the offline sandbox, and repeated
source discovery. Fixing PATH alone did not resolve the exploration
problem.

The preflight and batch treatment injected the offline/testbed contract
and a short source map from the unmodified base. It exposed an asynchronous
read-only batch tool with clipped output. The first successful tool result
arrived at 7.838 s. The run issued 10 model requests and ran 28 commands
(27 in batches), then timed out at 450.246 s with a clean source tree.
Completed requests reported 177,988 tokens, including 18,974 reasoning
tokens. Nine completed model streams accounted for 356.527 s. The tenth
returned headers at 373.108 s and remained open until cancellation.
Tool durations summed to 8.061 s, including overlapping commands. The
scoped key was revoked. This run produced no patch for the private grader.

The benchmark driver set a 32,000-token context window, an 8,192-token
output cap, and disabled compaction. Pi AI 1.5.0
(`dist/api/simple-options.js`) subtracts estimated context and a
4,096-token reserve from the configured window, then clamps the output
allowance between one token and the output cap. The client sent 8,192
for the first five calls, followed by 3,806, 1,476, 1, 1 and 1.
The final stream stalled after headers. Two prior one-token requests
returned tool calls, so the clamp explains the request value but does
not by itself explain the upstream stall. The preflight and batch
changes were tested together, so this run does not isolate their effects.

A scoped probe of the exact native Buckle route, `zai-glm-5.3-flash`,
found no context or output limit in its live model catalog row. A
synthetic non-streamed request with a 128-token output cap succeeded
with 51,950 prompt tokens and 20 completion tokens, returned the
expected answer, and reported stop. The probe key was revoked. This
establishes a working point above the driver's 32,000-token setting.
It does not establish the maximum window or guarantee that a long
prompt plus a full 8,192-token generation fits. Use a common conservative
window and compaction threshold for the next matched pair. Track the
first production edit, first targeted test and effective output allowance.

In the matched 48,000-token serial arm, request 2 sent an 8,192-token
output cap but reported 21,563 completion tokens, of which 21,360 were
reasoning. First visible content arrived at 352.334 s, and the stream
completed at 354.621 s with tool calls. Buckle trace
`2eb5359b75f8a3e19880630e7d8ba083` records one upstream attempt,
zero queue wait, and headers at 1.867 s. This is a completed slow stream
even with full client output headroom. Verify the forwarded cap and
provider reasoning-budget semantics before concluding where enforcement
diverged.

Static inspection of the pinned Pi AI client shows why the request may
be treated differently from a direct Z.AI call. The generic
`buckle-test` provider and localhost URL select
`max_completion_tokens` by default. Pi's Z.AI compatibility selects
`max_tokens` and emits a provider-specific thinking setting when the
model is marked reasoning-capable. The benchmark registered the model
as `reasoning:false`, which leaves that setting absent. Buckle's generic
OpenAI adapter preserves these body fields. Capture the outgoing field
name and test the two spellings and explicit thinking control on the
exact deployed route before changing the benchmark policy.

The scoped four-call non-streamed probe on that route requested 24
tokens with the same prime-list prompt. Both `max_completion_tokens`
requests timed out at 18 s, with thinking omitted and explicitly
disabled. Both `max_tokens` requests returned HTTP 200 and exactly 24
completion tokens. With thinking omitted it took 1.894 s (23 reasoning
tokens, no visible answer). With thinking disabled it took 1.312 s
(9 reasoning tokens, 28 visible characters). The probe key was revoked.
The probe overlapped the parallel benchmark arm and used one call per
combination. It supports explicitly setting the Z.AI-compatible cap
field for that route and keeping thinking policy fixed across the next
matched pair. It does not establish provider-wide semantics.

The original matched inspection pair finished without a source patch
in either arm. Serial timed out at 450.223 s with 16 commands and
57,203 reported tokens. Parallel timed out at 450.276 s with 3 commands
and 1,282 reported tokens. Those usage totals cover completed streams
only. Both keys were revoked. Retain the pair as a transport diagnostic,
with no comparison of accepted patch quality or productivity.

The follow-up pair reverses arm order, sets Pi's Z.AI-compatible
`maxTokensField` to `max_tokens`, and logs the outgoing spelling and
thinking setting. The first live parallel request used `max_tokens:
8192`. Both arms use the same original pretask, 48,000-token context
window, and compaction policy.

The corrected parallel arm ended unanswered at 135.599 s before any
tool calls. Its first stream terminated with `output_token_limit` after
135.306 s. Buckle trace `61aa6099a1974ed9a29ab0d6a51866c4` confirms
the in-band error, one upstream attempt, and zero queue wait. There is
no usage footer, so the SDK's zero total is missing evidence rather than
zero token use. The scoped key was revoked. The wrapper exited zero
because it received an SDK result, despite that result being unanswered.
The Buckle SSE guard can synthesize this exact code when a length
terminal arrives without usable text or a named tool call. The
client-side error therefore does not prove the upstream emitted a
native error frame. Preserve this distinction in the replay verdict.

The corrected serial arm ended unanswered at 242.328 s with 11
commands and no production patch. Its fourth request received the
same `output_token_limit` terminal. The 22,804 reported tokens cover
completed requests only. Both corrected-arm keys were revoked.

The standalone low-effort serial worker used the same fixture,
inspection schedule, context and cap, with explicit thinking enabled
and `reasoning_effort: low` on the wire. It reached its first useful
tool at 8.947 s, ran 9 commands and ended unanswered at 107.422 s
without a source edit. Completed requests reported 13,212 tokens.
The fifth request returned HTTP 503. Buckle trace
`6b319b28f292e5dd427e35c39ee9ee44` attributes 30.001 s to local
admission queueing. The key was revoked. This is a failed run with a
different terminal condition from the corrected baseline. It is not a
quality or speed comparison, and it does not exercise child dispatch.

The 32,768-output-token rerun kept the same low-effort serial profile
and widened its context window to 65,536 with a 40,960-token compaction
reserve. Both requests sent the full cap as `max_tokens`. It ran
four inspections, then ended unanswered at 50.968 s without a patch.
Request 2 returned HTTP 503 after 30.002 s in local admission (trace
`53367b468789f07d34abca6a58c32505`). The key was revoked. The terminal
failure occurred before upstream generation, so the effect of the
larger output allowance on patch completion remains unmeasured.

A later live admission snapshot showed 7 of 8 active slots in the
shared `zai-coding-account` pool, no queued requests at sampling time,
and 138 cumulative queue wait expiries. This is a later sample, not
the occupancy at either failed request. Use pool observations and
per-request admission traces when scheduling or judging reruns.

The completion-first 32k run started after the shared pool showed
6 active requests out of 8 and no queue. The treatment combined
hand-selected source excerpts, a prompt to reach a small edit early,
bounded retries and a larger turn, tool and wall-time allowance.
The first source edit arrived at 114.832 s. It ended unanswered at
538.221 s after 68 commands. The private judge scored the final
production patch 0/3 target checks and 59/59 regression checks.
The target failures were assertion mismatches in rendered property
documentation, rather than missing dependencies. The key was revoked.
The SDK reported 43,677 fresh input, 867,008 cached input and 20,959
output tokens across recorded usage. This is a completed diagnostic
with a rejected patch, not an accepted baseline or an isolated test
of the changes bundled into the treatment.

### Corrected Docker replay

The corrected runner is `packages/blam/bench/sphinx/completion-first-provider-limit.ts`.
The previous scripts confounded runner timing with blocking client
processes, guest commands that could outlive client timeouts, and earlier
compaction. Use those observations as diagnostics only.

On the corrected serial arm, the first successful command returned at
3.725 s, the first source edit appeared at 77.730 s, and the run
returned at 158.342 s. The private judge scored 1/3 target checks and
59/59 regression checks. The SDK reported 15,674 fresh input, 200,064
cached input and 6,172 output tokens. All 20 requests returned HTTP
200. Fifteen streams reached EOF and five recorded consumer
cancellation. The scoped key was revoked. The 158.342 s run was faster
than earlier diagnostics, but changed multiple harness settings and
still produced a rejected patch. It does not establish a speed or
quality improvement on accepted work.

The parallel arm reached its first successful command at 3.966 s and
its first source edit at 86.085 s. It reached the 60-turn boundary
unanswered at 432.470 s after 72 commands. Its exported patch scored
2/3 target checks and 59/59 regression checks. The SDK reported 37,737
fresh input, 1,204,288 cached input and 17,176 output tokens. The key
was revoked and both containers were removed. Neither arm passed the
oracle. This single serial-first Docker pair cannot rank time or tokens
per accepted patch, or substitute for the Pi microVM versus OpenHands
comparison.

A fresh low-effort parallel arm with the turn and command-count caps
removed reached a source edit at 63.975 s and finished at 351.490 s.
It made 47 model requests and 52 guest commands. The private judge
scored 0/3 target checks and 59/59 regressions. Pi reported 29,889
fresh input, 647,104 cached input and 12,540 output tokens. The
scoped key was revoked. It finished before the previous turn cap
would have applied, so this run does not isolate the effect of
removing that cap. It does show that a model-declared completion
still needs the private oracle.

The next parallel arm changed the requested effort from low to medium
and kept the same brief, pretask, route and tool mode. The route
returned HTTP 200 with medium effort on the wire. It finished at
511.462 s after 43 requests and 60 commands. The private judge scored
2/3 target checks and 59/59 regressions. Pi reported 47,898 fresh input,
1,289,344 cached input and 26,209 output tokens. The scoped key was
revoked. This serially scheduled, single-repeat comparison provides no
accepted patch from either effort setting.

A low-effort arm appended a Qlty 0.649.0 function map generated from
three unchanged base-revision files without plugins. It finished in
260.819 s with 37 model requests and 47 commands. The private judge
scored 0/3 target checks and 59/59 regressions. Pi reported 24,623
fresh input, 580,352 cached input and 10,882 output tokens. The scoped
key was revoked and both containers were removed. It was quicker than
the low-effort diagnostic without the map, but neither patch passed.
One run per treatment cannot establish a Qlty speed effect.

The medium-effort treatment with five exact, verified base-source
excerpts reached its first edit at 283.575 s and finished at 411.372 s
after 28 model requests and 38 guest commands. The private judge
accepted the patch with 3/3 target checks and 59/59 regressions.
Pi reported 36,296 fresh input, 719,168 cached input and 22,233
output tokens. The scoped key was revoked and both containers were
removed. This is the first accepted completion baseline for this
replay. The medium run with the original pretask was rejected at 2/3
and took 511.462 s. The treatments ran sequentially with one trial
each, so their results do not establish a general speed or quality
advantage. A low-effort arm with the same excerpts is the next
comparison.

Pretask SHA-256: `7f258f067092fd6b6ec9c56988a8c0beb7eb90a2d2ab6ab6dbc3934a909f7f51`.
Accepted patch SHA-256: `0e26312a1e170b5dac5bb970dd186e71f5faf0ae3745f45e0b724f774859475c`.
Private judge receipt SHA-256: `13a7e69591e4b846d2ae49da76d3e72b4110939cdc254f1492285956def0a91c`.

A fresh grading container reproduced the accepted score from the
exported patch. With the same brief and pretask hashes, changing to low
effort yielded a first edit at 64.135 s and a final patch at 229.967 s
after 35 requests and 40 commands. It passed 0/3 targets and 59/59
regressions. Pi reported 22,581 fresh input, 423,872 cached input and
9,862 output tokens. The scoped key was revoked and containers removed.
The faster arm did not produce an accepted patch. Repeat the passing
configuration to estimate reliability before using it to compare cost.

A fresh repeat at medium effort with the same excerpts finished in
470.947 s after 31 model requests and 34 commands. The first edit
appeared at 330.534 s. The judge scored 0/3 targets and 59/59
regressions. Pi reported 37,313 fresh input, 762,880 cached input and
26,170 output tokens. The scoped key was revoked and the containers
were removed. The passing configuration is now 1/2 on this task.
Regrading the original patch proves grading repeatability. It does
not establish that the model reliably generates a passing patch.

A medium-effort arm added a prompt to reproduce and verify the public
bug in a local autodoc build. The private judge remained outside the
sandbox. The run finished at 364.557 s after 36 model requests and
39 commands, with first source edit at 172.068 s. The judge scored
0/3 targets and 59/59 regressions. Pi reported 28,464 fresh input,
716,672 cached input and 17,872 output tokens. The scoped key was
revoked and the containers removed. The extra instruction did not
produce an accepted patch in this run.

A medium-effort serial inspection arm used the same source excerpts
and brief. It finished at 558.451 s with 47 model requests and 56
commands. Its first edit arrived at 273.664 s. The judge scored 0/3
targets and 59/59 regressions. Pi reported 48,418 fresh input,
1,492,032 cached input and 30,423 output tokens. The scoped key was
revoked and both containers removed. Across the matched settings
there is one passing parallel run, one rejected parallel repeat and
one rejected serial run. The sample does not establish a reliable
effect of tool scheduling.

### Reliability follow-up

A third independent run of the medium parallel excerpts configuration
finished in 373.121 s with 29 model requests and 34 guest commands.
It passed 0/3 targets and 59/59 regressions. The three-run history of
that configuration is one accepted and two rejected patches.

A runnable reproduction built solely from the public issue passed the
ordinary property control on the base and failed all three class
property docstring checks. It passed all four checks when run against
the previously accepted patch. The reproduction was added to disposable
candidate workspaces as a separate treatment.

| Medium parallel treatment | Wall time | Fresh input | Cached input | Output | Targets | Regressions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Excerpts, third clean control | 373.121 s | 33,026 | 641,984 | 20,352 | 0/3 | 59/59 |
| Excerpts and executable reproduction | 283.852 s | 29,217 | 426,624 | 15,691 | 0/3 | 59/59 |
| Compact source map and executable reproduction | 368.400 s | 38,502 | 519,872 | 21,349 | 2/3 | 59/59 |
| Compact source map, executable reproduction and diagnosis step | 256.300 s | 25,407 | 445,440 | 12,122 | 0/3 | 59/59 |

The first two reproduction-assisted candidates passed their public
docstring checks and were rejected by the held-out judge. Buckle ledger
joins confirmed GLM-5.3 Flash for all 29, 22 and 23 successful requests
in the control and first two reproduction-assisted runs respectively.
All four keys were revoked. A separate public fixture added typed
signatures, abstract class properties and the direct autodoc directive.
The base passed its regular-property control and failed the six issue
checks. The previously accepted patch passed all seven.

A fresh-session verification arm started from a new implementation
patch and had access to public evidence only. It ran 39 requests
across two independently scoped sessions. Combined wall time was
540.470 s, with 45,931 fresh input, 617,536 cached input and 26,614
output tokens. The final patch passed 0/3 targets and 59/59 regressions.
Both keys were revoked. No acceptance or speed improvement is
established by this trial.

### Three fresh Sphinx confirmations

The successful treatment gave the agent a public rendering fixture
and asked it to preserve the visible class scope of a class property.
The fixture was refined during exploration on this one task. It uses
no private test contents. Its eight checks cover ordinary, class,
inherited, metaclass, typed, abstract and direct autodoc behavior,
including a visible class-property declaration.

| Medium-effort GLM-5.3 Flash | Wall time | Fresh input | Cached input | Output | Targets | Regressions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Screen | 341.357 s | 37,007 | 705,600 | 18,592 | 3/3 | 59/59 |
| Confirmation 1 | 374.489 s | 39,035 | 939,968 | 19,825 | 3/3 | 59/59 |
| Confirmation 2 | 462.550 s | 39,524 | 598,272 | 25,876 | 3/3 | 59/59 |
| Confirmation 3 | 387.970 s | 34,063 | 401,792 | 21,678 | 3/3 | 59/59 |

All four trials started from separate clean clones and produced
distinct patches. The ledger confirmed the served model and each
scoped key was revoked. The median for the three confirmation runs
was 387.970 s. The matched low-effort screen passed at 278.685 s,
with 32,812 fresh input, 765,312 cached input and 11,944 output
tokens.

| Low-effort GLM-5.3 Flash | Wall time | Fresh input | Cached input | Output | Targets | Regressions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Confirmation 1 | 273.548 s | 26,379 | 578,688 | 12,123 | 3/3 | 59/59 |
| Confirmation 2 | 276.981 s | 28,672 | 705,536 | 12,883 | 3/3 | 59/59 |
| Confirmation 3 | 238.443 s | 29,254 | 429,376 | 11,831 | 3/3 | 59/59 |

At this checkpoint both arms passed their three fresh confirmations.
Low effort reduced median confirmation time by 29.5% and median
output by 44.1%. It used the same brief, fixture, pretask, inspection
mode and served model. Provider cache and system load were observed
but not held constant. An extra low-effort screen passed at 174.951 s.
Thinking off and adding structural excerpts each had a confirmation
that passed only 2/3 targets. Keep those results in their histories.

### Overnight Sphinx results, November 11

The completed exploration contains 110 trials across 22 treatments.
The private evaluator graded 108 patches, with 59 accepted. All 108
graded patches preserved 59/59 regression checks. One trial hit the
20-minute deadline without an exported patch. Another settled unanswered
without a patch. All scoped keys were revoked and no replay containers
remained after the final trial. A planned scheduler rollover generated
one prelaunch error, which is excluded from trial counts.

| Class-scope fixture treatment | Accepted / attempts | Median accepted wall time | Wall seconds per accepted patch, including failures |
| --- | ---: | ---: | ---: |
| Low effort plus fixed verification tool | 6/6 | 301.91 | 280.83 |
| Low effort | 9/10 | 280.91 | 330.40 |
| Requested thinking off | 8/10 | 293.52 | 352.25 |
| Low effort plus directed read/edit workflow | 8/9 | 375.10 | 389.89 |
| Low effort plus structural excerpts | 8/10 | 321.68 | 441.92 |
| Low effort with serial inspection batches | 6/8 | 299.51 | 427.60 |
| Medium effort | 8/9 | 411.76 | 519.94 |

Each accepted patch scored 3/3 targets and 59/59 regressions. All rows
above have positive usage and served-model ledger joins. Wall time here
includes clone, execution, grading and model-identity audit. Three
confirmation successes were followed by failures in several arms.
Their entire histories remain in the table.

The verification-tool treatment bundles the unchanged public
reproduction and 55 focused base tests into one tool call. Its six
trials used 136,312 fresh input, 1,704,960 cached input and 56,441
output tokens in total. Its observed time per accepted patch was
46.0% lower than medium effort and 15.0% lower than plain low effort.
The verification-tool/requested-off combination accepted 0/2.

The requested-off arms sent thinking.type=disabled, yet provider usage
still reported reasoning tokens. These measure a requested setting.
Effective disabling is unverified. The replay uses native OpenAI
Completions, so an Anthropic-shim explanation does not apply.

This is an adaptive study tuned on one public issue. Provider cache and
host load were uncontrolled. Later blocks used seeded shuffled order.
Use the observed rates and time per accepted patch when selecting the
next held-out experiment. No production executor default was changed.

### Parent context reuse

Pi Durable 1.5.0 forked one in-memory parent checkpoint into two
distinct conversations. Both saw the checkpoint, excluded later
parent messages, and stayed isolated when one child reset its context.
No model calls or Fleet dispatch were involved.

An isolated llama.cpp 0.9.0 slot save/restore on Qwen3 1.7B restored
710 computed tokens into each of two slots. The worker suffixes
processed 7 and 8 fresh tokens. A cold control processed 717 and
returned the same greedy output as the corresponding warm branch.
The 81,440,572-byte snapshot was deleted after the test. Warm timings
did not consistently beat the cold control.

The native Buckle Z.AI Flash route was primed with a unique synthetic
3,951-token prefix and then given two concurrent branches under
distinct scoped credentials. Both answered correctly and each
reported 3,904 cached input tokens out of 3,956. Their fresh input
was 52 tokens each. All three credentials were revoked. Full prefixes
were resent. The /v1/responses probe returned no_route for both full
GLM-5.3 and Flash, so provider-side branching by handle was not tested.
These probes do not establish real worker cache hit rate or patch quality.

For the on-prem Flash arm, pin the serving engine, model revision,
cache dtype and parallel topology. The model has 34 KDA layers and
11 sparse MLA layers. Keep the parent prefix, tool ordering and chat
template identical, append child briefs, and route children to the
same serving replica. Compare cold and warm fan-out at the same
concurrency. Record fresh prefill, cached tokens, cache memory,
checkpoint reuse, eviction, queue time and first useful tool. Keep
latency and capacity estimates separate from measured cluster results.
The LMCache Flash recipe is a starting point on its documented H200
setup. Verify hybrid-state behavior on the actual target configuration.

## MicroVM runner evaluation

W2958 tracks the seed artifact. W2959 tracks the real Xeon backend and
the tool-guest lifecycle. Compare microVM and Docker tool execution with
the same seed and tool payload. Measure cold and warm start, first useful
tool result, guest replacement, stale-lease rejection and independent
supervisor recovery. Record the host, hypervisor, image and policy with
each result. The Docker Desktop seed and recovery tests above are
container evidence. No hardware-backed microVM comparison is recorded
here yet.

## Renewed strategy exploration, November 11-12

The owner extended exploration to November 12 at 08:45 CET. Retain the
completed overnight matrix and rotate fresh trials across strategies.
Require three consecutive accepted patches before selecting a candidate,
then retain subsequent failures and test a separate held-out task.

The first renewed structural-excerpt/low-effort trial passed 3/3 targets
and 59/59 regressions. The durable submission took 468.576 seconds and
47 model requests, with 31,970 fresh input, 898,496 cached input and
14,114 output tokens. Its key was revoked and served-model audit passed.
This is one confirmation, not evidence of general reliability.

Next treatments combine the fixed verification tool with structural
excerpts or a directed read/edit workflow. Keep the same base, public
fixture, model, effort and private judge. Pi owns the independent W2971
parent-first solo/fanout comparison and second held-out task.

The live Buckle catalog did not advertise context or output limits.
Keep the existing 64K-context baseline labeled explicitly; W2979 tracks
capability publication with provenance. First successful command timing
is distinct from the first useful source or behavioral-test result.

### First eleven renewed trials

Six trials produced accepted patches; five failed target checks. Every
trial preserved 59/59 regression checks and revoked its scoped keys.
The following includes failures; wall time includes grading and cleanup.

| Treatment | Block | Target checks | Wall seconds | Model requests |
| --- | --- | --- | --- | --- |
| Structural excerpts, low | 1 | 3/3 | 477.6 | 47 |
| Serial inspection, low | 1 | 2/3 | 784.8 | 56 |
| Verification + structural excerpts, low | 2 | 3/3 | 286.1 | 30 |
| Verification, low | 2 | 2/3 | 453.5 | 31 |
| Verification + directed workflow, low | 2 | 2/3 | 450.9 | 28 |
| Structural excerpts, low | 2 | 3/3 | 323.3 | 24 |
| Serial inspection, low | 2 | 3/3 | 537.9 | 48 |
| Scoped context, low | 2 | 3/3 | 452.9 | 38 |
| Scoped context, medium | 2 | 3/3 | 589.8 | 37 |
| Implementation then review, medium | 2 | 0/3 | 902.6 | 77 |
| Contract context, low | 2 | 0/3 | 269.4 | 36 |

The two-pass row includes both model stages. More review did not ensure
a correct patch. The previously promising verification treatment also
failed a fresh trial; its earlier success streak does not establish
ongoing reliability. The faster combined treatment has only one fresh
trial here and cannot be promoted from this result.

Normalized snapshot: `renewed-interim-11trials.json`, SHA-256
`06a2f55965f9a6ded1526eac4867469650c4692c8f1570ada1ffcbe4c6e4ef32`.
The full immutable trial receipts remain in the experiment artifact store.

### Second canonical task controls

SWE-bench Verified `sphinx-doc__sphinx-9602` was selected from metadata
before examining reference changes: next instance after 9461 with the
same Sphinx version and at least the 15-minute difficulty category.
Two independent control pairs reproduced 0/1 target checks on the base
and 1/1 on the reference, with 45/45 regression checks in both states.
The base is `6c38f68dae221e8cfc70c137974b8b88bd3baaab`; the evaluator is
SWE-bench 4.1.0 and the image digest is
`sha256:fc4a4f7057274ac47068c3996e729b3091b6a56fd7b8259076c4aafdbff176ee`.

The replay driver now accepts a separately pinned task image. Its 9602
Docker Desktop AMD64-emulation smoke verified UID 1000, read-only Git,
output clipping, command timeout and scoped-key revocation with zero
model requests. This is a functional smoke, not a judged agent patch or
a performance comparison. The running 9461 trials retain sealed drivers.

Second control receipt: `holdout-9602-repeat-controls.json`, SHA-256
`73259740761e07b4dc98aabdfa3b2519f45480c219f18de2088470c5f3a82741`.

### Audit delay and controller version 3

A completed 19-request trial took 162.5 model-run seconds, then its
read-only route audit timed out. Controller version 2 treated missing
audit evidence as a transport failure and imposed 600 seconds of idle
time. A separate ledger requery verified all 19 requests used GLM-5.3
Flash; the patch still failed 0/3 targets and preserved 59/59 regressions.
The original receipt and audit failure remain unchanged, with a separate
reconciliation referencing both receipt and supplemental-audit hashes.

After a graceful drain, version 3 separates audit-evidence failures from
execution failures. Missing audit evidence stays ineligible for acceptance
but no longer pauses otherwise completed model work. It prioritizes a
third confirmation for arms with two consecutive verified successes.
Model drivers, prompts, effort, resource limits and private judge remain
unchanged; controller versions and their observed overhead stay recorded.
Version 3 controller SHA-256:
`b6ebe05596cafa4068c24bc2919268c1e9285a0245a81c817fed47efff33729d`.

### Twenty-trial snapshot and held-out transfer

The renewed matrix now contains 20 completed trials: 12 accepted patches
and eight target-check failures. All retain the full history; one failed
patch also has an original route-audit gap, reconciled separately above.
Structural excerpts with low effort passed three consecutive fresh trials:
468.576, 313.827 and 376.437 model-run seconds, each 3/3 targets and 59/59
regressions. Median model-run time is 376.437 seconds. This is a candidate
recipe, not a cross-task recommendation or a production activation.

Adding verification to structural excerpts passed its first two fresh
trials in 277.258 and 190.198 seconds, then failed the third (2/3 targets)
after 614.076 seconds. Serial inspection has one accepted patch in three
trials. Plain scoped context at low effort has two accepted trials and
still needs a third. The matrix is exploratory, with adaptive trial order;
these counts do not establish a statistically controlled speed advantage.

Snapshot `renewed-interim-20trials.json`, SHA-256
`bf33f7dc8b45d0f6f1dcb6d8e5f25e57bd2028395dbfb0295506e4648e27f4b1`.
Controller 21019 drained gracefully with exit zero after its active trial.
The next finite block compares common public-issue context against that
same context plus four quoted source regions on held-out instance 9602.
Both arms use the same pinned driver/image, low effort, parallel read tool,
public reproduction and private judge; no turn or wire output-token ceiling.
The public reproduction fails on the base and passes on the reference.
The reference patch and judge are never mounted in the candidate sandbox.

The first held-out pair completed with verified route, positive usage,
unchanged public fixture and key/container cleanup. Both failed the private
target while preserving 45/45 regressions. Baseline: 210.936 model-run
seconds, 19 requests and 151,546 reported tokens. Quoted excerpts: 71.948
seconds, 9 requests and 34,246 tokens. Both passed the public reproduction;
therefore that reproduction alone did not capture the complete contract.
The shorter failed attempt is not a correctness-qualified speed improvement.

The paired driver SHA-256 is
`a15504c15023ae37daf6459bcb670ed2dfde7b9e3e1714074860be6976184c85`.
The finite three-attempt-per-arm block uses counterbalanced order AB BA AB,
with frozen controller SHA-256
`8aef0a08d94ddafe5a529f1a5927c65aef9ea183ef02271546c76b664ca4a7b8`.
After that block the existing exploratory matrix resumes within the owner's
November 12 deadline. An evidence/cleanup error stops the block for review;
a genuine quality failure stays in its denominator and does not stop it.

The completed six-attempt transfer block accepted no patches: baseline 0/3,
quoted excerpts 0/3, with 45/45 regressions in every run. Immutable snapshot
`holdout-9602-block-1.json` has SHA-256
`16a17a059957787c57ed6dc0d88ce424fb4b28df2e569c73780a90c93048e0dd`.
Broader public-contract reproduction controls still failed on the base and
passed on the reference. Medium-effort diagnosis-first attempts also failed
the canonical target: baseline 344.595 seconds/183,359 reported tokens;
excerpts 156.517 seconds/82,084 tokens. Both preserved 45/45 regressions.

Post-run grading inspection identified a document-node structure mismatch,
despite warning-free public rendering. Keep the canonical failures; do not
replace that judge with the public fixture or feed its private assertions
into candidate prompts. Any later diagnosis-informed experiments are labeled
as such rather than represented as a fresh blind confirmation.

Tool traces also showed `pytest ... | tail` returning shell exit zero after
a failed test process. A separate optional Bash/pipefail treatment now exposes
pipeline failures. Its regression test failed before implementation; 39 BLAM
tests and Qlty passed afterward. The pinned 9602 guest smoke verified read-only
Git, clipped output, timeout and key/container cleanup with zero model calls;
an isolated guest `false | tail` probe returned exit one under pipefail.
The first medium-effort pipefail diagnostic still failed the canonical target
after 129.195 model-run seconds and 56,208 tokens, preserving 45/45 regressions.
This repairs a measurement weakness but has not established a quality gain.

### Held-out 9602: medium planning plus pipefail, AST arm (2026-11-11)

The finite run completed at ast-medium-contract-planning-uH5rdB under outputs/w2960-sphinx/holdout. Controller SHA256 74cf83a729f4b6ff93f2ad9db60aa1cd152fa5f38322284276a9104be19b052d; driver ff081511c8fa526382d589b53fe34d1e6fbef4314b9c7d379907b315bc37c170. Same official 9602 base/image/private judge and predeclared public contract fixture as the paired baseline.

Driver elapsed 321.308 seconds, first successful command 3.133 seconds, 26 requests and 31 commands. Usage 335,171 tokens: 22,757 fresh input, 11,678 output, 300,736 cache reads; 6,961 reasoning tokens are a reported subcategory, not added again. Private judge: target 0/1, regressions 44/45. Fixture unchanged, served route verified, key revoked. Run process exit0 and grade process exit0 do NOT mean accepted: accepted=false.

The prior baseline/medium/contract/planning/pipefail arm also failed target acceptance (0/1, regressions45/45). Pipefail reliably exposes shell pipeline failures; this pair provides no quality-qualified improvement and the AST arm introduced a regression. Do not promote this combination or generalize earlier single-case 3/3 streaks. The public brief was fixed before later private-log inspection; no private assertions were injected.
