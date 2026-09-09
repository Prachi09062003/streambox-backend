const express = require("express");
const cors = require("cors");
const { spawn, execSync } = require("child_process");

const app = express();

const PORT = process.env.PORT || 3000;
const YTDLP_PATH = process.env.YTDLP_PATH || "yt-dlp";

// Keep yt-dlp and its impersonation tools updated via pip
try {
  console.log("[INIT] Updating yt-dlp and dependencies via pip...");
  execSync(`python3 -m pip install -U --break-system-packages "yt-dlp[default,curl-cffi]"`, { stdio: "inherit" });
} catch (err) {
  console.log("[INIT] Auto-update skipped, using bundled version:", err.message);
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
  })
);

app.use(express.json({ limit: "1mb" }));

// ============================================================
// PLATFORM DETECTION
// ============================================================

function detectPlatform(url) {
  const value = url.toLowerCase();

  if (value.includes("instagram.com") || value.includes("instagr.am")) {
    return "instagram";
  }
  if (value.includes("facebook.com") || value.includes("fb.watch") || value.includes("fb.com")) {
    return "facebook";
  }
  if (value.includes("tiktok.com") || value.includes("vm.tiktok.com")) {
    return "tiktok";
  }
  if (value.includes("pinterest.com") || value.includes("pin.it")) {
    return "pinterest";
  }
  if (value.includes("twitter.com") || value.includes("x.com")) {
    return "twitter";
  }

  return "unknown";
}

// ============================================================
// URL VALIDATION
// ============================================================

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
}

// ============================================================
// SAFE HEADERS
// ============================================================

function getHeaders(format) {
  const result = {};
  const source = format?.http_headers || format?.headers || {};

  if (!source || typeof source !== "object") return result;

  for (const [key, value] of Object.entries(source)) {
    if (value == null) continue;
    const lower = key.toLowerCase();

    if (lower === "cookie") continue;

    if (
      [
        "user-agent", "referer", "origin", "accept", "accept-language",
        "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-ch-ua",
        "sec-ch-ua-mobile", "sec-ch-ua-platform",
      ].includes(lower)
    ) {
      result[key] = String(value);
    }
  }
  return result;
}

// ============================================================
// MEDIA FORMAT HELPERS
// ============================================================

function isHttpMediaUrl(format) {
  if (!format || !format.url) return false;
  const url = String(format.url);
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  const lower = url.toLowerCase();
  if (lower.includes(".m3u8") || lower.includes(".mpd") || lower.includes("m3u8") || lower.includes("dash")) {
    return false;
  }
  return true;
}

function hasVideo(format) {
  return format && format.vcodec && format.vcodec !== "none";
}

function hasAudio(format) {
  return format && format.acodec && format.acodec !== "none";
}

function isMp4(format) {
  const ext = String(format?.ext || "").toLowerCase();
  const container = String(format?.container || "").toLowerCase();
  const url = String(format?.url || "").toLowerCase();
  return ext === "mp4" || container.includes("mp4") || url.includes(".mp4");
}

function heightOf(format) {
  const height = Number(format?.height);
  if (Number.isFinite(height) && height > 0) return height;
  return null;
}

