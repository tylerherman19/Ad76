FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# shared/ is NOT optional: src/ imports it (src/geo/wards.js -> shared/wardIndex.js,
# src/normalize.js -> shared/normalize.js, ...) and the server also serves it to the
# browser at /shared. Omitting it makes the container exit immediately with
# ERR_MODULE_NOT_FOUND.
COPY src ./src
COPY shared ./shared
COPY public ./public
COPY config ./config
COPY scripts ./scripts
COPY data ./data

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
