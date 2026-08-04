FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY bridge.js server.js ./
COPY www ./www

CMD ["node", "bridge.js"]
