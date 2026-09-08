const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const YTDLP_PATH = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const COOKIES_PATH = path.join(__dirname, "instagram_cookies.txt");

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function cleanInputUrl(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^<|>$/g, "");
}

function getPlatform(url) {
  const value = url.toLowerCase();
  if (value.includes("instagram.com") || value.includes("instagr.am")) return "instagram";
  if (value.includes("pinterest.com") || value.includes("pin.it")) return "pinterest";
  if (value.includes("tiktok.com") || value.includes("://tiktok.com")) return "tiktok";
  if (value.includes("facebook.com") || value.includes("fb.watch")) return "facebook";
  if (value.includes("twitter.com") || value.includes("x.com")) return "twitter";
  return "generic";
}

// ============================================================
// REDIRECT RESOLVER ENGINE (Fixes pin.it Shortened Links)
// ============================================================
function expandShortenedUrl(targetUrl) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(targetUrl);
      const client = urlObj.protocol === "https:" ? https : http;

      client.request(targetUrl, { 
        method: "HEAD", 
        headers: { "User-Agent": USER_AGENT } 
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const resolvedUrl = new URL(res.headers.location, targetUrl).href;
          resolve(resolvedUrl);
        } else {
          resolve(targetUrl);
        }
      }).on("error", () => resolve(targetUrl)).end();
    } catch (_) {
      resolve(targetUrl);
    }
  });
}

// ============================================================
// STATIC API PROXY GATEWAY (Optional Fallback Wrapper)
// ============================================================
async function fetchViaPublicApi(targetUrl) {
  try {
    const apiRes = await fetch(`https://tikwm.com{encodeURIComponent(targetUrl)}`, {
      headers: { "User-Agent": USER_AGENT },
    });
    const json = await apiRes.json();
    if (json && json.code === 0 && json.data && json.data.play) {
      return {
        url: json.data.play,
        title: json.data.title || "Social Media Video",
        thumbnail: json.data.cover || null,
      };
    }
  } catch (e) {
    console.error("[PUBLIC API FALLBACK ERROR]", e.message);
  }
  return null;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => (stdout += data.toString()));
    child.stderr.on("data", (data) => (stderr += data.toString()));

    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `Command failed with code ${code}`));
    });
  });
}

// ============================================================
// LIVE STREAM CONVERSION PROXY (M3U8 -> MP4 Transcoder Engine)
// ============================================================
app.get("/api/download-proxy", (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl || !isValidHttpUrl(streamUrl)) {
    return res.status(400).json({ success: false, error: "Missing or invalid streaming target link." });
  }

  res.setHeader("Content-Disposition", `attachment; filename="StreamBox_Muxed_${Date.now()}.mp4"`);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Transfer-Encoding", "chunked");

  const ffmpegProcess = spawn("ffmpeg", [
    "-i", streamUrl,
    "-c:v", "copy",
    "-c:a", "aac",
    "-bsf:a", "aac_adtstoasc",
    "-movflags", "frag_keyframe+empty_moov",
    "-f", "mp4",
    "pipe:1"
  ], { windowsHide: true });

  ffmpegProcess.stdout.pipe(res);

  ffmpegProcess.on("close", (code) => {
    res.end();
  });

  req.on("close", () => {
    try { ffmpegProcess.kill("SIGKILL"); } catch (_) {}
  });
});

