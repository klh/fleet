# W2238: isolated live install matrix (2026-10-29)

## Scope and environment

The tests used disposable Docker containers based on `oven/bun:1.4.2`
(Debian 13, Linux arm64). Each clean container installed `git`, cloned the
current Fleet `main` (`9e0ea2cc4d87`, release `v2.0.3`) into `/work`, and ran
`bun install --frozen-lockfile`. The installer used isolated paths:
`SUSPENDERS_PREFIX=/root/fleet-prefix` and
`SUSPENDERS_SHIM_BIN=/root/fleet-bin`. No host services or machine keys were
mounted. Docker cannot exercise macOS launchd, the real model downloads, or
remote hub deploys; those remain separate release checks.

Raw timestamped logs are saved as the W2238 Codex task artifacts:
`fleet-w2238-clean2-docker.log`, `fleet-w2238-fullclean-docker.log`, and
`fleet-w2238-repeat-docker.log`. They include installer JSON outcomes and the
container preparation output.

## Results

| State                                        | Command                                                                          | Result                    | First relevant failure                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean, LLM skipped                           | `bash packages/suspenders/install.sh --wire --skip-models --no-llm --yes --json` | Exit 1, `outcome: failed` | `registerSkills`: `npx` absent, even though Bun and Git were present.                                                                                 |
| Same partially provisioned state             | Same command                                                                     | Exit 1, `outcome: failed` | `registerSkills` repeats. `wireSettings` adds 0 hook entries on rerun, down from 20 on the first run.                                                 |
| Same state, after installing Debian Node/npm | Same command                                                                     | Exit 1, `outcome: failed` | `registerSkills`: the downloaded skills CLI exits under Node `v20.19.2`; the installer truncates the underlying error to the tail of the stack.       |
| Separate clean container, full LLM baseline  | `bash packages/suspenders/install.sh --wire --skip-models --yes --json`          | Exit 1, `outcome: failed` | `seedLocalLlm`: `BELT_WIRED_GUARD_GB must appear exactly once` in the freshly seeded `belt.env`. `registerSkills` also fails because `npx` is absent. |

The first clean run performed `syncHarness`, `migrateConf`,
`registerGitHooks`, `ensureShims`, and `wireSettings` before returning a
failure. In both failed clean runs, `releaseNotify` reported
`RELEASE v2.0.3 announced on the coord bus`. Thus neither a populated prefix
nor a release announcement proves a completed install. The JSON result and
process exit code must be checked.

The initial Docker attempt used `git clone --local` across the host bind
mount and container filesystem. Git refused a cross-device hard link before
Fleet ran. That setup failure is excluded from the Fleet results; the test
was repeated with `git clone --no-local`.

## Interpretation

The clean full run independently reproduces the seed failure identified in
the prior static audit. The partial-state rerun shows the install is partly
idempotent but remains blocked at the optional skills phase. Installing
Node/npm resolves the missing executable but exposes a second runtime or
CLI compatibility failure. The installer currently surfaces only a shortened
stack tail for that failure, which makes the root cause hard to identify
from the JSON outcome.

These results are container evidence. They do not establish success or
failure for macOS launchd registration or any configured hub profile.
