FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY tests ./tests
COPY fixtures ./fixtures
COPY deploy ./deploy
RUN mkdir -p /app/artifacts /app/evidence /jobs && chown -R pwuser:pwuser /app /jobs
USER pwuser
ENV XDG_CONFIG_HOME=/tmp/chrome-config XDG_CACHE_HOME=/tmp/chrome-cache SPIKE_ENV=DOCKER
CMD ["node", "src/static-preview/server.mjs"]
