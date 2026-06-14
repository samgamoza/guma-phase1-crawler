FROM node:20-slim

# Playwright system deps
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libgbm1 \
    libasound2 \
    libnss3 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY . .
RUN mkdir -p logs

# Run the HTTP API in the foreground (so Railway sees the port) and the
# BullMQ worker in the background. If the worker exits, the container stays
# up via the API so /health and logs remain reachable for debugging.
CMD ["node", "src/start.js"]
