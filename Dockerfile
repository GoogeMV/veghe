# better-sqlite3 has no prebuilt binary for every Node/musl combination, so
# it may compile from source; only these two stages carry the toolchain.

# --- production dependencies, compiled once ---
FROM node:24-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- build stage: compile TypeScript ---
FROM node:24-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# --- runtime stage: production deps only ---
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
# Run as the unprivileged user that ships with the node image.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/server.js"]
