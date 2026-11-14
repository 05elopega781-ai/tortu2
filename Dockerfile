FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY server/ ./server/
COPY public/ ./public/
COPY v21_voz_saludos_backend.html ./

RUN mkdir -p /app/data && chown node:node /app/data
USER node

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "server.js"]
