#!/usr/bin/env bash
# Runs a command and republishes its output as GitHub annotations (visible without login),
# so test failures can be read from the public API.
set -o pipefail
out=$(mktemp)
bash -c "$1" 2>&1 | tee "$out"
status=${PIPESTATUS[0]}
level=notice; [ "$status" -ne 0 ] && level=error
# GitHub keeps at most 10 annotations of each level per step: show the important lines.
clean=$(grep -v -e '^\s*$' -e 'ExperimentalWarning' -e 'Reparsing as ES module' -e 'trace-warnings' -e 'eliminate this warning' -e 'MODULE_TYPELESS' "$out")
if [ -n "${CI_KEY:-}" ]; then picked=$(echo "$clean" | grep -E "$CI_KEY" | tail -10); else picked=$(echo "$clean" | tail -10); fi
echo "$picked" | while IFS= read -r line; do
  echo "::$level::${line//%/%25}"
done
exit "$status"
