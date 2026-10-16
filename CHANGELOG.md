# Changelog

## [1.0.1] - 2026-10-16

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
