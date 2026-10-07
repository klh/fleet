# Resource caps — jobslab (W177)

Every LOCAL lane runs capped. Both spawn recipes (fleet-loop's dispatch
verb, and `scripts/lib/lane.ts` `spawnClaude` behind dispatch-next +
supervise) wrap the agent exec in the jobslab preamble — `ulimit -u/-t/-f`
then `exec nice -n N` — so a runaway lane dies at the rlimit instead of
forkbombing the user machine (the don't-overtax law; LLM placement already
obeyed it). `llm:*` executors are belt-routed remotely and stay locally
uncapped.

Defaults per working class (claude, codex): `nice 10`, `maxProc 2048`,
`cpuSeconds 3600` per process, `fileBlocks 4194304` (2 GiB per file).
Override per machine via `<fleet>/jobslab.json` (gitignored runtime
config): `{"*": {"nice": 15}, "codex": {"maxProc": 4096}}` — merge order
class defaults ← `*` ← class key. Caps ≤ 0 = uncapped; nice is clamped
0..20 (non-root may only lower priority).

Darwin honesty: `RLIMIT_NPROC` is enforced per real UID, so `maxProc` must
sit above the machine's ambient process count (~1200 here) or lanes'
children starve with EAGAIN; there is NO working per-process RAM rlimit on
darwin — RAM containment stays with belt placement until darwin grows a
real rlimit. What was applied is stamped into `lanes.json` (`slab`) and
every DISPATCHED log line (`slab claude:n10/p2048/c3600/f4194304`).
