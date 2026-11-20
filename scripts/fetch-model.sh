#!/usr/bin/env bash
# Downloads the Maia-3 (5M, fp16) ONNX model that gets bundled into the app,
# pinned to an exact revision and verified by SHA-256, so the build can't silently
# pick up a different file.
set -euo pipefail
REV=923df9a2e9396b54a09b168bb858ebbd5e5b76bc
FILE=maia3-5m.fp16.onnx
SHA256=ca22fc3031975932e693f9758149302efc177749165443ed52de828add8864fa
cd "$(dirname "$0")/.."
mkdir -p models
if [ -f "models/$FILE" ] && echo "$SHA256  models/$FILE" | sha256sum -c --quiet 2>/dev/null; then
  echo "models/$FILE already present and verified"; exit 0
fi
curl -fsSL --retry 3 -o "models/$FILE.part" "https://huggingface.co/bqrio/maia3-onnx/resolve/$REV/$FILE"
echo "$SHA256  models/$FILE.part" | sha256sum -c -
mv "models/$FILE.part" "models/$FILE"
echo "models/$FILE downloaded and verified"
