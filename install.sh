#!/bin/sh
# Local Developer Accelerator for Optimizely - one-line installer for macOS and Linux.
#   curl -fsSL https://github.com/coding-koala-io/local-developer-accelerator/releases/latest/download/install.sh | sh
# Options (environment variables):
#   LDA_VERSION      pin a release, for example v1.1.0 (default: the latest release)
#   GITHUB_TOKEN     optional; sent only to the releases API to avoid its rate limit
#   LDA_INSTALL_API  override the releases API base (testing and mirrors only)
# Needs curl, Node.js 24+ and npm. It never installs Node.js and needs no sudo
# unless your npm global folder is owned by root.
set -eu

REPO="coding-koala-io/local-developer-accelerator"
TMP=""
cleanup() { if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT INT TERM

fail() {
  printf '\nInstall failed: %s\n  Fix: %s\n' "$1" "$2" >&2
  exit 1
}

printf '\nLocal Developer Accelerator for Optimizely - by Coding Koala\n'
printf 'Development and research use only. Never use in production.\n'
printf -- '- Local stand-ins for Optimizely cloud services; behaviour differs from the real services.\n'
printf -- '- Runs on this machine only. No telemetry. Provided as is, without warranty. Licence: BSL 1.1.\n'
printf -- '- Independent project; not affiliated with, sponsored by or endorsed by Optimizely.\n\n'

# 1. Tools: curl, Node.js 24+, npm, a SHA-256 tool. Node.js is never installed automatically.
NODE_HELP="Install Node.js 24 or newer (https://nodejs.org, or your package manager, for example: brew install node), open a new terminal and run this command again."
command -v curl >/dev/null 2>&1 || fail "curl was not found." "Install curl with your package manager and run this command again."
command -v node >/dev/null 2>&1 || fail "Node.js was not found on PATH." "$NODE_HELP"
NODE_VERSION=$(node --version 2>/dev/null || true)
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p')
[ -n "$NODE_MAJOR" ] || fail "Could not read the Node.js version (got '$NODE_VERSION')." "$NODE_HELP"
[ "$NODE_MAJOR" -ge 24 ] || fail "Node.js $NODE_VERSION is too old; this CLI needs Node.js 24 or newer." "$NODE_HELP"
command -v npm >/dev/null 2>&1 || fail "npm was not found on PATH." "npm ships with Node.js; reinstall Node.js 24 or newer from https://nodejs.org and open a new terminal."
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"
else fail "No SHA-256 tool (sha256sum or shasum) was found." "Install coreutils (Linux) or Perl's shasum (macOS ships it) and run again."
fi
printf 'Node.js %s and npm found.\n' "$NODE_VERSION"

# 2. Which release.
API="${LDA_INSTALL_API:-https://api.github.com/repos/$REPO}"
API="${API%/}"
PIN="${LDA_VERSION:-}"
if [ -n "$PIN" ]; then
  case "$PIN" in v*) ;; *) PIN="v$PIN" ;; esac
  printf '%s' "$PIN" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail "LDA_VERSION '$LDA_VERSION' is not a version like v1.1.0." "Set LDA_VERSION to a release tag such as v1.1.0, or unset it to install the latest release."
  RELEASE_URL="$API/releases/tags/$PIN"
else
  RELEASE_URL="$API/releases/latest"
fi
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t lda-install)
JSON="$TMP/release.json"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  STATUS=$(curl -sSL -o "$JSON" -w '%{http_code}' --max-time 30 -H 'Accept: application/vnd.github+json' -H 'User-Agent: lda-installer' -H "Authorization: Bearer $GITHUB_TOKEN" "$RELEASE_URL" || echo 000)
else
  STATUS=$(curl -sSL -o "$JSON" -w '%{http_code}' --max-time 30 -H 'Accept: application/vnd.github+json' -H 'User-Agent: lda-installer' "$RELEASE_URL" || echo 000)
fi
case "$STATUS" in
  200) ;;
  404) if [ -n "$PIN" ]; then fail "Release $PIN of $REPO was not found." "Check the tag at https://github.com/$REPO/releases, or unset LDA_VERSION to install the latest."
       else fail "No release of $REPO was found." "See https://github.com/$REPO/releases."; fi ;;
  403|429) fail "GitHub refused the request (HTTP $STATUS), usually its hourly rate limit." "Wait an hour, or export GITHUB_TOKEN=<a GitHub token with no scopes> and run again." ;;
  *) fail "Could not reach the GitHub releases API (HTTP $STATUS)." "Check your internet connection or proxy, then run again." ;;
esac

