#!/usr/bin/env sh
# Runs every tests/test-*.js under gjs (preferred) or node.
set -u
cd "$(dirname "$0")"

if [ -n "${GJS:-}" ]; then
    run() { "$GJS" -m "$1"; }
elif command -v gjs >/dev/null 2>&1; then
    run() { gjs -m "$1"; }
elif command -v node >/dev/null 2>&1; then
    run() { node "$1"; }
else
    echo "error: neither gjs nor node found." >&2
    echo "hint: nix shell nixpkgs#gjs -c ./tests/run.sh   (or set GJS=/path/to/gjs)" >&2
    exit 1
fi

fail=0
for f in test-*.js; do
    echo "== $f"
    run "$f" || fail=1
done
[ "$fail" -eq 0 ] && echo "ALL PASS" || echo "FAILURES" >&2
exit "$fail"
