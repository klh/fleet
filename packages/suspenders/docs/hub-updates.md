# Hub release checks and updates

`hub-update.ts` runs on the **managing host**. It checks the published stable
`vMAJOR.MINOR.PATCH` tags of the configured deployment origin and compares them with the
machine's `stack.json` pin and each hub's deployed `.env` ref. It does not
inspect model provider names or keys.

```text
bun packages/suspenders/deploy/hub-update.ts check
bun packages/suspenders/deploy/hub-update.ts check --json
bun packages/suspenders/deploy/hub-update.ts apply --yes
bun packages/suspenders/deploy/hub-update.ts reconcile --force
```

The Fleet loop invokes `reconcile` every two minutes. Release discovery is
throttled to once every five minutes by default; `reconcile --force` checks
immediately. Set `updates.check_interval_s` between 60 and 86400 to change the
discovery cadence. A controller lock prevents concurrent checks or deploys.
The default mode is `manual`: it emits one `NEED_DECISION`
per new release, asking the operator
to inspect the check and run `apply --yes`. To opt into automatic upgrades,
set this machine-level JSON field (mode 0600):

```json
"updates": { "mode": "latest", "check_interval_s": 300 }
```

Each hub profile can set `"auto_update": true` or `false`. Absent means it
inherits `updates.mode`; an explicit `false` vetoes automatic rollout even
when the stack mode is `latest`. Explicit `true` opts that hub in under the
default `manual` mode. Because all non-canary hubs share one `stack.version`,
the controller updates them together only when **every** non-canary hub
permits automatic updates. A mixed choice raises one decision for the
release; `apply --yes` remains an explicit all-hub installation. The `check`
output shows each hub's effective `auto_update` value.

The release source is the single origin configured in hub `repos`. If hubs
use different origins, set `updates.origin` to the intended release source.
With no configured hub origin, the managing checkout's `origin` is used.

An enabled automatic rollout applies the newest stable release to all managed
hubs. A hub with `version_override` remains pinned as a canary. Quiet hours
defer the whole update. Every candidate ref must exist on its configured
origin before `stack.json` changes. The updater writes a 0600 backup, changes
the one version pin atomically, deploys through `hubctl`, and checks the
outside-process health probes and the live Buckle container's `FLEET_VERSION`.
If any managed hub fails, it restores the old machine pin and redeploys the
prior version to all managed hubs. A failed rollback retains the backup and
reports the affected hub names for operator recovery.

This is **controller-managed** updating. Hub containers have read-only code
mounts and no Docker socket. A hub that must update while the managing host
is down would need a separately installed, supervised host agent on that hub;
the container cannot safely promote its own Compose deployment.
