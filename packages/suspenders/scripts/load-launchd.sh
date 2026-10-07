#!/usr/bin/env bash
# Replace one job and verify registration. Keep each job's diagnostics private.
set -euo pipefail

plist=$1
error_log=$2
label=$(basename "$plist" .plist)
domain="gui/$(id -u)"
umask 077
# A competing lane cannot replace the governed gateway using rendered files alone.
# This check precedes every lifecycle action; UNKNOWN authority leaves it running.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bun "$script_dir/assert-service-activation.ts" "$plist" "${3:-}" || exit 1
: >"$error_log"
chmod 600 "$error_log"
if ! plutil -lint "$plist" >>"$error_log" 2>&1; then
  echo "→ invalid $label (see $error_log)" >&2
  exit 1
fi
launchctl bootout "$domain/$label" >>"$error_log" 2>&1 || true
# bootout can return before the old registration disappears.
for attempt in 1 2 3 4 5; do
  if launchctl bootstrap "$domain" "$plist" >>"$error_log" 2>&1 &&
    launchctl print "$domain/$label" >/dev/null 2>>"$error_log"; then
    echo "→ loaded $label"
    exit 0
  fi
  if [[ $attempt -lt 5 ]]; then
    sleep "$attempt"
  fi
done
echo "→ failed to load $label (see $error_log)" >&2
exit 1
