# One command instead of four.
#
# Self-hosting used to mean: install Go, build wacli with exactly the right
# build tag, install Node, clone this, wire it together. The build tag alone
# is the mistake people make most often — without `sqlite_fts5` the store
# migration fails and full-text search is simply gone. Baking it in here means
# nobody can get it wrong.

# ---------------------------------------------------------------- wacli ---
FROM golang:1.24-bookworm AS wacli

# Pinned on purpose: the gateway is tested against this CLI version, and a
# surprise upgrade during an image build is the kind of thing that breaks at
# 3am rather than in review.
ARG WACLI_VERSION=v0.18.2

# The official Go image pins GOTOOLCHAIN=local, which refuses to fetch the
# newer toolchain wacli's go.mod asks for. Debian's Go fetches it silently,
# so this only shows up inside a container — which is why it is set here.
ENV GOTOOLCHAIN=auto

RUN git clone --depth 1 --branch ${WACLI_VERSION} https://github.com/openclaw/wacli /src
WORKDIR /src

# CGO is required for the SQLite driver, and sqlite_fts5 is what makes search
# work at all. Go fetches the toolchain go.mod asks for by itself.
RUN CGO_ENABLED=1 go build -tags sqlite_fts5 -ldflags="-s -w" -o /out/wacli ./cmd/wacli \
 && /out/wacli --version

# -------------------------------------------------------------- gateway ---
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=wacli /out/wacli /app/bin/wacli

COPY server/package.json server/
RUN cd server && npm install --omit=dev --no-audit --no-fund

COPY server/ server/

# The site is generated, not committed — building it here means the image is
# reproducible from the repository alone. The builder uses only Node's own
# modules, so there is nothing to install for it.
COPY site/ site/
COPY scripts/build.mjs scripts/
RUN node scripts/build.mjs && test -f web/index.html

# Stores hold the message history, config holds tenants and the imprint.
# Both must outlive the container — mount them or lose every linked account.
VOLUME ["/app/stores", "/app/config"]

ENV PORT=8787 \
    HOST=0.0.0.0 \
    WACLI_BIN=/app/bin/wacli
# HOST is 0.0.0.0 here because the container boundary is the boundary now.
# Do not publish this port straight to the internet: put a TLS terminator or a
# tunnel in front, exactly as the hosted deployment does.

# WACLI_DEVICE_LABEL decides what your users see under "Linked devices" in
# WhatsApp. Left unset, wacli builds one from the host name, and a container id
# ends up on someone's phone. Override it with your own domain.
ENV WACLI_DEVICE_LABEL=wacli \
    WACLI_DEVICE_PLATFORM=DESKTOP

EXPOSE 8787

# Not root: the store is a person's entire message history.
RUN useradd --system --create-home --uid 10001 wacli \
 && mkdir -p /app/stores /app/config /app/logs \
 && chown -R wacli:wacli /app
USER wacli

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.mjs"]
