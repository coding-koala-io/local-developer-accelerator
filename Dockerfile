FROM node:24-bookworm-slim AS package
WORKDIR /build
COPY package.json package-lock.json ./
COPY bin ./bin
COPY src ./src
COPY elevated ./elevated
COPY tray ./tray
COPY docs ./docs
COPY *.md NOTICE ./
RUN mkdir /package && npm pack --ignore-scripts --pack-destination /package

FROM node:24-bookworm-slim
# GNU tar cannot read the ZIP releases; bsdtar preserves the archive safety checks.
RUN apt-get update && apt-get install -y --no-install-recommends libarchive-tools ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=package /package/ /tmp/package/
COPY install.sh /tmp/install.sh
RUN LDA_INSTALL_SOURCE="$(find /tmp/package -name '*.tgz')" sh /tmp/install.sh \
    && rm -rf /tmp/package /tmp/install.sh /root/.npm \
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