# Read the tag and the two asset URLs with Node (already required), not a JSON tool that may be missing.
INFO=$(node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const m = /^v(\d+\.\d+\.\d+)$/.exec(String(r.tag_name || ""));
if (!m) { console.log("ERR tag " + String(r.tag_name)); process.exit(0); }
const name = "coding-koala-io-accelerator-" + m[1] + ".tgz", assets = Array.isArray(r.assets) ? r.assets : [];
const url = n => (assets.find(a => a && a.name === n) || {}).browser_download_url || "";
console.log(["OK", r.tag_name, name, url(name), url("SHA256SUMS")].join(" "));
' "$JSON") || fail "Could not read the release information." "Run the command again; if it keeps failing, report it at https://github.com/$REPO/issues."
set -- $INFO
[ "${1:-}" = "OK" ] || fail "The release has an unexpected tag (${3:-unknown})." "Install manually from https://github.com/$REPO/releases."
TAG="$2"; TGZ_NAME="$3"; TGZ_URL="${4:-}"; SUMS_URL="${5:-}"
[ -n "$TGZ_URL" ] && [ -n "$SUMS_URL" ] || fail "Release $TAG has no $TGZ_NAME and SHA256SUMS." "Install manually from https://github.com/$REPO/releases."
for u in "$TGZ_URL" "$SUMS_URL"; do
  case "$u" in
    https://*|http://127.0.0.1:*|http://127.0.0.1/*|http://localhost:*|http://localhost/*) ;;
    *) fail "The release lists a download address that is not HTTPS ($u)." "Do not continue; report this at https://github.com/$REPO/issues." ;;
  esac
done
printf 'Installing the CLI %s ...\n' "$TAG"

# 3. Download and verify.
TGZ="$TMP/$TGZ_NAME"
curl -fsSL --max-time 300 -H 'User-Agent: lda-installer' -o "$TGZ" "$TGZ_URL" || fail "Download of $TGZ_NAME failed." "Check your internet connection or proxy, then run again."
curl -fsSL --max-time 60 -H 'User-Agent: lda-installer' -o "$TMP/SHA256SUMS" "$SUMS_URL" || fail "Download of SHA256SUMS failed." "Check your internet connection or proxy, then run again."
EXPECTED=$(awk -v n="$TGZ_NAME" '{f=$2; sub(/^\*/, "", f); if (f == n && length($1) == 64) {print tolower($1); exit}}' "$TMP/SHA256SUMS")
[ -n "$EXPECTED" ] || fail "SHA256SUMS of $TAG has no line for $TGZ_NAME." "Do not install this download; report it at https://github.com/$REPO/issues."
ACTUAL=$($SHA "$TGZ" | awk '{print tolower($1)}')
[ "$ACTUAL" = "$EXPECTED" ] || fail "Checksum mismatch for $TGZ_NAME (expected $EXPECTED, got $ACTUAL). The download is damaged or was tampered with; nothing was installed." "Run the command again. If it keeps failing, report it at https://github.com/$REPO/issues."
printf 'SHA-256 verified (%s).\n' "$ACTUAL"

# 4. Install with npm.
npm i -g "$TGZ" --no-fund --no-audit || fail "npm install failed." "Read the npm messages above. On EACCES your npm global folder is not writable: run 'npm config set prefix ~/.npm-global', add ~/.npm-global/bin to PATH, then run this again (avoid sudo)."

# 5. Confirm.
PREFIX=$(npm prefix -g)
LDA="$PREFIX/bin/lda"
[ -x "$LDA" ] || LDA="$PREFIX/lda"
[ -x "$LDA" ] || LDA=$(command -v lda || echo lda)
INSTALLED=$("$LDA" --version 2>/dev/null || true)
[ -n "$INSTALLED" ] || fail "The CLI was installed but 'lda --version' did not run." "Open a new terminal and run lda --version. The npm global folder is $PREFIX."
printf '\nInstalled lda %s.\n' "$INSTALLED"
case ":$PATH:" in *":$PREFIX/bin:"*) ;; *) printf 'Note: %s/bin is not on PATH. Add it to PATH, then open a new terminal.\n' "$PREFIX" ;; esac
printf '\nNext steps:\n'
printf '  lda                        open the manager (first run asks you to accept the notice)\n'
printf '  lda install graph assets   install LDA Local Graph and LDA Local Assets (Windows services)\n'
printf '  lda run all                run the modules in the foreground (macOS/Linux)\n'
printf '  lda adopt                  take over an older install without moving its data\n'
printf '  lda tray                   start the tray icon (Windows)\n'
printf '  lda self-update            update this CLI later\n'
