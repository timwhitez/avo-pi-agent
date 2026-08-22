# syntax=docker/dockerfile:1.7
FROM node:22.19-bookworm-slim AS node-runtime

FROM python:3.12-slim-bookworm
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .npmrc ./
RUN npm install --ignore-scripts --omit=dev
COPY bridge/requirements.txt bridge/requirements.txt
RUN python -m pip install --no-cache-dir -r bridge/requirements.txt
COPY . .
RUN npm run test && npm run security:scan

ENV ARC_PYTHON=python \
    AVO_MEMORY_DIR=/state/memory \
    AVO_WORKSPACE_DIR=/state/workspaces
VOLUME ["/state", "/app/environment_files", "/app/runs"]
ENTRYPOINT ["node", "src/cli.mjs"]
CMD ["run-public", "--all"]
