# syntax=docker/dockerfile:1.10

FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package*.json ./
RUN npm install --legacy-peer-deps

FROM deps AS builder
COPY prisma ./prisma
COPY tsconfig.json .
COPY src ./src
COPY README.md ./
RUN npm run prisma:generate && npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY prisma ./prisma
COPY start.sh ./
RUN chmod +x start.sh
ENV PORT=4000
EXPOSE 4000
CMD ["sh", "-c", "echo '=== DOCKERFILE CMD EXECUTING ===' && ./start.sh"]
