FROM node:20-slim
WORKDIR /app

# Playwright Chromium system dependencies + Korean fonts
RUN apt-get update && apt-get install -y \
    ca-certificates wget gnupg \
    fonts-nanum fonts-noto-cjk \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
    libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 \
    libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 \
    libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
    libxi6 libxkbcommon0 libxrandr2 libxrender1 libxss1 libxtst6 xdg-utils \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# Download Playwright Chromium browser
RUN npx playwright install chromium

COPY . .
CMD ["node", "server.js"]
