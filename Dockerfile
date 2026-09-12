FROM node:22-bookworm

WORKDIR /app
COPY package*.json ./
COPY . .
RUN npm install && npm run build
RUN test -f dist/scraper/server.js

CMD ["npm", "run", "start:scraper"]
