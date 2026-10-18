#!/usr/bin/env bash
set -euo pipefail
test -d "$DSH_TEST_HOST_ROOT"
cd -- "$(dirname -- "$0")/.."
exec node --experimental-transform-types --import ./test/offline-guard.mjs --import ./test/host-loader.mjs --test test/*.test.mjs
