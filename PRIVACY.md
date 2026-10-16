# Privacy — Local Developer Accelerator for Optimizely

Published by Coding Koalas Pty Ltd (ACN 668 775 433), by Coding Koala.
Last updated: 2026-10-16.

No telemetry, analytics, crash reporting or tracking. Coding Koala receives no
usage data. The CLI stores user configuration, notice acceptance, downloaded
releases, cached update lookups and temporary elevation plans/results locally.
Plans contain paths and service options, not GitHub tokens. Plans/results are
removed after each elevation attempt and their folder has a user-only DACL.

## External connections

| Trigger | Destination | Information sent |
| --- | --- | --- |
| list, install, upgrade, adopt, foreground download, explicit update checks | api.github.com and GitHub release asset hosts | Normal request metadata/IP, requested repository/release; configured GitHub token to the API |
| status with --check-updates, checkUpdates=true; tray daily checks when enabled | api.github.com | Release lookup metadata/IP |
| Windows install when wrapper missing | github.com/WinSW | Pinned WinSW 2.12.0 download request/IP |
| self-update | registry.npmjs.org; while the package is not on npm, api.github.com and the GitHub release download host; npm's configured registry when applying | Package or release lookup and npm install metadata/IP (no GitHub token is sent for the release lookup); npm handles its own credentials |
| doctor --online | api.github.com | HEAD request/IP to compare the Date header |

No other external connections are initiated by the CLI. GitHub may redirect
asset downloads to its release delivery hosts. Release lookups have a one-hour
cache. checkUpdates defaults to false. The CLI may invoke `gh auth token` locally
to retrieve an existing GitHub credential. It does not upload logs or CMS data.
Local health checks, the hub, tray and dashboard links use loopback.
Module dashboards and module-configured integrations have their own privacy notices.

## Local data

Default runtime root: `C:\ProgramData\Coding Koala\Local Developer Accelerator`.
Modules can store CMS content (including drafts), assets, generated secrets and
request logs. Use synthetic content. You are responsible for any personal data
you put there and for securing the machine. Service runtime permissions restrict
access to administrators, SYSTEM and LocalService, with read-only wrapper/XML
access for Users. Foreground data is under your own user account.

User state: `%LOCALAPPDATA%\Coding Koala\Local Developer Accelerator`, with
config.json, cache, run, plans and tray.json. Foreground data and downloads are
not removed by service uninstall. `lda uninstall <mod>` retains service data;
`--purge` removes that module's runtime only after confirmation. Stop foreground
processes before manually deleting user cache/run directories.

Contact: privacy@codingkoala.io.
