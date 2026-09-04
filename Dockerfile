FROM node:22-bookworm

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

RUN echo "Checking yt-dlp..." && \
    /usr/local/bin/yt-dlp --version && \
    echo "Checking ffmpeg..." && \
    /usr/bin/ffmpeg -version | head -n 1 && \
    echo "Checking ffprobe..." && \
    /usr/bin/ffprobe -version | head -n 1

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]