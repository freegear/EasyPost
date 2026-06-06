FROM mcr.microsoft.com/playwright:v1.60.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
CMD ["node", "src/server.js"]
