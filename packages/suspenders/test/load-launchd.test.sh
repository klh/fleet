#!/usr/bin/env bash
# Exercise retries/failures with fake launchctl; never touch real user jobs.
set -euo pipefail
loader="$(cd "$(dirname "$0")/../scripts" && pwd)/load-launchd.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin"
export LAUNCHD_TEST_STATE="$scratch/state"
export PATH="$scratch/bin:$PATH"
printf '<plist/>\n' >"$scratch/com.test.job.plist"
printf '#!/bin/sh\nexit 0\n' >"$scratch/bin/plutil"
printf '#!/bin/sh\nexit 0\n' >"$scratch/bin/sleep"
cat >"$scratch/bin/launchctl" <<'SH'
#!/bin/sh
case "$1" in
  bootout) exit 0 ;;
  print) [ "$LAUNCHD_TEST_MODE" != unregistered ]; exit $? ;;
  bootstrap)
    count=0
    [ ! -f "$LAUNCHD_TEST_STATE" ] || read -r count <"$LAUNCHD_TEST_STATE"
    count=$((count + 1))
    printf '%s\n' "$count" >"$LAUNCHD_TEST_STATE"
    case "$LAUNCHD_TEST_MODE" in
      fail) echo 'Bootstrap failed: 5: Input/output error' >&2; exit 5 ;;
      retry) [ "$count" -ge 3 ]; exit $? ;;
      *) exit 0 ;;
    esac ;;
esac
exit 1
SH
chmod +x "$scratch/bin/launchctl" "$scratch/bin/plutil" "$scratch/bin/sleep"
for mode in success retry fail unregistered; do
  export LAUNCHD_TEST_MODE=$mode
  rm -f "$LAUNCHD_TEST_STATE"
  code=0
  bash "$loader" "$scratch/com.test.job.plist" "$scratch/errors.log" >"$scratch/output" 2>&1 || code=$?
  read -r attempts <"$LAUNCHD_TEST_STATE"
  case "$mode" in
    success) [[ $code -eq 0 && $attempts -eq 1 ]] ;;
    retry) [[ $code -eq 0 && $attempts -eq 3 ]] ;;
    fail|unregistered)
      [[ $code -eq 1 && $attempts -eq 5 ]]
      if rg -q 'loaded com.test.job' "$scratch/output"; then
        echo 'incorrect success report' >&2
        exit 1
      fi ;;
  esac
  echo "PASS $mode"
done
