# Linux foreground mode

Requires Node.js 24+, npm, curl and a SHA-256 tool. Service releases are ZIPs:
install `libarchive-tools` (`bsdtar`) first, for example on Debian/Ubuntu:

```sh
sudo apt-get install libarchive-tools
curl -fsSL https://github.com/coding-koala-io/local-developer-accelerator/releases/latest/download/install.sh | sh
lda about
lda run all --accept-notice
```

Graph uses <http://127.0.0.1:8082/>; Assets uses <http://127.0.0.1:8083/>.
Both document `GET /health`, also used by `lda status` for Windows services.
Foreground output contains prefixed service logs. Stop with **Ctrl+C**, or send
`SIGTERM` to the `lda run` process (`kill -TERM <pid>` for a background run).
The CLI waits for both children to exit. `lda stop`, install/upgrade/rollback/
uninstall as services, adopt, tray and Windows approval are **Windows only**.
Foreground data lives under `~/.local/share/Coding Koala/Local Developer Accelerator/run`.
Service status/management commands describe Windows services, not foreground jobs.

To install an unpublished checkout, without downloading a released CLI:

```sh
LDA_INSTALL_SOURCE="$(pwd)" sh install.sh
# Or use an npm-pack-produced .tgz:
LDA_INSTALL_SOURCE=/absolute/path/to/cli.tgz sh install.sh
```

This explicit option trusts local input and skips release lookup and checksums.
Directories are packed before global installation, so the installed CLI does not
depend on the checkout remaining in place. The default installer path still
downloads the latest release and verifies its SHA-256 before installation.
For a user-owned npm prefix, set `npm_config_prefix="$HOME/.npm-global"` and add
`$HOME/.npm-global/bin` to `PATH` before installing. No sudo is needed for the CLI.

The `linux-install-run` and `docker-compose` jobs in `linux-e2e.yml` exercise real
service releases. Linux/Docker execution remains unverified until those jobs pass;
macOS is not covered by these jobs.
