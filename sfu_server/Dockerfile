FROM node:18-bullseye
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
ENV PORT=4000
EXPOSE 4000/udp 4000/tcp
# RTC порты будут указаны в env и открыты host-сетью
CMD ["node", "server.js"]

