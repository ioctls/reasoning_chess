#!/usr/bin/env bash
# Runs a command and republishes its output as GitHub annotations (visible without login),
# so test failures can be read from the public API.
set -o pipefail
out=$(mktemp)
bash -c "$1" 2>&1 | tee "$out"
status=${PIPESTATUS[0]}
level=notice; [ "$status" -ne 0 ] && level=error
grep -v -e '^\s*$' -e 'ExperimentalWarning' -e 'Reparsing as ES module' -e 'trace-warnings' -e 'eliminate this warning' "$out" | tail -40 | while IFS= read -r line; do
  echo "::$level::${line//%/%25}"
done
exit "$status"
