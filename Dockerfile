FROM node:20-bookworm

# ============================================================
# SYSTEM PACKAGES (Stripped heavy utilities to prevent OOM)
# ============================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ============================================================
# YT-DLP (Kept purely for lightweight text extraction)
# ============================================================
RUN curl -L \
    https://github.com \
    -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# ============================================================
# ENVIRONMENT
# ============================================================
ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV PORT=3000

# ============================================================
# APP Setup
# ============================================================
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]

