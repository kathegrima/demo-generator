FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app
COPY package.json .
RUN npm install
COPY . .

RUN apt-get update && apt-get install -y ffmpeg

EXPOSE 3000
CMD ["node", "index.js"]
