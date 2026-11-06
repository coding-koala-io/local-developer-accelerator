FROM node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57 AS package
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY bin ./bin
COPY src ./src
COPY elevated ./elevated
COPY tray ./tray
COPY docs ./docs
COPY *.md NOTICE ./

FROM node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57
# GNU tar cannot read the ZIP releases; bsdtar preserves the archive safety checks.
# The base image is pinned by digest. Debian removes superseded package versions
# from its archive, so exact apt pins break on the next security update; the
# installed versions are printed in the build log instead.
RUN apt-get update && apt-get install -y --no-install-recommends libarchive-tools ca-certificates \
    && dpkg-query -W -f='installed ${Package} ${Version}\n' libarchive-tools libarchive13 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=package /build/ /opt/lda/app/
RUN chmod 755 /opt/lda/app/bin/lda.js \
    && ln -s /opt/lda/app/bin/lda.js /usr/local/bin/lda \
    && ln -s /opt/lda/app/bin/lda.js /usr/local/bin/accelerator \
    && mkdir -p /home/node/.local/share && chown -R node:node /home/node/.local
COPY --chown=node:node docker /opt/lda/docker
USER node
WORKDIR /home/node
EXPOSE 8082 8083
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=4s --start-period=120s --retries=3 \
    CMD ["node", "/opt/lda/docker/healthcheck.js"]
ENTRYPOINT ["node", "/opt/lda/docker/entrypoint.js"]
CMD ["run", "all"]
