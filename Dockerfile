# syntax=docker/dockerfile:1

# qoder-lite has no runtime npm dependencies, so the image only needs Node and
# the application source. Pin to an LTS major for reproducible runtime behavior.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

# Copy only runtime files. QODER_PAT and API_KEY must be injected when the
# container starts — never pass secrets as build arguments or bake them in.
COPY --chown=node:node package.json index.js server.js ./
COPY --chown=node:node src ./src

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

# Run Node directly so SIGINT/SIGTERM reach server.js for graceful shutdown.
CMD ["node", "server.js"]
