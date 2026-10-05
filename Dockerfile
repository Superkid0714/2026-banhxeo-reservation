FROM node:22-bookworm-slim

WORKDIR /app

# Copy only the runtime files; local reservations and credentials stay outside.
COPY package.json server.mjs aligo.mjs solapi.mjs sendon.mjs ./
COPY public/ ./public/

RUN npm run check

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DATA_DIR=/data

# Railway supplies PORT. The Node process receives SIGTERM directly.
CMD ["node", "server.mjs"]
