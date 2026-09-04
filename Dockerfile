FROM node:22-bookworm

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    python3 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl --fail --location --retry 5 \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    --output /usr/local/bin/yt-dlp && \
    chmod 755 /usr/local/bin/yt-dlp

# Install Deno for YouTube JavaScript extraction
RUN curl -fsSL https://deno.land/install.sh | sh

ENV DENO_INSTALL=/root/.deno
ENV PATH="/root/.deno/bin:${PATH}"

# Verify required tools
RUN echo "Checking yt-dlp..." && \
    /usr/local/bin/yt-dlp --version && \
    echo "Checking ffmpeg..." && \
    /usr/bin/ffmpeg -version | head -n 1 && \
    echo "Checking ffprobe..." && \
    /usr/bin/ffprobe -version | head -n 1 && \
    echo "Checking deno..." && \
    /root/.deno/bin/deno --version

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV DENO_PATH=/root/.deno/bin/deno
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]