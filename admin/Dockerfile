FROM node:20-slim
WORKDIR /app
COPY admin/package.json ./
RUN npm install --omit=dev
COPY admin/server.js ./server.js
COPY admin/public ./public
COPY login/public/easypost-logo.svg login/public/favicon.svg login/public/login-background.png ./public/
CMD ["node", "server.js"]
