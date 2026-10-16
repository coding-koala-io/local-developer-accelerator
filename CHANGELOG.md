# Changelog

## [1.1.0] - unreleased

### Added
- One-line installers that always take the latest release: `install.ps1` for Windows (`irm .../releases/latest/download/install.ps1 | iex`, PowerShell 5.1 and 7, no administrator rights) and `install.sh` for macOS/Linux (`curl -fsSL .../releases/latest/download/install.sh | sh`). They check Node.js 24+ and npm (never install Node.js), verify the tarball against `SHA256SUMS` before `npm i -g`, and accept `LDA_VERSION` and `GITHUB_TOKEN`.
- Every release also carries an unversioned `coding-koala-io-accelerator.tgz` (same bytes as the versioned tarball) and both installers, all listed in `SHA256SUMS`, so `releases/latest/download/<name>` links never change.

### Changed
- `lda self-update` installs from the stable latest-release URL when the CLI is not on npm and the release carries the unversioned tarball.

## [1.0.1] - unreleased

### Fixed
- Second and later elevated runs or dry runs failed with "Windows command failed (exit 1)" because re-locking the plans folder needed the audit privilege; permissions are now written without touching audit settings.
- Errors from Windows PowerShell now show the real reason (secrets removed) instead of a generic message.
- `--dry-run` runs every check read-only, marks checks that need admin, and prints the exact fix for refusals (for example a parent folder that other users can modify).
- Paths with 8.3 short names are compared in their long form.
- The CLI version is read from package.json (single source of truth).

## [1.0.0] - 2026-10-16

- Catalogue-driven LDA Local Graph and LDA Local Assets management.
- Verified GitHub/offline releases, batched Windows elevation and legacy adoption.
- Foreground mode, service diagnostics, Ink terminal screen, tray and local hub.
- Development-only notices, privacy documentation and BSL 1.1 licensing.
- Distributed as a tarball on the GitHub release until the npm package is published; `lda self-update` uses npm when the package exists and otherwise the latest GitHub release tarball.
