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
// REDIRECT RESOLVER (Bypasses Pinterest 403 / Login Blocks)
// ============================================================

async function unwrapUrl(targetUrl) {
  if (!targetUrl.includes("pin.it") && !targetUrl.includes("vm.tiktok.com")) {
    return targetUrl;
  }
  
  console.log(`[UNWRAP] Unwrapping shortlink: ${targetUrl}`);
  
  try {
    // We use native fetch to securely inject the iPhone User-Agent.
    // redirect: "manual" prevents it from auto-following, allowing us to grab the true URL.
    const response = await fetch(targetUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        console.log(`[UNWRAP] Resolved to: ${location}`);
        return location;
      }
    }
    return targetUrl;
  } catch (e) {
    console.error("[UNWRAP ERROR]", e.message);
    return targetUrl;
  }
}

// ============================================================
// SHARED YT-DLP ARGUMENTS
// ============================================================

function getStandardArgs() {
  return [
    "--geo-bypass",
    "--impersonate", "chrome",
    // We add a fake Referer header to trick Pinterest's hotlink protection
    "--add-header", "Referer: https://www.pinterest.com/",
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

  // Unwrap URL if it's a shortlink to bypass initial bot detection
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

  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
  }, 30000);

  child.on("close", (code) => {
    clearTimeout(timeout);
    
    if (code !== 0) {
      console.error("[EXTRACTION FAILED]", stderr.trim());
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
// API: SERVER PROXY DOWNLOADER
// ============================================================

app.get("/api/proxy", async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl || !isValidHttpUrl(targetUrl)) {
    return res.status(400).send("Valid URL required");
  }

  // Double check shortlinks for the proxy route
  targetUrl = await unwrapUrl(targetUrl);

  const fileName = `streambox_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`;
  const filePath = path.join(os.tmpdir(), fileName);

  console.log(`[PROXY START] Downloading pre-merged MP4 for: ${targetUrl}`);

  // Force pre-combined video+audio file to prevent Instagram/Pinterest merging crashes
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