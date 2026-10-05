FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Blocklists are generated artifacts, not committed. Build them into the
# image so the server never has to fetch them at boot. src/server.ts still
# falls back to the network if they are missing.
RUN mkdir -p lists && node scripts/build-blocklists.mjs

RUN npm run build

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
