# Build stage: install all dependencies and compile TypeScript.
FROM node:22.23.3-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production stage: only runtime dependencies and the compiled code.
FROM node:22.23.3-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS production

LABEL org.opencontainers.image.source=https://github.com/sourcifyeth/sourcify-live-stats
LABEL org.opencontainers.image.licenses=MIT

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist

# The node image ships a non-root "node" user.
USER node
EXPOSE 8080

# Run node directly (not npm start) so that SIGTERM reaches the process.
CMD ["node", "dist/index.js"]
