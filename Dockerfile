FROM node:22-bookworm

# Install Python, pip, FFmpeg and required system tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
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

# Copy package files first for better Docker caching
COPY package*.json ./

# Install Node dependencies
RUN npm install --omit=dev

# Copy backend source
COPY . .

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]