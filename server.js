const express = require("express");
const cors = require("cors");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

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

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

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

// Bypasses shortlink wrappers automatically
async function unwrapUrl(targetUrl) {
  if (!targetUrl.includes("pin.it") && !targetUrl.includes("vm.tiktok.com")) {
    return targetUrl;
  }
  
  console.log(`[UNWRAP] Resolving shortlink: ${targetUrl}`);
  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, "Accept": "*/*" }
    });
    if (response.url) {
      const cleanUrl = response.url.split('?')[0];
      console.log(`[UNWRAP] Resolved to: ${cleanUrl}`);
      return cleanUrl;
    }
    return targetUrl;
  } catch (e) {
    return targetUrl;
  }
}

function getStandardArgs() {
  return [
    "--geo-bypass",
    "--impersonate", "chrome",
    "--extractor-args", "instagram:api_hostname=i.instagram.com;facebook:mweb=1;tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com",
    "--no-cache-dir",
  ];
}

// Helper to extract unique heights from yt-dlp formats
function getAvailableHeights(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const heights = new Set();
  
  formats.forEach(f => {
    // Only capture formats that have video and a valid height
    if (f.vcodec !== 'none' && typeof f.height === 'number' && f.height > 0) {
      heights.add(f.height);
    }
  });
  
  // Sort descending and take top 5 options
  const sortedHeights = Array.from(heights).sort((a, b) => b - a).slice(0, 5);
  
  // Fallbacks if formatting metadata is missing
  if (sortedHeights.length === 0) {
    if (info.height) return [info.height];
    return [720]; 
  }
  
  return sortedHeights;
}

// ============================================================
// API: EXTRACT 
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

  // Unwrap URL through all redirect layers
  url = await unwrapUrl(url);
  console.log(`[EXTRACT] ${platform}: ${url}`);

  // ============================================================
  // CUSTOM PINTEREST EXTRACTOR
  // ============================================================
  if (platform === "pinterest") {
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      const html = await response.text();
      
      let title = "Pinterest Video";
      const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i) || html.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch) title = titleMatch[1];
      
      let thumbnail = null;
      const thumbMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
      if (thumbMatch) thumbnail = thumbMatch[1];

      let videoUrl = null;
      const pinimgMatch = html.match(/(https:\/\/v\.pinimg\.com\/[^"]+\.mp4[^"]*)/i);
      if (pinimgMatch) {
          videoUrl = pinimgMatch[1].replace(/\\u002F/g, "/");
      } else {
          const ogMatch = html.match(/<meta property="og:video"\s+content="([^"]+)"/i);
          if (ogMatch) videoUrl = ogMatch[1].replace(/\\u002F/g, "/");
      }

      if (videoUrl) {
        console.log(`[PINTEREST SUCCESS] Scraped direct MP4: ${videoUrl}`);
        return res.json({
          success: true,
          platform,
          sourceUrl: url,
          title,
          thumbnail,
          qualities: [
            {
              id: "pinterest-direct-mp4",
              label: "Original Quality • Auto MP4",
              height: 1080,
              hasVideo: true,
              hasAudio: true,
              needsMerge: false,
              url: videoUrl,
              headers: {},
              type: "progressive"
            }
          ]
        });
      } else {
        return res.status(422).json({ success: false, error: "No MP4 video found on this Pinterest page." });
      }
    } catch (e) {
      console.error("[PINTEREST SCRAPE ERROR]", e);
      return res.status(500).json({ success: false, error: "Failed to scrape Pinterest video." });
    }
  }

  // ============================================================
  // YT-DLP FOR INSTAGRAM, TIKTOK, FACEBOOK, X
  // ============================================================
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
      console.error("[EXTRACTION FAILED]", stderr.trim());
      return res.status(500).json({ success: false, error: "Extraction failed or video requires login." });
    }

    try {
      const info = JSON.parse(stdout);
      
      // Determine the available video heights from yt-dlp formats
      const heights = getAvailableHeights(info);
      
      // Map the heights to proxy URLs
      const qualities = heights.map((h) => {
        const proxyUrl = `${req.protocol}://${req.get("host")}/api/proxy?url=${encodeURIComponent(url)}&height=${h}`;
        return {
          id: `server-tunnel-${h}p`,
          label: `${h}p • Auto MP4`,
          height: h,
          hasVideo: true,
          hasAudio: true,
          needsMerge: false,
          url: proxyUrl,
          headers: {},
          type: "progressive"
        };
      });

      return res.json({
        success: true,
        platform,
        sourceUrl: url,
        title: info.title?.toString() || "Video",
        thumbnail: info.thumbnail?.toString() || null,
        qualities: qualities
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: "Invalid JSON from extractor." });
    }
  });
});

// ============================================================
// API: SERVER PROXY DOWNLOADER (With Targeted Heights)
// ============================================================

app.get("/api/proxy", async (req, res) => {
  let targetUrl = req.query.url;
  const targetHeight = req.query.height;

  if (!targetUrl || !isValidHttpUrl(targetUrl)) {
    return res.status(400).send("Valid URL required");
  }

  targetUrl = await unwrapUrl(targetUrl);

  const fileName = `streambox_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
  const filePath = path.join(os.tmpdir(), fileName);

  console.log(`[PROXY START] Processing ${targetHeight ? targetHeight + 'p' : 'Best'} for: ${targetUrl}`);

  // Determine the format filter based on the requested height
  let formatFilter = "bv*+ba/b/best"; // Fallback to absolute best
  if (targetHeight && !isNaN(parseInt(targetHeight))) {
    const h = parseInt(targetHeight);
    // Command yt-dlp to grab the best video less than or equal to the requested height, plus best audio
    formatFilter = `bv*[height<=${h}]+ba/b[height<=${h}]/best`;
  }

  const args = [
    "-f", formatFilter,
    "--merge-output-format", "mp4",
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

app.get("/", (req, res) => res.json({ success: true, status: "online", mode: "Dynamic Proxy Active" }));
app.use((req, res) => res.status(404).json({ success: false, error: "Not found." }));

app.listen(PORT, () => {
  console.log(`StreamBox backend running on port ${PORT}`);
});