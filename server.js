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
// DIRECT OPENGRAPH SCRAPER (Bypasses Pinterest 404 & Instagram Blocks)
// ============================================================
async function fetchDirectMediaMeta(targetUrl, platformName) {
  try {
    let fetchUrl = targetUrl;
    if (targetUrl.includes("pin.it") || targetUrl.includes("fb.watch")) {
      const initialRes = await new Promise((resolve) => {
        const client = targetUrl.startsWith("https") ? https : http;
        client.request(targetUrl, { method: "HEAD", headers: { "User-Agent": USER_AGENT } }, (res) => {
          resolve(res.headers.location ? new URL(res.headers.location, targetUrl).href : targetUrl);
        }).on("error", () => resolve(targetUrl)).end();
      });
      fetchUrl = initialRes;
    }

    const response = await fetch(fetchUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": `https://www.${platformName}.com/`,
      },
    });
    if (!response.ok) return null;

    const html = await response.text();
    const videoMatch = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/i) || 
                       html.match(/<meta\s+property="og:video:secure_url"\s+content="([^"]+)"/i) ||
                       html.match(/"video_url"\s*:\s*"([^"]+)"/i);
                       
    if (videoMatch && videoMatch[1]) {
      return videoMatch[1].replace(/&amp;/g, "&").replace(/u0026/g, "&").replace(/\\/g, "");
    }
    return null;
  } catch (error) {
    console.error(`[${platformName.toUpperCase()} SCRAPER ERROR]`, error?.message || error);
    return null;
  }
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

  ffmpegProcess.on("close", () => {
    res.end();
  });

  req.on("close", () => {
    try { ffmpegProcess.kill("SIGKILL"); } catch (_) {}
  });
});

// ============================================================
// EXTRACT ENDPOINT
// ============================================================
app.post("/api/extract", async (req, res) => {
  try {
    const inputUrl = cleanInputUrl(req.body?.url);
    if (!inputUrl || !isValidHttpUrl(inputUrl)) {
      return res.status(400).json({ success: false, error: "Please provide a valid video URL." });
    }

    const platform = getPlatform(inputUrl);

    // Step 1: For Pinterest and Instagram, bypass cloud IP blocks instantly using Direct Scraper
    if (platform === "pinterest" || platform === "instagram") {
      const directUrl = await fetchDirectMediaMeta(inputUrl, platform);
      if (directUrl) {
        return res.json({
          success: true,
          platform,
          title: `${platform.charAt(0).toUpperCase() + platform.slice(1)} Video`,
          thumbnail: null,
          qualities: [{
            id: directUrl,
            label: "HD Quality (With Audio)",
            hasAudio: true,
            previewUrl: directUrl,
          }],
        });
      }
    }

    // Step 2: Fallback to yt-dlp for other platforms
    const args = [
      "--ignore-config",
      "--no-playlist",
      "--no-warnings",
      "--dump-single-json",
      "--skip-download",
      "--geo-bypass",
      "--user-agent", USER_AGENT,
      inputUrl,
    ];

    if (platform === "instagram" && fs.existsSync(COOKIES_PATH)) {
      args.push("--cookies", COOKIES_PATH);
    }

    const stdout = await runCommand(YTDLP_PATH, args);
    const metadata = JSON.parse(stdout.trim());
    
    let qualities = [];

    if (metadata.url) {
      const isStream = metadata.url.includes(".m3u8") || metadata.url.includes(".mpd");
      let downloadUrl = metadata.url;

      if (isStream) {
        downloadUrl = `${req.protocol}://${req.get("host")}/api/download-proxy?url=${encodeURIComponent(metadata.url)}`;
      }

      qualities.push({
        id: downloadUrl,
        label: metadata.height ? `${metadata.height}p (HD)` : "Best Available Quality",
        height: metadata.height || null,
        width: metadata.width || null,
        hasAudio: true,
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
            hasAudio: hasAudio,
            previewUrl: fmt.url,
          });
        }
      }
    }

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