#!/bin/sh
# Runs test/system in a throwaway container, because it rewrites /etc/opencode and /etc/profile.d.
# The container uses the host's `bun` and `opencode`, and the repository read-only.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
bun=$(readlink -f "$(command -v bun)")
opencode=$(readlink -f "$(command -v opencode)")
docker build -q -t ocsp-system - <"$root/test/system/Dockerfile" >/dev/null
exec docker run --rm \
  -v "$bun:/usr/local/bin/bun:ro" \
  -v "$opencode:/usr/local/bin/opencode:ro" \
  -v "$root:/repo:ro" -w /repo \
  -e OCSP_SYSTEM=1 \
  ocsp-system bun test test/system "$@"
