# Fleet installation friction audit — 2026-10-29

## Scope and evidence

Read-only audit of the current `main` checkout, the install contract, the
umbrella installer, the public onboarding path, the local auto-install log,
and a `--dry-run --json --with-launchd` plan. No full install was run.
`doctor check` on this configured Mac passed its runtime, credentials,
machine-conf, repo-rules, and project-identity checks, with the expected
checkout-origin warning. That verifies this machine's present setup, not a
clean-machine install.

The auto-install log contains 707 `install.sh start` lines, 62 `installed
main` lines, and 645 `install.sh FAILED` lines across its recorded history.
Those are attempts, not independent users or failures. The late-October
sample differs: 20 successes and zero failures on October 25–29. This
history supports a recurrence problem, but does not prove that the old
failures persist in today's build.

## Confirmed current defects

### 1. The advertised first-run command cannot finish with the committed stub

`README.md` says the `--wire` install needs nothing else before starting.
The default plan includes `seedLocalLlm`; it copies
`packages/local-llm/belt.env` to the machine home when absent and then
immediately calls `validateBeltWiredGuard`. The stub has no
`BELT_WIRED_GUARD_GB` assignment. The guard requires exactly one positive
plain assignment in a regular 0600 file. The copy does set mode 0600, but
the missing assignment still produces a failed step. This happens after
`syncHarness` has already published the prefix. A new user's install can
therefore be both partly installed and reported failed.

Evidence: `README.md:30-48`,
`packages/suspenders/scripts/install/install-contract.ts:375-390`,
`packages/suspenders/scripts/install/install-llm-steps.ts:379-390`,
`packages/suspenders/scripts/lib/belt-wired-guard.ts:5-35`, and
`packages/local-llm/belt.env`.

### 2. The umbrella installer reports success through essential failures

`packages/speedy/bin/install-fleet.ts` calls the suspenders installer in
its Belt and Suspenders phases. A failed Belt install is downgraded to a
warning; `main()` returns 0 even when any phase failed. Its installed
checks are file-existence markers (`registry.ts` for swarm and `work.ts`
for control plane), not service readiness or activation receipts. If
`syncHarness` publishes files and `seedLocalLlm` later fails, a rerun can
skip work because the markers now exist. The Buckle phase also calls a
rendered plist "registered" if the file exists; it does not prove the job
is loaded or healthy.

Evidence: `packages/speedy/bin/install-fleet.ts:63-72, 133-183,
275-322, 380-439, 724-760` and
`packages/suspenders/scripts/install/install-run.ts:579-615`.

### 3. A dry-run's recommended command drops the requested activation flag

`bun packages/suspenders/scripts/install.ts --dry-run --json
--with-launchd` emits a planned `registerLaunchd` row but recommends an
`execute` command ending in `--json --yes`, without `--with-launchd`.
Following the machine-readable next step therefore runs a different plan
and does not register services. `nextSteps` has no input for the original
flags.

Evidence: reproduced 2026-10-29; implementation at
`packages/suspenders/scripts/install/install-cli.ts:209-240` and call at
`packages/suspenders/scripts/install.ts:169-176`.

### 4. A successful code sync does not activate changed services

The installer contract explicitly says `syncHarness` publishes code with
"no services restarted." `auto-install.ts` invokes plain `install.sh`
without `--with-launchd`; its own comment says no unit re-registration or
restarts. That can leave the installed prefix ahead of the process serving
requests. This is relevant to the `glm-5.3` 503: the provider-identity fix
can be present in a checkout or prefix while the old Buckle process still
answers until activation.

Evidence: `packages/suspenders/scripts/install/install-contract.ts:335-340`,
`packages/suspenders/scripts/auto-install.ts:1-17, 119-143`.

### 5. The install outcome collapses several distinct states

The plan continues after a failed step, then reports an overall failure
even if later essential steps succeeded. Conversely, model-download
failures are returned as `status: "ok"` with a note. `registerCaddy`,
`registerSkills`, and `releaseNotify` are optional surfaces but return
`status: "failed"`, making the whole plan fail. The `--with-launchd`
runner now excludes optional failures from its launchd prerequisite set,
but the overall outcome remains failed. Callers must parse step notes to
distinguish core failure, optional degradation, and incomplete local
model availability.

