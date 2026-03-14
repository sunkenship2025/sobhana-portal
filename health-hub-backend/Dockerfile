# ---- Build Stage ----
FROM node:18-slim AS builder

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json* ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies for tsc)
# Skip Puppeteer's bundled Chromium download — we use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# ---- Production Stage ----
FROM node:18-slim

WORKDIR /app

# Install system Chromium and its dependencies for Puppeteer PDF generation
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer where to find system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copy production dependencies
COPY package.json package-lock.json* ./
COPY prisma ./prisma/
RUN npm ci --omit=dev
RUN npx prisma generate

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist/

# Copy public assets (report templates, etc.)
COPY public ./public/

EXPOSE 10000

# Run migrations then start
# CMD uses exec form via sh -c so Node reads Render's PORT env var
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/index.js"]
