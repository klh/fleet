# Windows spoke path audit (W767)

Scope: what a Windows spoke actually executes — the services renderer
(`scripts/install/install-services.ts`), secrets at rest, and the work-graph lane
CLIs (`work`/`coord`/`dispatch` → `scripts/lib/`, `hooks/lib/`). Darwin-only
surfaces (launchd units, activation receipts) are out of scope by law —
launchd stays darwin-only; a Windows spoke rides WinSW units.

## Fixed in W767

- **win32 emitter PATH** — the manifest's darwin-shaped PATH env is no
  longer emitted as a live WinSW `<env>`; host PATH applies
  (`scripts/README-windows.md`).
- **Secrets at rest** — `mode 0o600` is a no-op on NTFS; `hooks/lib/auth/keyring.ts`
  gives the stack OS credential stores (Windows Credential Manager via
  advapi32, darwin Keychain verified on-metal here, linux Secret Service)
  with the 0600-file fallback preserved.
- **PATH delimiter** — `scripts/lib/launch-preflight.ts` split the PATH on
  `:` unconditionally; it now uses `path.delimiter` (`;` on win32).

## Confirmed portable (rg-audited, no change)

- `hooks/lib/secrets-home.ts` — `homedir()`-based, env-overridable.
- `hooks/lib/auth/hub-provider-keys.ts` / `federation-peers.ts` —
  `env.HOME ?? homedir()` pattern.
- `scripts/install/install-services.ts` win32 emitter — `winDirname()` handles both
  separators; `winQuotedIfNeeded()` applies MSVC argv rules; scheduled
  services carry `schtasks` hints; `--home`/`--bun`/`--prefix` flags accept
  Windows-shaped values (verified by render, 2026-10-15).
- `hooks/lib/auth/keyring.ts` — binary-safe blobs on win32, argv-riding darwin
  backend (NUL-free secrets).

## Darwin-pinned by law (not portable, not a defect)

- launchd activation + receipts: `/usr/bin/plutil`, `vm_stat`, `dns-sd`,
  `/usr/bin/git`, `/bin/sh` in `scripts/*.ts`, `hooks/bin/fleet-loop.ts`,
  `hooks/bin/review-lane.ts`, `hooks/lib/auth/keyring.ts` (darwin backend).
- The darwin (launchd) emitter itself — launchd stays darwin-only.

## Known limitations (documented, deliberate)

- The `process.env.HOME ?? ""` pattern appears across ~74 non-test sites;
  on win32 `HOME` is typically unset, so darwin-pinned code degrades rather
  than crashes. A shared `homeDir()` helper is the follow-up IF a real
  Windows spoke materializes — not churned speculatively.
- Manifest log paths under `/tmp` render as-is into win32 units (resolves
  under MSYS/git-bun) — verify the logpath after first render on the host
  (`scripts/README-windows.md`).
- `keyring.ts`'s advapi32 binding is written to spec but has NOT been
  exercised on a Windows host — the injected-seam tests cover orchestration
  on any platform; first Windows-metal contact should verify the binding
  (CredWriteW/CredReadW/CredDeleteW, ERROR_NOT_FOUND mapping).
