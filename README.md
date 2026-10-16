> **Development and research use only. Never use in production.**
> Local Developer Accelerator for Optimizely runs local stand-ins for Optimizely cloud services on a single
> developer machine. It is not a replacement for any Optimizely service: its
> behaviour, limits and performance differ, so always test against the real services
> before release. Keep it bound to localhost and never expose it to a network.
> Provided "as is", without warranty of any kind. Its data folder holds copies of
> your CMS content, including drafts; treat it as sensitive. No telemetry. See
> PRIVACY.md and LEGAL-NOTICE.md.
> Local Developer Accelerator for Optimizely is an independent project, not affiliated with, sponsored by or
> endorsed by Optimizely. Optimizely® and the Optimizely product names are trademarks
> or registered trademarks of Optimizely North America Inc. or its related entities.

# Local Developer Accelerator for Optimizely

By Coding Koala · published by Coding Koalas Pty Ltd (ACN 668 775 433).
Node 24 or newer. Windows services, optional tray and a loopback-only hub;
foreground mode also works on macOS/Linux. Free non-production use under BSL 1.1.

## Install and quick start

Windows (PowerShell 5.1 or 7, no administrator rights needed):

```powershell
irm https://github.com/coding-koala-io/local-developer-accelerator/releases/latest/download/install.ps1 | iex
```

macOS / Linux:

```sh
curl -fsSL https://github.com/coding-koala-io/local-developer-accelerator/releases/latest/download/install.sh | sh
```

