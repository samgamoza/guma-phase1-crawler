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

CMD ["node", "src/queue/worker.js"]