// ============================================================
// CORE EXTRACTION APIS WITH FIXED MULTI-STREAM PIPELINES
// ============================================================
app.post("/api/extract", async (req, res) => {
  try {
    let inputUrl = cleanInputUrl(req.body?.url);
    if (!inputUrl || !isValidHttpUrl(inputUrl)) {
      return res.status(400).json({ success: false, error: "Please provide a valid video URL." });
    }

    // Fix Pinterest Step 1: Force resolution of shortened pin.it URLs
    if (inputUrl.includes("pin.it")) {
      inputUrl = await expandShortenedUrl(inputUrl);
    }

    const platform = getPlatform(inputUrl);

    const args = [
      "--ignore-config",
      "--no-playlist",
      "--no-warnings",
      "--dump-single-json",
      "--skip-download",
      "--geo-bypass",
      // Fix Instagram Audio Step 1: Force yt-dlp to request highest combined format or explicit mux structures
      "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--user-agent", USER_AGENT,
      inputUrl,
    ];

    // Fix Instagram Audio Step 2: Inject authenticated session cookie tracking parameter structures if file is present
    if (platform === "instagram" && fs.existsSync(COOKIES_PATH)) {
      args.push("--cookies", COOKIES_PATH);
    }

    let metadata;
    try {
      const stdout = await runCommand(YTDLP_PATH, args);
      metadata = JSON.parse(stdout.trim());
    } catch (err) {
      // Direct Fallback Gateway execution if yt-dlp layer meets scraper blocks
      const fallbackData = await fetchViaPublicApi(inputUrl);
      if (fallbackData && fallbackData.url) {
        return res.json({
          success: true,
          platform,
          title: fallbackData.title,
          thumbnail: fallbackData.thumbnail,
          qualities: [{
            id: fallbackData.url,
            label: "HD Quality (Muxed With Audio)",
            hasAudio: true,
            previewUrl: fallbackData.url,
          }],
        });
      }
      throw err;
    }
    
    let qualities = [];

    if (metadata.url) {
      const isStream = metadata.url.includes(".m3u8") || metadata.url.includes(".mpd");
      let downloadUrl = metadata.url;

      // Fix Pinterest Step 2: Automatically convert streaming playlists using our proxy endpoint
      if (isStream) {
        downloadUrl = `${req.protocol}://${req.get("host")}/api/download-proxy?url=${encodeURIComponent(metadata.url)}`;
      }

      qualities.push({
        id: downloadUrl,
        label: metadata.height ? `${metadata.height}p (HD)` : "Best Available Quality",
        height: metadata.height || null,
        width: metadata.width || null,
        hasAudio: isStream ? true : (metadata.acodec && metadata.acodec !== 'none'),
        previewUrl: metadata.url,
      });
    }

    if (metadata.formats && Array.isArray(metadata.formats)) {
      const validFormats = metadata.formats.filter(f => f.url);
      for (const fmt of validFormats) {
        const isStream = fmt.url.includes(".m3u8") || fmt.url.includes(".mpd");
        let downloadUrl = fmt.url;

        if (isStream) {
          downloadUrl = `${req.protocol}://${req.get("host")}/api/download-proxy?url=${encodeURIComponent(fmt.url)}`;
        }

        const hasVideo = fmt.vcodec && fmt.vcodec !== 'none';
        const hasAudio = fmt.acodec && fmt.acodec !== 'none';

        if (hasVideo) {
          qualities.push({
            id: downloadUrl,
            label: fmt.height ? `${fmt.height}p` : (fmt.format_note || 'Standard Quality'),
            height: fmt.height || null,
            width: fmt.width || null,
            hasAudio: isStream ? true : (hasAudio || fmt.acodec !== undefined),
            previewUrl: fmt.url,
          });
        }
      }
    }

    // Sort: Bubbles formats containing confirmed audio tracks up to the top
    qualities.sort((a, b) => {
      if (a.hasAudio !== b.hasAudio) return b.hasAudio ? -1 : 1;
      return (b.height || 0) - (a.height || 0);
    });

    const uniqueQualities = Array.from(new Map(qualities.map(q => [q.label, q])).values());

    if (uniqueQualities.length === 0) {
      throw new Error("Could not extract playable stream URLs for this link.");
    }

    return res.json({
      success: true,
      platform,
      title: metadata.title || "StreamBox Video",
      thumbnail: metadata.thumbnail || null,
      qualities: uniqueQualities,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message?.length > 200 ? "Unable to extract video link." : error.message,
    });
  }
});

app.get("/", (req, res) => res.json({ success: true, service: "StreamBox Extraction Backend", status: "online" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`STREAMBOX EXTRACT API running on port ${PORT}`);
});