The installers always take the latest release. They check for Node.js 24+ and npm
(they never install Node.js; on Windows use `winget install OpenJS.NodeJS.LTS` or
https://nodejs.org), download the release tarball and `SHA256SUMS`, refuse to
install on a checksum mismatch, run `npm i -g` on the verified file and show
`lda --version`. Options are environment variables: `LDA_VERSION=v1.1.0` pins a
release, `GITHUB_TOKEN` avoids the GitHub API rate limit.

Or with npm directly (always the latest release, no checksum step):

```sh
npm i -g https://github.com/coding-koala-io/local-developer-accelerator/releases/latest/download/coding-koala-io-accelerator.tgz
```

Once the CLI is published to npm: `npm i -g @coding-koala-io/accelerator`.

Then:

```powershell
lda
lda install graph assets
lda status
```

Already running the services from an older manual install? Use `lda adopt`.
`lda tray` starts the tray icon.

`lda self-update` checks npm first and, while the package is not on npm, the
latest GitHub release of this repository (using the stable
`releases/latest/download/coding-koala-io-accelerator.tgz` URL), then prints (or
with `--yes` runs) the matching `npm i -g` command. Every release carries a
`SHA256SUMS` file covering the tarballs and both installers.

`accelerator` is an alias for `lda`. First run asks you to read and accept the notice.
For automation, read `lda about`, then pass `--accept-notice` or set
`LDA_ACCEPT_NOTICE=1`. Acceptance is saved per CLI major version. `--yes` does
not accept the notice. Non-TTY and CI runs print status rather than opening Ink.

| Module | Compatibility | Default port | Service |
| --- | --- | --- | --- |
| `graph` | Optimizely Graph | 8082 | LdaGraph |
| `assets` (`dam` alias) | Optimizely CMS DAM picker | 8083 | LdaAssets |

## Commands

| Command | Purpose |
| --- | --- |
| `list` | Available and installed releases |
| `status [--check-updates]` | Service state, version, port, health, dashboard |
| `install <mod...>` | Download, verify, one Windows approval for the batch |
| `upgrade [mod...] [--all] [--check] [--version x.y.z]` | Check or apply upgrades |
| `rollback <mod>` | Return to the previous code version |
| `uninstall <mod> [--purge]` | Retain data unless purge is explicitly confirmed |
| `start/stop/restart <mod...> [--all]` | One approval per batch |
| `adopt [mod...] [--version x.y.z] [--from zip]` | Migrate legacy service registration without moving data |
| `open <mod>/hub` | Open the local dashboard |
| `logs <mod> [-n 50] [-f]` | Wrapper/server console logs; poll when following |
| `run <mod>/all [--port n]` | Foreground, no administrator access |
| `doctor [--online]` | Diagnostics with suggested fixes; online clock check opt-in |
| `config get [key]`, `config set <key> <value>` | checkUpdates, hubPort, ports.graph, ports.assets |
| `tray [--at-login] [--remove-at-login] [--stop]` | User-session tray and HKCU login entry |
| `hub [--port 8080] [--open]` | Browser manager, bound only to 127.0.0.1 |
| `about/privacy/licence` | Read notices without accepting them |
| `self-update [--yes]` | Check npm (or the latest GitHub release while the CLI is not on npm) and optionally run the printed update command |

Global options: `--json`, `--yes`, `--non-interactive`, `--dry-run`, `--accept-notice`.
Install options: `--version`, `--port`, `--data-dir` (absolute), `--memory-mb`
(Graph only: 1024–65536, default 8192), `--from <zip>` (single module).
`--data-dir` must be a new or empty folder, or an existing runtime folder that holds
only `tenants.json`, `data`, `logs`, `service`, `backups` and `.lda-runtime.json`;
anything else is refused. It may not be the same as, inside, or around another
module's data folder. An existing runtime folder is reused only when its
`.lda-runtime.json` marker (written at install/adopt, administrators only) names the
same module and service; a folder with runtime files but no marker can only be taken
over with `lda adopt`. `uninstall --purge` applies the layout check and also requires
the marker to name this module and this exact folder before deleting.

Before the first change of **every** operation (install, upgrade, rollback, uninstall,
start, stop, restart, adopt) the elevated helper checks every folder above the data
folder (except the drive root, and ProgramData/Program Files themselves, whose owner
only is checked), the data folder, `service\`, the code folders and version folders:
no junctions or symbolic links, owned by SYSTEM, Administrators, TrustedInstaller or
you, and nobody else may modify them (write, append, delete, change permissions or
take ownership, including generic write/all rights). LocalService may modify the data
folder, `data`, `logs` and `service\logs` only. If a check fails, the helper stops
with "Refusing to use <path>: <who> can modify it" and changes nothing; remove that
access as an administrator and retry. Missing folders are created one at a time with
their final, non-inherited permissions.
Use per-module commands for custom ports/data folders; no silent port changes.
`start/stop/restart --all` skip legacy services with a note; adopt them first.
Errors contain a fix; `LDA_DEBUG=1` enables stacks. Unhealthy installed services
make status exit 1; a cancelled Windows approval exits 2.

## Releases, upgrades and rollback

Releases come from `coding-koala-io/lda-graph` and `coding-koala-io/lda-assets`.
ZIPs must be named `lda-<key>-<version>.zip`, with adjacent `manifest.json` and
`SHA256SUMS`. Both hashes, module identity, version and Node requirements are
checked before elevation; the elevated helper checks the ZIP again. WinSW 2.12.0
is pinned by SHA-256. Archives containing traversal, links or special files are rejected.

Private repositories: `LDA_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then
`gh auth token`. Tokens are never written to plans or printed. Release lookups
are cached for one hour. Offline: set `LDA_RELEASE_SOURCE=dir:D:\releases`, with
`<root>\<module>\<version>\{ZIP,manifest.json,SHA256SUMS}`, or use `--from`.

Upgrades stage code beside the current version, preserve port/memory/environment,
switch XML, restart and require the expected `/health` version within 30 seconds.
A failed switch runs each recovery step on its own and reports each result: stop the
new version, restore the old XML, start the old version, check its `/health`. The
original failure stays the main error, and the result says plainly whether the old
version is healthy again. The failed release's extracted folder is deleted (never the
current or recorded previous version). After each healthy install, adoption, upgrade
or rollback, `versions.json` in the module's code folder records the current and
previous version (written atomically). Exactly those two code versions are kept.
`lda rollback` switches only to that recorded previous version, and only when the
record matches the version the service is actually running; running it again
switches back. Installs made before `versions.json` existed have no rollback target
until their next upgrade. Back up your runtime
before a data-version upgrade: code rollback does **not** undo a data migration.
Services use the `node.exe` found on PATH by the elevated helper; it and every folder
above it must be owned by SYSTEM, Administrators or TrustedInstaller, contain no
junctions, and be changeable only by those accounts (for example
`C:\Program Files\nodejs`). `tar.exe`, `icacls.exe`, `sc.exe` and the elevated
`powershell.exe` are always the System32 copies, never ones found on PATH.

## Existing installations

