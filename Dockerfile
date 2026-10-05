FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
