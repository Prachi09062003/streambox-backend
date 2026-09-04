FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    ffprobe \
    curl \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install the official yt-dlp Linux executable
RUN curl -L \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Verify tools during Docker build
RUN echo "yt-dlp location:" && \
    command -v yt-dlp && \
    yt-dlp --version && \
    echo "ffmpeg location:" && \
    command -v ffmpeg && \
    ffmpeg -version | head -n 1 && \
    echo "ffprobe location:" && \
    command -v ffprobe && \
    ffprobe -version | head -n 1

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy backend source
COPY . .

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3000

CMD ["node", "server.js"]