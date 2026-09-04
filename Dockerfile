FROM node:20-bookworm

# ============================================================
# SYSTEM PACKAGES
# ============================================================

RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# ============================================================
# DENO
# ============================================================

RUN curl -fsSL https://deno.land/install.sh | sh

# ============================================================
# YT-DLP
# ============================================================

RUN curl -L \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# ============================================================
# ENVIRONMENT
# ============================================================

ENV NODE_ENV=production

ENV YTDLP_PATH=/usr/local/bin/yt-dlp

ENV FFMPEG_PATH=/usr/bin/ffmpeg

ENV DENO_INSTALL=/root/.deno

ENV DENO_PATH=/root/.deno/bin/deno

ENV PATH="/root/.deno/bin:/usr/local/bin:/usr/bin:${PATH}"

ENV PORT=3000

ENV MEDIA_TTL_SECONDS=1800

# ============================================================
# APP
# ============================================================

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

# ============================================================
# PORT
# ============================================================

EXPOSE 3000

# ============================================================
# START
# ============================================================

CMD ["node", "server.js"]