# Read-only public demo of DevContinuity (fictional data, every write refused).
#
#   docker build -t devcontinuity-demo .
#   docker run --rm -p 3000:3000 devcontinuity-demo        # http://localhost:3000
#
# The demo workspace is regenerated on every start so its dates stay current. See docs/DEMO.md.
# This image is for the demo only; to use DevContinuity yourself run "npx devcontinuity" on your machine.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV DEVCONTINUITY_DATA_DIR=/tmp/build-data NEXT_TELEMETRY_DISABLED=1
RUN node scripts/setup.mjs && npx next build && npm prune --omit=dev --no-audit --no-fund && rm -rf /tmp/build-data .next/cache

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 demo && mkdir -p /app/demo && chown demo /app/demo
COPY --from=build --chown=demo /app /app
USER demo
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DEVCONTINUITY_DEMO=1 \
    DEVCONTINUITY_PACKAGED=0 \
    DEMO_DIR=/app/demo \
    DEVCONTINUITY_DATA_DIR=/app/demo/data \
    PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["sh", "-c", "node scripts/demo/make-demo.mjs && HOME=/app/demo/home exec node scripts/serve.mjs"]