`lda status` detects `OptimizelyGraphLocal` and `OptimizelyDamLocal` as legacy installs.
Their version shows as `legacy` and they never show an update; a `/health` reply
without a product name counts as healthy. Run `lda adopt` (optionally with
`--version` or `--from`) to keep their runtime folders, tenants, ports and memory
settings and register the new service ids. The old service stays registered until
the new one is healthy: adoption stops the old service, registers the new id (reusing
the already verified WinSW wrapper), starts it and waits for its health check. Only
then is the old service unregistered and its wrapper files copied to
`backups\adopt-<old id>-<time>` and deleted. If anything fails, the new service is
stopped and removed, and the old service is started again only if it was running
before; the result reports each recovery step and says the old service is running
only after it answered `/health`. Because the old registration is never deleted on
failure, a custom service account on it is kept. Adoption normalises the runtime
folder's permissions to the standard policy (SYSTEM/Administrators full,
LocalService modify on data; `service\` read-only except its logs), the same policy
the original installer used. A data folder whose parent folders let other users
change them (for example `D:\SomeFolder` with "Authenticated Users: Modify") is
refused until that access is removed.
Ordinary install refuses a legacy service. Adoption is an explicit service change;
back up important local data first.

## Tray, hub and terminal

`lda tray --at-login` starts a single user-session icon and registers the CLI in
HKCU Run. Its menu calls the CLI for every operation. Quitting the tray leaves
services running; Stop all is separate. Daily update checks are off by default.
`lda tray --stop` signals only the tray.

`lda hub --open` opens module cards, health, service actions and log tails.
Mutating requests require a process-specific CSRF token and local Origin/Host.
Windows approval appears on your desktop. No remotely accessible bind option exists.
In Ink, arrows select; `o` opens, `s` starts/stops, `r` restarts, `i` installs,
`u` checks/upgrades, `l` tails logs, `a` toggles all-module actions, `?` helps, `q` quits.

## Storage and privacy

Code: `C:\Program Files\Coding Koala\Local Developer Accelerator\<Module>\<version>`.
Runtime: `C:\ProgramData\Coding Koala\Local Developer Accelerator\<Module>`
(or `--data-dir`), with tenants.json, data, logs and service wrapper/XML/logs.
Only the elevated helper writes service code. Runtime ACLs are replaced before secrets.
Created `Coding Koala` folders get a locked ACL (SYSTEM/Administrators full,
Users/LocalService read and run).

**What the elevated helper protects against.** The helper script ships inside the
npm package, which lives in your user-writable npm folder, and it reads a plan from
your user profile. Its checks (plan hash, plan and result files inside your private
plans folder, result file created exclusively and written through a verified
handle, trusted folder chains, no junctions) protect against other users of the
machine and against mistakes. They do **not** protect against code that is already
running as your own user account: such code could change the helper before you
approve the Windows prompt. A future version may copy the helper into Program Files.

User config/cache/foreground data/plans:
`%LOCALAPPDATA%\Coding Koala\Local Developer Accelerator\`.
Installed state is derived from Windows services, XML and local health; it is not
kept in a separate install database. Config defaults: checkUpdates=false, hubPort=8080.

No telemetry or analytics. External connections are release/update requests to
GitHub, optional WinSW download during install, and npm (or the GitHub release,
while the CLI is not on npm) for self-update. See
[Privacy](PRIVACY.md), [Legal notice](LEGAL-NOTICE.md), [Licence](LICENSE.md).
BSL 1.1 permits non-production use, with no Additional Use Grant; this version
changes to Apache 2.0 on 2030-10-16 (or the earlier date required by the licence).

## Threat model and known limits

The elevated helper is built to stop other users of the machine (and mistakes) from
getting their files run or trusted as a Windows service. Before it runs anything from
a version folder, it checks every file and folder in it, including `node_modules`:
no junctions or symbolic links, and nobody but SYSTEM, Administrators and
TrustedInstaller may change any of them. A folder that appears while the helper is
creating it is checked the same way before its permissions are touched. What it
does not cover:

- **Code already running as your own account.** See "What the elevated helper
  protects against" above.
- **Drive root permissions are not checked.** The helper checks every folder from the
  data folder up to, but not including, the drive root (for example `D:\`). Standard
  Windows drive permissions let ordinary users create new top-level folders but not
  replace or change folders that already exist, so this is safe on a drive with
  default permissions. If you changed the permissions of a drive root yourself, put
  the data folder on a drive with standard permissions.
- **A failed adopt does not restore permissions set on individual files inside the
  data folder.** Adopting a legacy install resets the permissions inside the data
  folder to the standard policy (SYSTEM and Administrators full control, the
  LocalService account allowed to modify the data). If the adopt then fails, the
  original permissions of the data folder and its `service` folder are put back, but
  permissions that had been set by hand on single files or subfolders inside it stay
  at the standard policy. Legacy installs already use that policy, and only legacy
  services that run as LocalService are adopted, so the service keeps access to its
  data.
- **Rollback can be unavailable after a successful upgrade.** If the service switched
  to the new version but the version record (`versions.json`) could not be written
  afterwards, the service keeps running the new version and `lda` reports the
  problem, but `lda rollback` has no trusted previous version until the next
  successful upgrade. Old versions are not cleaned up in that case.

## Development

Dependencies are pinned in package-lock.json. `npm test` uses fakes for UAC,
service mutations and external requests. PowerShell tests run only parser and
DryRun paths; loopback fixture servers test HTTP. No tests install services.
See [Releasing](docs/RELEASING.md) and [Contributing](CONTRIBUTING.md).
