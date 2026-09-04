FROM node:22-bookworm

# ==========================================
# System dependencies
# ==========================================

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# ==========================================
# Install official yt-dlp executable
# ==========================================

RUN curl -L \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# ==========================================
# VERIFY INSTALLATION DURING BUILD
# ==========================================

RUN /usr/local/bin/yt-dlp --version && \
    /usr/bin/ffmpeg -version | head -n 1 && \
    test -x /usr/local/bin/yt-dlp

# ==========================================
# Node application
# ==========================================

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

# ==========================================
# Environment
# ==========================================

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3000

CMD ["node", "server.js"]