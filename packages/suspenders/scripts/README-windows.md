# Windows services (WinSW) — ops notes

The win32 emitter (W488.3) renders each entry in `deploy/services.yaml` to a
WinSW v5 XML config: `suspenders-<name>.xml`. Render with:

```sh
bun scripts/install-services.ts --target win32 [--out <dir>] [--service <name> ...]
```

WinSW wraps a Windows service around `bun <bunEntry> <args>` — the same
command line the launchd plist and the systemd unit carry on the other
platforms.

## Install + start (WinSW)

1. Copy `suspenders-<name>.xml` next to a WinSW executable renamed to
   `suspenders-<name>.exe` (WinSW binds config to exe name).
2. `.\suspenders-<name>.exe install` then `.\suspenders-<name>.exe start`.
   Uninstall: `stop` + `uninstall`. Inspect: `status`.
3. Default service account is LocalSystem; for user-scope services use the
   standard `<serviceaccount>` element (not emitted — host-specific).

## Scheduled services (interval / calendar)

WinSW has no scheduler. For interval/calendar services the XML comment
inside each config carries the exact `schtasks /Create` command (Task
Scheduler fires the same `bun` command line). Install it and run the task
on demand; the WinSW config stays resident-only.

## Env files without embedding secrets

WinSW core has no `<envfile>` element. Machine-level secret files
(config-over-code law) are referenced by PATH in the XML comment only — the
emitter never reads them. Inject env on the host: `setx` (machine/user env),
a service account env, or extend the config with per-var `<env>` entries
generated at render time. Nothing from those files is ever embedded in the
XML (tested: `test/services-manifest.test.ts` asserts no sentinel secret and
no `BUCKLE_ROOT_KEY` string ever reaches a rendered unit).

## NSSM alternative

If you don't want WinSW: NSSM wraps the same command line —
`nssm install suspenders-<name> "<bun>" <entry> <args>`; `nssm set
suspenders-<name> AppDirectory <cwd>`; restart-on-crash is NSSM's default.
NSSM has no config file — everything is registry-backed, so the WinSW XML
remains the only rendered artifact for auditing.

## Path caveat

Manifest log/env paths are POSIX-shaped (`/tmp/...`, `__HOME__/...`). On a
real Windows host the render substitutes the native home; `/tmp` entries
render as-is and resolve under MSYS/git-bun environments. Verify logpath
after first render on the target host.
