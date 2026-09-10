FROM node:22.13-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.13-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# argon2 needs no runtime toolchain, but the sqlite data dir must be writable
# by the unprivileged user the process runs as.
RUN mkdir -p /data && chown -R node:node /data

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node
ENV DATABASE_PATH=/data/portal.db
EXPOSE 8080

# The container is unhealthy until the schema is open and the routers are
# reachable enough to answer a readiness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
