FROM node:22-bookworm

# Install Python, pip, FFmpeg and required system tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install the latest yt-dlp
RUN python3 -m pip install \
    --break-system-packages \
    --no-cache-dir \
    -U yt-dlp

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3000

# ======================================================
# START
# ======================================================

CMD ["node", "server.js"]
