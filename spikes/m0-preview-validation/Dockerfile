FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html ./
COPY src ./src
COPY scripts ./scripts
COPY runtime ./runtime
RUN npm run build && mkdir -p /app/evidence && chown -R pwuser:pwuser /app
USER pwuser
ENV HOST=0.0.0.0 PORT=8080 TEST_ENVIRONMENT=docker
EXPOSE 8080
CMD ["node", "runtime/server.mjs"]
