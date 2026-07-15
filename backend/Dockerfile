FROM node:20-bullseye AS base

# mediasoup builds native bindings; python3 + build-essential are required.
RUN apt-get update && apt-get install -y python3 build-essential && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src

EXPOSE 4000
# mediasoup RTC port range must also be published, e.g.:
# docker run -p 4000:4000 -p 40000-40100:40000-40100/udp ...
CMD ["node", "src/server.js"]
