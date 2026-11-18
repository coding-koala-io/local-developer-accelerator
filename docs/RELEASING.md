# Releasing

No publish occurs during normal CLI tests or local development.

1. Work from develop using feature/* branches; main contains released versions.
2. Start a release with `git flow release start X.Y.Z`. Update package.json,
   package-lock.json and CHANGELOG.md (the CLI reads its version from package.json).
   LICENSE.md is the standard Apache License 2.0 text and is not changed for a release.
3. Run `npm ci` and `npm test` on Node 24, Windows and Linux. Review the packaged
   file list and audit repository history for prohibited vendor/research material.
4. Finish with `git flow release finish X.Y.Z`, then push main, develop and tags.
   Hotfixes use hotfix/* and back-merge to develop.
5. The v* workflow checks that tag equals package version, tests both platforms,
   then runs `npm pack` and creates a GitHub Release using the matching CHANGELOG
   section, with `coding-koala-io-accelerator-X.Y.Z.tgz`,
   `coding-koala-io-accelerator.tgz`, `install.ps1`, `install.sh` and `SHA256SUMS`
   attached. Users install the latest release with
   `npm i -g https://github.com/coding-koala-io/local-developer-accelerator/releases/latest/download/coding-koala-io-accelerator.tgz`.
   Publishing to npm occurs only if repository variable NPM_PUBLISH is exactly
   `true`. `lda self-update` uses npm when the package exists there and otherwise
   the latest GitHub release tarball, so keep the unversioned tarball asset name
   unchanged for both the install command above and `lda self-update`.

Configure npm trusted publishing for coding-koala-io/local-developer-accelerator
and workflow release.yml. The publish job uses no GitHub environment, so leave the
environment field of the trusted publisher empty. No long-lived npm token.
The publish job needs id-token: write and publishes public provenance.
Set NPM_PUBLISH only when the scoped package/org and trusted publisher are ready.

Module releases are separate. Each module publishes lda-<key>-<version>.zip,
manifest.json and SHA256SUMS; zip root contains src/server.js and
scripts/service-xml.js plus its runtime dependencies. The manifest includes
module, product, version, minNode, dataVersion, file, sha256, size, commit, builtAt.
Test adoption, install, upgrade, failed-upgrade restore and rollback on a disposable
Windows machine with explicit approval before release. Automated tests never do
real elevation or service changes.
