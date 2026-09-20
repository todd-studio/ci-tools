#!/bin/bash
# Black-box contract for ci-fetch.sh, the trust root for every artifact it verifies.
#
# Run: bash tests/ci-fetch.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FETCH="${CI_FETCH_UNDER_TEST:-$ROOT/ci-fetch.sh}"
TMP="$(mktemp -d)" || exit 2
trap 'rm -rf "$TMP"' EXIT
FAILED=0

fail() { printf 'FAIL %s\n' "$1"; FAILED=$((FAILED + 1)); }
pass() { printf 'ok   %s\n' "$1"; }

assert_status() { # <name> <want> <got>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (want $2, got $3)"; fi
}

assert_file_equals() { # <name> <want-file> <got-file>
  if [ -f "$3" ] && cmp -s "$2" "$3"; then pass "$1"; else fail "$1"; fi
}

assert_absent() { # <name> <path>
  if [ ! -e "$2" ]; then pass "$1"; else fail "$1"; fi
}

assert_contains() { # <name> <file> <literal>
  if grep -Fq -- "$3" "$2"; then pass "$1"; else fail "$1"; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

[ -x "$FETCH" ] || { echo "ci-fetch test prerequisite missing: $FETCH" >&2; exit 2; }

printf 'trusted payload\n' > "$TMP/trusted"
printf 'substituted payload\n' > "$TMP/substituted"
printf 'existing destination\n' > "$TMP/existing"
GOOD_HASH="$(sha256_of "$TMP/trusted")"

echo "matching bytes"
out="$("$FETCH" "file://$TMP/trusted" "$GOOD_HASH" "$TMP/verified" 2>&1)"; rc=$?
assert_status "matching bytes succeed" 0 "$rc"
assert_file_equals "matching bytes reach the destination exactly" "$TMP/trusted" "$TMP/verified"
printf '%s\n' "$out" > "$TMP/matching.out"
assert_contains "success names the verified destination" "$TMP/matching.out" "$TMP/verified"

echo "substituted bytes"
BAD_HASH="$(sha256_of "$TMP/substituted")"
out="$("$FETCH" "file://$TMP/trusted" "$BAD_HASH" "$TMP/refused" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "substituted bytes fail"; else fail "substituted bytes fail"; fi
assert_absent "substituted bytes produce no destination" "$TMP/refused"
printf '%s\n' "$out" > "$TMP/refused.out"
assert_contains "substitution refusal is explicit" "$TMP/refused.out" "ci-fetch: REFUSING"

cp "$TMP/existing" "$TMP/existing.dest"
out="$("$FETCH" "file://$TMP/trusted" "$BAD_HASH" "$TMP/existing.dest" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "substitution over an existing destination fails"; else fail "substitution over an existing destination fails"; fi
assert_file_equals "a refused substitution preserves the existing destination" "$TMP/existing" "$TMP/existing.dest"

echo "malformed hash"
MALFORMED="$(printf '0%.0s' {1..63})g"
out="$("$FETCH" "file://$TMP/does-not-exist" "$MALFORMED" "$TMP/malformed" 2>&1)"; rc=$?
assert_status "a malformed hash is a usage failure before download" 2 "$rc"
assert_absent "a malformed hash produces no destination" "$TMP/malformed"
printf '%s\n' "$out" > "$TMP/malformed.out"
assert_contains "a malformed hash names the invalid input" "$TMP/malformed.out" "not lowercase hex"

echo "unreadable source"
out="$("$FETCH" "file://$TMP/does-not-exist" "$GOOD_HASH" "$TMP/unreadable" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "an unreadable source fails"; else fail "an unreadable source fails"; fi
assert_absent "an unreadable source produces no destination" "$TMP/unreadable"
printf '%s\n' "$out" > "$TMP/unreadable.out"
assert_contains "an unreadable source says nothing was established" "$TMP/unreadable.out" "could not download"

[ "$FAILED" -eq 0 ] || exit 1
echo "ci-fetch: all assertions passed"
