#!/bin/bash
# Fetch a pinned release artifact and refuse to produce it unless its SHA-256 matches.
#
# CI installs yq, chezmoi and gitleaks by downloading release binaries, because the runner image
# does not carry the versions the Macs run. On the Macs those same tools come from Homebrew, which
# verifies what it downloads; in CI nothing did. A pinned version is not a pinned artifact — a
# release asset can be replaced, and a tag can be moved — and the one that matters most is
# gitleaks, where a substituted binary that cheerfully reports "no leaks found" is exactly the
# attack the scan exists to prevent.
#
# One fetcher rather than a verification step copied beside each download, so a new tool cannot be
# added without one and the four call sites cannot drift apart. The hashes themselves live in
# ci.yml's `env:` block, next to the versions they belong to.
#
# Usage: scripts/ci-fetch.sh <url> <sha256> <dest>
#   <dest> must be writable without sudo; installing into place is the caller's job, so this
#   never needs privileges of its own.
set -uo pipefail

[ $# -eq 3 ] || { echo "usage: $0 <url> <sha256> <dest>" >&2; exit 2; }
url="$1"; want="$2"; dest="$3"

# Every character, not merely the first. `[0-9a-f]*` matches anything that STARTS with a hex
# digit, so 63 hex digits followed by a 'g' satisfied it; `*[!0-9a-f]*` matches if any character
# is outside the set, which is the question actually being asked.
case "$want" in
  *[!0-9a-f]*) echo "ci-fetch: '$want' is not lowercase hex" >&2; exit 2 ;;
esac
[ "${#want}" = 64 ] || { echo "ci-fetch: '$want' is ${#want} characters, not a 64-character sha256" >&2; exit 2; }

# GNU first, then BSD: `shasum` exists on the Macs, `sha256sum` on the runners. Asked in that
# order because the GNU spelling is the one CI actually uses.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

tmp="$(mktemp)" || exit 1
trap 'rm -f "$tmp"' EXIT

curl --fail --location --silent --show-error \
     --connect-timeout 10 --max-time 120 \
     --retry 5 --retry-delay 1 --retry-all-errors \
     --output "$tmp" "$url" \
  || { echo "ci-fetch: could not download $url" >&2; exit 1; }

got="$(sha256_of "$tmp")"
if [ "$got" != "$want" ]; then
  # Deliberately loud, and deliberately fatal. The artifact is left in the temporary file and
  # removed, so nothing downstream can pick up something that failed this check.
  {
    echo "ci-fetch: REFUSING $url"
    echo "  expected sha256 $want"
    echo "  actual   sha256 $got"
    echo "  The pinned artifact changed. Do not update the hash to match until you know why."
  } >&2
  exit 1
fi

# Only now does anything appear at the destination, so a caller that checks for the file cannot
# see a half-written or unverified one.
mv "$tmp" "$dest" || exit 1
trap - EXIT
echo "ci-fetch: verified $(basename "$url") -> $dest"
