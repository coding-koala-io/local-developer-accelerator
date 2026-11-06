# Docker

Development and research only; keep this on your own computer. Not affiliated
with or endorsed by Optimizely. Read `LEGAL-NOTICE.md` (or `lda about`) first:
Compose sets `LDA_ACCEPT_NOTICE=1` to accept that notice for automation.

1. From this repository, with Docker and Compose installed, run:

   ```sh
   docker compose up
   ```

2. Open Graph at <http://localhost:8082/> and Assets at <http://localhost:8083/>.
   Initial startup downloads and verifies the service releases from GitHub.
   Both services must answer `/health`; Compose reports the image healthcheck.

3. For a CMS 13 site running on this host, open the Graph tenant and copy its
   **Connect** settings into `appsettings.Development.json`, with
   `Optimizely:ContentGraph:GatewayAddress` set to `http://localhost:8082`.
   In Assets, connect the instance to Graph and synchronize the assets; copy its
   **Connect** snippet into the same file. Set
   `Optimizely:Cms:DamUI:Endpoint` to `http://localhost:8083` (no trailing slash).
   Register `services.AddContentGraph().AddDamUI().AddGraphContentSources()` as
   described by the services, restart the CMS, and run Graph full synchronization.
   The generated tenant keys belong in your local development settings, never Git.

4. Stop with Ctrl+C or `docker compose down`. The one named volume `lda-data`
   retains configuration, cached releases, tenant settings, content and logs.
   To **delete that data**, run `docker compose down -v`.

The image uses Node 24 and runs as the unprivileged `node` user. Only host
`127.0.0.1:8082` and `127.0.0.1:8083` are published. An image-only TCP relay on
the container interface forwards to the services' private loopback listeners;
normal `lda run` keeps its loopback binding. No admin credentials are baked into
the image, and no telemetry is added. Downloads are the CLI's npm dependencies
at build time and its usual verified GitHub service releases on first run.
The image needs the default bridge network; do not use host networking or publish
additional interfaces. A CMS in another container is outside this host-only setup.

Docker Compose startup was proven in CI on Ubuntu by the "Linux and Docker end
to end" workflow, including service health and host LAN isolation checks.
Connecting a real CMS 13 site to this Docker setup is not verified yet.
