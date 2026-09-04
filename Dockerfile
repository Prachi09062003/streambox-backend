FROM node:22-bookworm

# ======================================================
# SYSTEM DEPENDENCIES
# ======================================================

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ======================================================
# INSTALL yt-dlp
# ======================================================

RUN python3 -m pip install \
    --break-system-packages \
    --no-cache-dir \
    -U "yt-dlp[default]"

# ======================================================
# VERIFY TOOLS
# ======================================================

RUN command -v yt-dlp && \
    yt-dlp --version && \
    command -v ffmpeg && \
    ffmpeg -version | head -n 1

# ======================================================
# APPLICATION
# ======================================================

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

# ======================================================
# ENVIRONMENT
# ======================================================

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3000

# ======================================================
# START
# ======================================================

CMD ["node", "server.js"]
