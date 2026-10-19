#!/usr/bin/env bash
# Portable lint + typecheck. Exit code is nonzero if either step fails.
set -euo pipefail
fail=0

echo "==> lint"
bun run lint || fail=1

echo "==> typecheck"
bun run typecheck || fail=1

exit $fail
