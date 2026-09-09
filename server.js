const express = require("express");
const cors = require("cors");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");

const app = express();

const PORT = process.env.PORT || 3000;
const YTDLP_PATH = process.env.YTDLP_PATH || "yt-dlp";

// Automatically update yt-dlp and curl-cffi on boot
try {
  console.log("[INIT] Updating yt-dlp and dependencies via pip...");
  execSync(`python3 -m pip install -U --break-system-packages "yt-dlp[default,curl-cffi]"`, { stdio: "inherit" });
} catch (err) {
  console.log("[INIT] Auto-update skipped, using bundled version:", err.message);
}

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
// PLATFORM DETECTION & REDIRECT RESOLVER
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

// FIX 1: Manually unwrap shortlinks (Pinterest) to prevent 500 crashes
function unwrapUrl(url) {
  return new Promise((resolve) => {
    if (!url.includes("pin.it") && !url.includes("vm.tiktok.com")) {
      return resolve(url);
    }
    
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(res.headers.location);
      } else {
        resolve(url);
      }
    });
    req.on("error", () => resolve(url));
  });
}

// ============================================================
// SHARED YT-DLP ARGUMENTS
// ============================================================

function getStandardArgs() {
  return [
    "--geo-bypass",
    "--impersonate", "chrome",
    "--extractor-args", "instagram:api_hostname=i.instagram.com;facebook:mweb=1;tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com",
    "--no-cache-dir",
  ];
}

// ============================================================
// API: EXTRACT (Generates Tunnel Link)
// ============================================================

app.post("/api/extract", async (req, res) => {
  let url = req.body?.url?.toString().trim();
  
  if (!url || !isValidHttpUrl(url)) {
    return res.status(400).json({ success: false, error: "Please enter a valid HTTP/HTTPS URL." });
  }

  const platform = detectPlatform(url);
  if (platform === "unknown") {
    return res.status(400).json({ success: false, error: "Unsupported URL. Only social platforms are supported." });
  }

  // Unwrap URL if it's a shortlink
  url = await unwrapUrl(url);
  console.log(`[EXTRACT] ${platform}: ${url}`);

  const args = [
    "--dump-single-json", 
    "--skip-download", 
    "--no-playlist", 
    "--quiet",
    ...getStandardArgs(),
    url
  ];

  const child = spawn(YTDLP_PATH, args);

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => stdout += chunk.toString());
  child.stderr.on("data", (chunk) => stderr += chunk.toString());

  const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);

  child.on("close", (code) => {
    clearTimeout(timeout);
    
    if (code !== 0) {
      return res.status(500).json({ success: false, error: "Extraction failed or video requires login." });
    }

    try {
      const info = JSON.parse(stdout);

      // Route the app to our proxy endpoint
      const proxyUrl = `${req.protocol}://${req.get("host")}/api/proxy?url=${encodeURIComponent(url)}`;
      
      const qualities = [
        {
          id: "server-tunnel-mp4",
          label: "Best Quality • MP4 (Optimized)",
          height: 1080,
          hasVideo: true,
          hasAudio: true,
          needsMerge: false,
          url: proxyUrl,
          headers: {},
          type: "progressive"
        }
      ];

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
// API: SERVER PROXY DOWNLOADER (Solves Audio & 500 Errors)
// ============================================================

app.get("/api/proxy", async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl || !isValidHttpUrl(targetUrl)) {
    return res.status(400).send("Valid URL required");
  }

  // Unwrap URL if it's a shortlink
  targetUrl = await unwrapUrl(targetUrl);

  const fileName = `streambox_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
  const filePath = path.join(os.tmpdir(), fileName);

  console.log(`[PROXY START] Downloading pre-merged MP4 for: ${targetUrl}`);

  // FIX 2: -f "b[ext=mp4]/best" forces yt-dlp to grab a pre-combined video+audio file.
  // This bypasses FFmpeg merging entirely, preventing silent Instagram videos and 500 crashes.
  const args = [
    "-f", "b[ext=mp4]/best",
    "-o", filePath,
    "--quiet",
    "--no-warnings",
    ...getStandardArgs(),
    targetUrl
  ];

  const child = spawn(YTDLP_PATH, args);

  child.on("close", (code) => {
    if (code === 0 && fs.existsSync(filePath)) {
      console.log(`[PROXY SUCCESS] Streaming ${fileName} to mobile app`);
      
      // Stream the compiled file directly to the Flutter client
      res.download(filePath, "video.mp4", (err) => {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (cleanupErr) {
          console.error("[CLEANUP ERROR]", cleanupErr);
        }
      });
    } else {
      console.error(`[PROXY FAILED] Exit code: ${code}`);
      if (!res.headersSent) res.status(500).send("Server extraction failed.");
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {}
    }
  });
});

// ============================================================
// SYSTEM
// ============================================================

app.get("/", (req, res) => res.json({ success: true, status: "online", mode: "Pure Tunnel Pre-Merged MP4" }));
app.use((req, res) => res.status(404).json({ success: false, error: "Not found." }));

app.listen(PORT, () => {
  console.log(`StreamBox backend running on port ${PORT}`);
  console.log(`Mode: Pure Tunnel Pre-Merged MP4 via /api/proxy active`);
});