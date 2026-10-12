# pFMS container image.
#
# IMPORTANT: this container must run with the HOST network namespace and
# NET_ADMIN. pFMS manages the host's VLAN interfaces, bridges, iptables rules,
# and routing tables — none of which mean anything inside an isolated network
# namespace. See docs/deployment.md.
#
#   docker run --network host --cap-add NET_ADMIN --cap-add NET_RAW ...
#
# Build:  docker build -t pfms .
FROM oven/bun:1 AS build

WORKDIR /build

# Install dependencies first so a source-only change doesn't refetch them.
COPY package.json bun.lock ./
COPY frontend/package.json frontend/
# lefthook is a git hook manager and has nothing to do in an image build.
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .
RUN bun run build

# ── Runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# The tools checkRequiredTools() insists on, plus audio and the robot tester.
# Without these the backend exits 78 on startup.
RUN apt-get update && apt-get install -y --no-install-recommends \
      iptables \
      iputils-arping \
      fping \
      dnsmasq-base \
      conntrack \
      tcpdump \
      alsa-utils \
      dhcpcd5 \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /build/dist ./dist
# The mdns-socket addon, fetched by `bun run build` (scripts/fetch-mdns-socket.ts).
COPY --from=build /build/native/mdns-socket/prebuilt ./native/mdns-socket/prebuilt
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/frontend/dist ./frontend/dist
# Served to browsers AND played on the field speaker, so they ship in the image.
COPY --from=build /build/sounds ./sounds

# Persisted JSON (setup answers, admin auth, API keys, match history…) is
# written to the working directory — mount a volume here or it dies with the
# container. See docs/deployment.md.
VOLUME ["/app/data"]
WORKDIR /app/data

ENV WEBSOCKET_PORT=9005
EXPOSE 9005

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS "http://127.0.0.1:${WEBSOCKET_PORT}/health" || exit 1

# Run from /app/data so state lands on the volume, but execute the app in /app.
CMD ["node", "/app/dist"]
