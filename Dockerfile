FROM node:24-bookworm-slim AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS development
COPY . .
EXPOSE 3333
CMD ["node", "ace", "serve", "--hmr", "--poll"]

FROM dependencies AS build
COPY . .
RUN npm run build

FROM base AS production
ENV NODE_ENV=production
COPY --from=build /app/build ./
RUN npm ci --omit=dev && npm cache clean --force
USER node
EXPOSE 3333
CMD ["node", "bin/server.js"]