Evidence: `packages/suspenders/scripts/install/install-run.ts:89-109,
579-615`; `packages/suspenders/scripts/install/install-llm-steps.ts:565-635`;
`packages/suspenders/scripts/install/install-wire-steps.ts:50-100,
108-181, 230-270`.

### 6. The public and internal onboarding paths disagree

The public `README.md` says steps 3–4 require nothing else and presents
models/launchd as optional. The internal onboarding page still names
`stack.yaml`, while the current law and README use `stack.json`; it also
places the doctor under the installed prefix. The later README section
still says `--hub` reads `stack.yaml`. A reader following different entry
points gets different config paths and different expectations for what a
"complete" install means.

Evidence: `README.md:30-48, 275-290` and
`docs/w842-onboarding-capacity.md:7-33`.

### 7. `--wire` opts into more than hook wiring

`--wire` also sets `yes: true` for the entire default plan. On a machine
with a configured hub, `wireConnections` writes a default-ON desktop GUI
proxy policy for Claude, ChatGPT, VS Code, and Codex, then applies the
launchctl environment face if the CONNECT probe succeeds. The same plan
seeds a local LLM, may install a `uv` LiteLLM tool dependency, attempts
model downloads, and prunes/re-adds Fleet skills through `npx`. These are
individually documented, but the public step describes the command as
installing PATH shims and the board. That gap makes side effects and
required external tools surprising to first-time users.

Evidence: `packages/suspenders/scripts/install/install-cli.ts:90-117`,
`packages/suspenders/scripts/install/install-connections.ts:58-76,
145-178`, `packages/suspenders/scripts/install/install-llm-steps.ts:379-435,
565-635`, and `packages/suspenders/scripts/install/install-wire-steps.ts:108-181`.

## Historical failures relevant to recurrence

- On October 12–15, the auto-install log repeatedly failed `syncHarness`
  because the shipped working payload was dirty. The same head was retried
  every five minutes. Current `syncHarness` now names offending paths;
  auto-install still retries a failed head on each cadence because its
  stamp advances only on success.
- On October 21–24, 27 auto-install attempts ended with exit 127 and the
  log recorded only the exit code. The wrapper executes `bun` by name, so
  missing Bun in the child PATH is a plausible cause, not proven from that
  log alone. The runner already knows `process.execPath`, but does not pass
  it to the wrapper.
- On October 23, a `--with-launchd` run from an item worktree published
  code before the activation guard refused it. Current
  `registerLaunchdPreflight` checks that guard before mutation; this
  specific sequence appears repaired.

Evidence: `~/.claude-insights/auto-install.log` (local operator log),
`packages/suspenders/scripts/auto-install.ts:84-151`,
`packages/suspenders/install.sh:1-7`,
`packages/suspenders/scripts/install-preflight.ts:1-55`.

## Repair order

1. Make the public first-run path self-consistent: ship a valid safe guard
   default or create it before `seedLocalLlm`; preflight all required
   machine inputs before `syncHarness` publishes. Test from an empty HOME.
2. Make the umbrella installer prove each essential phase through a
   readiness/activation receipt, retry partial phases, and return nonzero
   when the core stack fails. Keep optional degradation explicit.
3. Preserve all requested flags in `agent_next_steps`; test the dry-run to
   execute transition for `--with-launchd`, `--no-llm`, and `--skip-models`.
4. Define one activation step after code sync that verifies the running
   process revision and health. Make auto-install use that step or report
   "staged, not live" instead of "installed."
5. Separate core, optional integration, and model availability verdicts;
   back off identical auto-install failures while retaining the first full
   diagnostic.
6. Reconcile README, the onboarding page, `doctor`, and the `stack.json`
   contract; make the minimal path and full local-model path explicit.
   Rename or narrow `--wire` so its whole-plan consent and desktop proxy
   changes are clear before the run.
