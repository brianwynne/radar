#!/usr/bin/env bash
#
# RADAR one-command bootstrap — installs a release straight from GitHub onto a bare Ubuntu host.
# It downloads the release bundle for this architecture (private repo → needs a token), verifies
# its checksum, runs the installer, and saves the token so future `radar upgrade` works.
#
# Usage (the token is needed both to fetch this script and to download the bundle):
#
#   export GH=<github-token>
#   curl -fsSL -H "Authorization: Bearer $GH" -H "Accept: application/vnd.github.raw" \
#     "https://api.github.com/repos/brianwynne/radar/contents/deploy/bootstrap.sh?ref=main" \
#     | sudo GITHUB_TOKEN="$GH" bash -s -- --version v0.1.0-rc2
#
# Omit `--version` to install the newest release (including pre-releases).
#
set -euo pipefail

REPO="brianwynne/radar"
log() { printf '\033[1;34m[radar-bootstrap]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[radar-bootstrap] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version|--tag) VERSION="${2:-}"; shift 2 ;;
    -h|--help) echo "usage: bootstrap.sh [--version vX.Y.Z]"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)."
TOKEN="${GITHUB_TOKEN:-}"
[ -n "$TOKEN" ] || die "GITHUB_TOKEN is required (private repo). Run as: sudo GITHUB_TOKEN=<token> bash …"
for c in curl tar sha256sum python3 dpkg; do command -v "$c" >/dev/null || die "missing required tool: $c"; done

ARCH="$(dpkg --print-architecture)"
case "$ARCH" in amd64|arm64) ;; *) die "unsupported architecture: ${ARCH} (need amd64 or arm64)." ;; esac

api()      { curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/${REPO}$1"; }
download() { curl -fL   -H "Authorization: Bearer $TOKEN" -H "Accept: application/octet-stream"     "https://api.github.com/repos/${REPO}/releases/assets/$1" -o "$2"; }
tag_of()   { python3 -c 'import sys,json; print(json.load(sys.stdin).get("tag_name",""))'; }
asset_id() { python3 -c 'import sys,json; d=json.load(sys.stdin); a=next((x for x in d.get("assets",[]) if x["name"]==sys.argv[1]), None); print(a["id"] if a else "")' "$1"; }

log "Resolving release (${VERSION:-newest})…"
if [ -n "$VERSION" ]; then
  rel="$(api "/releases/tags/${VERSION}")" || die "release ${VERSION} not found (or token lacks access)."
else
  rel="$(api "/releases?per_page=1" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(json.dumps(d[0] if d else {}))')"
fi
tag="$(printf '%s' "$rel" | tag_of)"
[ -n "$tag" ] || die "no release found for ${REPO}."

asset="radar-${tag}-linux-${ARCH}.tar.gz"
aid="$(printf '%s' "$rel" | asset_id "$asset")"
[ -n "$aid" ] || die "release ${tag} has no asset '${asset}'."
sid="$(printf '%s' "$rel" | asset_id "${asset}.sha256")"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
log "Downloading ${asset}…"
download "$aid" "${tmp}/${asset}"
if [ -n "$sid" ]; then
  download "$sid" "${tmp}/${asset}.sha256"
  log "Verifying checksum…"
  ( cd "$tmp" && sha256sum -c "${asset}.sha256" ) >/dev/null || die "checksum verification FAILED."
fi

log "Extracting and installing ${tag}…"
tar -C "$tmp" -xzf "${tmp}/${asset}"
bundle="${tmp}/radar-${tag}-linux-${ARCH}"
[ -x "${bundle}/deploy/install.sh" ] || die "bundle is missing deploy/install.sh."
( cd "$bundle" && ./deploy/install.sh )

# Persist the token so `radar upgrade` can pull future private releases without re-supplying it.
if [ -d /etc/radar ]; then
  umask 077; printf '%s' "$TOKEN" > /etc/radar/.github-token
  chmod 600 /etc/radar/.github-token; chown root:root /etc/radar/.github-token
  log "GitHub token saved to /etc/radar/.github-token for future 'radar upgrade'."
fi

log "Done — RADAR ${tag} installed. Next: sudo radar cert --domain <fqdn> --email <addr>"
