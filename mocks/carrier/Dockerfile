FROM node:24-bookworm-slim
WORKDIR /mock
COPY --chown=node:node server.ts ./
USER node
EXPOSE 4001
CMD ["node", "server.ts"]
