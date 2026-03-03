FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY *.js ./
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data
USER app
EXPOSE 3456
CMD ["node", "index.js"]
