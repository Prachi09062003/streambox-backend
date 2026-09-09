const express = require("express");
const cors = require("cors");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();

const PORT = process.env.PORT || 3000;
const YTDLP_PATH = process.env.YTDLP_PATH || "yt-dlp";

// Keep yt-dlp updated on boot
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
  if (value.includes("instagram.com") || value.includes("instagr.am")) return "instagram";
  if (value.includes("facebook.com") || value.includes("fb.watch") || value.includes("fb.com")) return "facebook";
  if (value.includes("tiktok.com") || value.includes("vm.tiktok.com")) return "tiktok";
  if (value.includes("pinterest.com") || value.includes("pin.it")) return "pinterest";
  if (value.includes("twitter.com") || value.includes("x.com")) return "twitter";
  return "unknown";
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
}

// ============================================================
// SAFE HEADERS & HELPERS
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
      ["user-agent", "referer", "origin", "accept", "accept-language",
       "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-ch-ua",
       "sec-ch-ua-mobile", "sec-ch-ua-platform"].includes(lower)
    ) {
      result[key] = String(value);
    }
  }
  return result;
}

function isHttpMediaUrl(format) {
  if (!format || !format.url) return false;
  const url = String(format.url);
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  const lower = url.toLowerCase();
  if (lower.includes(".m3u8") || lower.includes(".mpd") || lower.includes("dash")) return false;
  return true;
}

function hasVideo(format) { return format && format.vcodec && format.vcodec !== "none"; }
function hasAudio(format) { return format && format.acodec && format.acodec !== "none"; }
function isMp4(format) {
  const ext = String(format?.ext || "").toLowerCase();
  const container = String(format?.container || "").toLowerCase();
  const url = String(format?.url || "").toLowerCase();
  return ext === "mp4" || container.includes("mp4") || url.includes(".mp4");
}
function heightOf(format) {
  const h = Number(format?.height);
  return Number.isFinite(h) && h > 0 ? h : null;
}
function bitrateOf(format) {
  const values = [format?.tbr, format?.vbr, format?.abr, format?.filesize];
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

// ============================================================
// BUILD CDN QUALITIES
// ============================================================

function buildQualities(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const directFormats = formats.filter(isHttpMediaUrl);

  const progressiveMp4 = directFormats.filter(f => hasVideo(f) && hasAudio(f) && isMp4(f));
  const videoOnlyMp4 = directFormats.filter(f => hasVideo(f) && !hasAudio(f) && isMp4(f));
  const audioFormats = directFormats.filter(f => !hasVideo(f) && hasAudio(f));
  
  const bestAudio = audioFormats.sort((a, b) => bitrateOf(b) - bitrateOf(a))[0] || null;
  const heights = new Set([...progressiveMp4.map(heightOf), ...videoOnlyMp4.map(heightOf)].filter(Boolean));
  const sortedHeights = Array.from(heights).sort((a, b) => b - a).slice(0, 5);

  const qualities = [];
  for (const height of sortedHeights) {
    const progressive = progressiveMp4.find(f => heightOf(f) === height);
    if (progressive) {
      qualities.push({
        id: `progressive-${height}`, label: `${height}p Direct`, height,
        hasVideo: true, hasAudio: true, needsMerge: false, url: progressive.url,
        headers: getHeaders(progressive), type: "progressive"
      });
      continue;
    }
    const videoOnly = videoOnlyMp4.find(f => heightOf(f) === height);
    if (videoOnly && bestAudio) {
      qualities.push({
        id: `merged-${height}`, label: `${height}p • Video + Audio`, height,
        hasVideo: true, hasAudio: true, needsMerge: true, videoUrl: videoOnly.url,
        audioUrl: bestAudio.url, videoHeaders: getHeaders(videoOnly), audioHeaders: getHeaders(bestAudio),
        type: "separate"
      });
    }
  }
  return qualities;
}

// ============================================================
// CORE EXTRACTION COMMAND
// ============================================================

function getStandardArgs(url) {
  return [
    "--no-warnings", "--geo-bypass",
    "--impersonate", "chrome",
    "--extractor-args", "instagram:api_hostname=i.instagram.com;facebook:mweb=1;tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com",
    url
  ];
}

// ============================================================
// API: EXTRACT METADATA
// ============================================================

app.post("/api/extract", (req, res) => {
  const url = req.body?.url?.toString().trim();
  if (!url || !isValidHttpUrl(url)) {
    return res.status(400).json({ success: false, error: "Please enter a valid HTTP/HTTPS URL." });
  }

  const platform = detectPlatform(url);
  if (platform === "unknown") {
    return res.status(400).json({ success: false, error: "Unsupported URL." });
  }

  console.log(`[EXTRACT] ${platform}: ${url}`);

  const args = ["--dump-single-json", "--skip-download", "--no-playlist", ...getStandardArgs(url)];
  const child = spawn(YTDLP_PATH, args);

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => stdout += chunk.toString());
  child.stderr.on("data", (chunk) => stderr += chunk.toString());

  const timeout = setTimeout(() => child.kill("SIGKILL"), 60000);

  child.on("close", (code) => {
    clearTimeout(timeout);
    if (code !== 0) return res.status(500).json({ success: false, error: stderr.trim() || "Extraction failed." });

    try {
      const info = JSON.parse(stdout);
      const qualities = buildQualities(info);

      // THE FIX: Inject a Server-Converted MP4 at the top of the qualities list. 
      // This routes the Flutter app to hit our /api/convert endpoint where FFmpeg does the heavy lifting.
      const proxyUrl = `${req.protocol}://${req.get("host")}/api/convert?url=${encodeURIComponent(url)}`;
      
      qualities.unshift({
        id: "server-processed-mp4",
        label: "Best Quality • Auto MP4 (Recommended)",
        height: 1080, 
        hasVideo: true,
        hasAudio: true,
        needsMerge: false,
        url: proxyUrl,
        headers: {},
        type: "progressive"
      });

      return res.json({
        success: true,
        platform,
        sourceUrl: url,
        title: info.title?.toString() || "Video",
        thumbnail: info.thumbnail?.toString() || null,
        qualities,
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: "Invalid JSON from extractor." });
    }
  });
});