function bitrateOf(format) {
  const values = [format?.tbr, format?.vbr, format?.abr, format?.filesize, format?.filesize_approx];
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

// ============================================================
// FORMAT SORTING & BUILD QUALITIES
// ============================================================

function compareFormats(a, b) {
  const heightA = heightOf(a) || 0;
  const heightB = heightOf(b) || 0;
  if (heightA !== heightB) return heightB - heightA;

  const mp4A = isMp4(a) ? 1 : 0;
  const mp4B = isMp4(b) ? 1 : 0;
  if (mp4A !== mp4B) return mp4B - mp4A;

  return bitrateOf(b) - bitrateOf(a);
}

function pickBest(formats, height) {
  const matching = formats.filter((format) => heightOf(format) === height);
  if (matching.length === 0) return null;
  matching.sort(compareFormats);
  return matching[0];
}

function buildQualities(info, platform) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const directFormats = formats.filter(isHttpMediaUrl);

  const progressiveMp4 = directFormats.filter((f) => hasVideo(f) && hasAudio(f) && isMp4(f));
  const videoOnlyMp4 = directFormats.filter((f) => hasVideo(f) && !hasAudio(f) && isMp4(f));
  const audioFormats = directFormats.filter((f) => !hasVideo(f) && hasAudio(f));

  audioFormats.sort((a, b) => {
    const m4aA = isMp4(a) || String(a?.ext).toLowerCase() === "m4a" ? 1 : 0;
    const m4aB = isMp4(b) || String(b?.ext).toLowerCase() === "m4a" ? 1 : 0;
    if (m4aA !== m4aB) return m4aB - m4aA;
    return bitrateOf(b) - bitrateOf(a);
  });

  const bestAudio = audioFormats.length > 0 ? audioFormats[0] : null;
  const heights = new Set();

  for (const format of progressiveMp4) {
    const h = heightOf(format);
    if (h) heights.add(h);
  }
  for (const format of videoOnlyMp4) {
    const h = heightOf(format);
    if (h) heights.add(h);
  }

  const sortedHeights = Array.from(heights).sort((a, b) => b - a).slice(0, 8);
  const qualities = [];

  for (const height of sortedHeights) {
    const progressive = pickBest(progressiveMp4, height);

    if (progressive) {
      qualities.push({
        id: `progressive-${height}-${progressive.format_id || "mp4"}`,
        label: `${height}p`,
        height,
        width: Number(progressive.width) || null,
        hasVideo: true,
        hasAudio: true,
        needsMerge: false,
        url: progressive.url,
        headers: getHeaders(progressive),
        type: "progressive",
      });
      continue;
    }

    const videoOnly = pickBest(videoOnlyMp4, height);
    if (videoOnly && bestAudio) {
      qualities.push({
        id: `merged-${height}-${videoOnly.format_id || "video"}`,
        label: `${height}p • Video + Audio`,
        height,
        width: Number(videoOnly.width) || null,
        hasVideo: true,
        hasAudio: true,
        needsMerge: true,
        videoUrl: videoOnly.url,
        audioUrl: bestAudio.url,
        videoHeaders: getHeaders(videoOnly),
        audioHeaders: getHeaders(bestAudio),
        type: "separate",
      });
      continue;
    }

    if (videoOnly) {
      qualities.push({
        id: `video-only-${height}-${videoOnly.format_id || "video"}`,
        label: `${height}p • No Audio`,
        height,
        width: Number(videoOnly.width) || null,
        hasVideo: true,
        hasAudio: false,
        needsMerge: false,
        url: videoOnly.url,
        headers: getHeaders(videoOnly),
        audioUnavailable: true,
        type: "video-only",
      });
    }
  }

  if (platform === "pinterest") {
    qualities.sort((a, b) => {
      const aMp4 = a.type === "progressive" || a.type === "video-only";
      const bMp4 = b.type === "progressive" || b.type === "video-only";
      if (aMp4 !== bMp4) return bMp4 ? 1 : -1;
      return (b.height || 0) - (a.height || 0);
    });
  }

  return qualities.slice(0, 8);
}

// ============================================================
// RUN YT-DLP
// ============================================================

function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    const args = [
      "--dump-single-json",
      "--no-warnings",
      "--skip-download",
      "--no-playlist",
      "--no-check-certificates",
      "--no-cache-dir",
      "--geo-bypass",

      // THE FIX: Force browser impersonation utilizing the curl-cffi library we installed
      "--impersonate",
      "chrome",

      "--user-agent",
      USER_AGENT,

      // Stabilizing extractors for specific platforms
      "--extractor-args",
      "instagram:api_hostname=i.instagram.com;facebook:mweb=1;tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com",

      "--socket-timeout",
      "25",
      "--retries",
      "3",

      url,
    ];

    const child = spawn(YTDLP_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
      reject(new Error("Video extraction timed out."));
    }, 60000);

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        const message = stderr.trim() || "yt-dlp extraction failed.";
        reject(new Error(message));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (error) {
        reject(new Error("yt-dlp returned invalid JSON."));
      }
    });
  });
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "StreamBox Backend",
    extraction: "yt-dlp with curl-cffi impersonation",
    status: "online",
  });
});

// ============================================================
// EXTRACTION API
// ============================================================

app.post("/api/extract", async (req, res) => {
  try {
    const url = req.body?.url?.toString().trim();

    if (!url) {
      return res.status(400).json({ success: false, error: "Video URL is required." });
    }
    if (!isValidHttpUrl(url)) {
      return res.status(400).json({ success: false, error: "Please enter a valid HTTP/HTTPS URL." });
    }

    const platform = detectPlatform(url);
    if (platform === "unknown") {
      return res.status(400).json({
        success: false,
        error: "Unsupported or invalid URL. Only Instagram, Facebook, TikTok, Pinterest, and X (Twitter) links are supported.",
      });
    }

    console.log(`[EXTRACT] ${platform}: ${url}`);

    const info = await runYtDlp(url);
    const qualities = buildQualities(info, platform);

    if (!qualities || qualities.length === 0) {
      return res.status(422).json({
        success: false,
        error: "No downloadable MP4 video was found.",
      });
    }

    return res.json({
      success: true,
      platform,
      sourceUrl: url,
      title: info.title?.toString() || "Video",
      thumbnail: info.thumbnail ? info.thumbnail.toString() : null,
      qualities,
    });
  } catch (error) {
    console.error("[EXTRACT ERROR]", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Unable to extract video.",
    });
  }
});

// ============================================================
// 404 & SERVER START
// ============================================================

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Endpoint not found." });
});

app.listen(PORT, () => {
  console.log(`StreamBox backend running on port ${PORT}`);
  console.log(`yt-dlp path: ${YTDLP_PATH}`);
});