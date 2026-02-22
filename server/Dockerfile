FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY src ./src

ENV PORT=3001
EXPOSE 3001

CMD ["node", "src/index.js"]
