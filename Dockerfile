FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the rest of the source.
COPY src ./src
COPY package.json ./

# Ensure data directories exist
RUN mkdir -p /var/data /var/data/processed

EXPOSE 8080

CMD ["node", "src/index.js"]