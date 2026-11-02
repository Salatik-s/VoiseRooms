FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY --chown=node:node prisma ./prisma
RUN npm ci --no-audit --no-fund && npx prisma generate && mkdir uploads && chown node:node uploads
COPY --chown=node:node src ./src
USER node
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=112 HOST=0.0.0.0 PORT=3000
CMD ["node","src/index.js"]
