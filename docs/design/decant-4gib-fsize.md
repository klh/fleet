# Decant archive 4 GiB wall — incident W1237 (2026-10-23)

## Symptom

`~/.decant/decant.db` exactly 4,294,967,296 bytes with a 4.3 GiB `-wal`; every
decant write verb (`sync`, `stats`, `db vacuum`) exited bare
`error: disk I/O error` while read verbs worked. Logical size was
`page_count × 4096 = 6,539,929,600` — the main file was truncated at 2^32 and
the WAL carried the pages that could never checkpoint into it.

## Root cause

**RLIMIT_FSIZE = 4 GiB (soft and hard) in the agent-harness process tree.** A
plain `writeSync` at offset `2^32 + 4096` fails `EFBIG` from a lane shell;
`launchctl limit` reports `filesize unlimited` for launchd, a Bun-compiled
binary running under launchd (decant itself) writes past 4 GiB fine, and no
shell profile, snapshot, plist, or fleet code sets it (rg over
`packages/suspenders/hooks`: no `setrlimit`). By elimination the cap is
injected by the **claude CLI layer** between `claude-runtime.ts` and the Bash
shells it spawns — consistent with its sandbox posture. Decant is
Bun-compiled (`dosu-ai/decant`, bun:sqlite); lane-run writes hit `EFBIG` →
SQLite surfaces `SQLITE_IOERR_WRITE` ("disk I/O error"). The archive grew to
exactly the cap because its writers were agent contexts; `EFBIG` on a
checkpoint past 2^32 left the WAL un-checkpointable, then WAL growth hit the
same wall and even WAL appends failed.

## Heal (verified 2026-10-23)

Run SQLite surgery from an **uncapped launchd one-shot**, never from a lane
shell:

    launchctl submit -l <label> -o /tmp/out -e /tmp/err -- /bin/zsh -c \
      '/usr/bin/sqlite3 ~/.decant/decant.db "PRAGMA wal_checkpoint(TRUNCATE);"'

Procedure used (clones first, originals kept):

1. APFS-clone `decant.db` + `-wal` (`cpSync … { clonefile: true }`) to
   `~/.decant-heal-w1237/`.
2. Checkpoint the clone via the launchd one-shot above — db grows to exactly
   its logical size, WAL truncates to 0.
3. Verify: file size == `PRAGMA page_count × 4096`, `PRAGMA quick_check` ok,
   `decant --db <clone> db info` counts match (3124 sessions / 881,957
   messages / 849,598 blocks), `decant --db <clone> stats --no-sync` exit 0.
4. Swap by rename (`decant.db{,-wal,-shm}` → `*.broken-w1237` backups, healed
   db in); crash-safe — rename order is recoverable, nothing deleted.
5. Prove writes with `decant sync` **via launchd** (lane shells stay capped).

After the heal the db is past 2^32 and grows freely; WAL auto-checkpoints
keep it small. Backups remain in `~/.decant/` (`.broken-w1237`) and the heal
dir until the owner reclaims the ~14 GiB.

## Standing rules for operators/lanes

- Any file expected to exceed 4 GiB must be written from a launchd context,
  not a lane shell, until the claude CLI FSIZE cap changes.
- `decant sync` on the full archive: run via `launchctl submit` one-shot
  (absolute path `/opt/homebrew/bin/decant`; launchd has no homebrew PATH).
  A full resync takes 30+ min CPU (FTS index); don't kill mid-run —
  WAL keeps the archive consistent if killed, but the run restarts.
- `launchctl remove <label>` SIGTERMs a running job — poll for the done
  marker BEFORE removing a one-shot job.
- decant-daily (W1212) runs in fleet-loop (launchd, uncapped) — unaffected.
