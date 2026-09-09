FROM node:20-bookworm

# Install system dependencies including Python, pip, and FFmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Crucial Fix: Install yt-dlp via pip with curl-cffi for browser impersonation
# (--break-system-packages is required and completely safe inside a Docker container)
RUN python3 -m pip install --no-cache-dir --break-system-packages "yt-dlp[default,curl-cffi]"

ENV NODE_ENV=production
# yt-dlp is now globally installed in the system PATH
ENV YTDLP_PATH=yt-dlp
ENV PORT=3000

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]