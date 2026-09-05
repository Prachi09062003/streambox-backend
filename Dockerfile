FROM node:20-bookworm

# ============================================================
# SYSTEM PACKAGES
# ============================================================

RUN apt-get update && apt-get install -y --no-install-recommends \
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
# VERIFY TOOLS DURING BUILD
# ============================================================

RUN /usr/local/bin/yt-dlp --version \
    && /usr/bin/ffmpeg -version \
    && /usr/bin/ffprobe -version \
    && /root/.deno/bin/deno --version

# ============================================================
# ENVIRONMENT
# ============================================================

ENV NODE_ENV=production

ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV DENO_INSTALL=/root/.deno
ENV DENO_PATH=/root/.deno/bin/deno

ENV PATH="/root/.deno/bin:/usr/local/bin:/usr/bin:${PATH}"

ENV MEDIA_TTL_SECONDS=1800

# Do not depend on this value in Render.
# Render automatically provides its own PORT value.
ENV PORT=3000

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