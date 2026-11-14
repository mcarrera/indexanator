# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

# backend deps
COPY backend/package.json ./
RUN npm install

# backend source
COPY backend/src ./src

# frontend static files (no build step needed — plain files)
COPY frontend/ ./public/

# Render injects PORT at runtime — the app reads process.env.PORT already
ENV NODE_ENV=production
EXPOSE 3000

CMD ["npx", "tsx", "src/index.ts"]