// ============================================================
// API: SERVER DOWNLOAD & CONVERT TO MP4
// ============================================================

app.get("/api/convert", (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || !isValidHttpUrl(targetUrl)) return res.status(400).send("Valid URL required");

  const fileName = `streambox_${Date.now()}.mp4`;
  const filePath = path.join(os.tmpdir(), fileName);

  console.log(`[CONVERT] Stitching & formatting MP4 for: ${targetUrl}`);

  // Instructs yt-dlp to download the best streams and use FFmpeg to package them into an MP4
  const args = [
    "-f", "b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/b",
    "--merge-output-format", "mp4",
    "-o", filePath,
    ...getStandardArgs(targetUrl)
  ];

  const child = spawn(YTDLP_PATH, args);

  child.on("close", (code) => {
    if (code === 0 && fs.existsSync(filePath)) {
      console.log(`[CONVERT SUCCESS] Streaming ${fileName} to client`);
      // Stream the compiled MP4 directly to the Flutter app
      res.download(filePath, fileName, () => {
        // Cleanup ephemeral storage after streaming
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      });
    } else {
      console.error(`[CONVERT FAILED] Exit code: ${code}`);
      if (!res.headersSent) res.status(500).send("Server conversion failed");
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  });
});

// ============================================================
// SYSTEM
// ============================================================

app.get("/", (req, res) => res.json({ success: true, status: "online", features: "Server-side MP4 conversion active" }));
app.use((req, res) => res.status(404).json({ success: false, error: "Not found." }));

app.listen(PORT, () => {
  console.log(`StreamBox backend running on port ${PORT}`);
  console.log(`yt-dlp path: ${YTDLP_PATH}`);
});