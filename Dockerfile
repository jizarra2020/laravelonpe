FROM ghcr.io/puppeteer/puppeteer:22.12.1

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 10000

CMD [ "node", "index.js" ]
