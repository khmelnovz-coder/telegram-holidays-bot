FROM node:22-bookworm

WORKDIR /app
COPY package*.json ./
COPY . .
RUN npm install && npm run build

CMD ["npm", "run", "start:scraper"]
