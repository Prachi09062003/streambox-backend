const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const YTDLP_PATH = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ============================================================
// HELPERS & VALIDATORS
// ============================================================
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
  if (value.includes("tiktok.com") || value.includes("://tiktok.com") || value.includes("://tiktok.com")) return "tiktok";
  if (value.includes("facebook.com") || value.includes("fb.watch")) return "facebook";
  if (value.includes("pinterest.com") || value.includes("pin.it")) return "pinterest";
  if (value.includes("twitter.com") || value.includes("x.com")) return "twitter";
  return "generic";
}

// ============================================================
//OPENGRAPH INSTAGRAM SCRAPER (Fixes Audio Issues)
// ============================================================
async function fetchInstagramDirectMedia(targetUrl) {
  try {
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!response.ok) return null;

    const html = await response.text();
    const videoMatch = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/i);
    return videoMatch && videoMatch[1] ? videoMatch[1].replace(/&amp;/g, "&") : null;
  } catch (error) {
    console.error("[OG SCRAPER ERROR]", error?.message || error);
    return null;
  }
}

// ============================================================
//PROCESS RUNNER
// ============================================================
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
// EXTRACT ENDPOINT (Updated for Pinterest & Instagram Audio)
// ============================================================
app.post("/api/extract", async (req, res) => {
  try {
    const inputUrl = cleanInputUrl(req.body?.url);
    if (!inputUrl || !isValidHttpUrl(inputUrl)) {
      return res.status(400).json({ success: false, error: "Please provide a valid video URL." });
    }

    const platform = getPlatform(inputUrl);

    // Try Instagram OpenGraph Scraper First
    if (platform === "instagram") {
      const directVideoUrl = await fetchInstagramDirectMedia(inputUrl);
      if (directVideoUrl) {
        return res.json({
          success: true,
          platform: "instagram",
          title: "Instagram Reel",
          thumbnail: null,
          qualities: [{
            id: directVideoUrl,
            label: "HD Quality (With Audio)",
            previewUrl: directVideoUrl,
            hasAudio: true,
          }],
        });
      }
    }

    // Flexible yt-dlp arguments (Removes strict forced mp4 format breaking Pinterest)
    const args = [
      "--ignore-config",
      "--no-playlist",
      "--no-warnings",
      "--dump-single-json",
      "--skip-download",
      "--user-agent", USER_AGENT,
      inputUrl,
    ];

    const stdout = await runCommand(YTDLP_PATH, args);
    const metadata = JSON.parse(stdout.trim());
    
    // Fallback safely across formats or requested formats
    let directCdnUrl = metadata.url;
    if (!directCdnUrl && metadata.formats && metadata.formats.length > 0) {
      const bestFormat = metadata.formats.reverse().find(f => f.url && f.vcodec !== 'none');
      directCdnUrl = bestFormat ? bestFormat.url : metadata.formats[metadata.formats.length - 1].url;
    }

    if (!directCdnUrl) {
      throw new Error("Could not extract direct stream URL for this media.");
    }

    return res.json({
      success: true,
      platform,
      title: metadata.title || "StreamBox Video",
      thumbnail: metadata.thumbnail || null,
      qualities: [{
        id: directCdnUrl,
        label: "Best Available Quality",
        previewUrl: directCdnUrl,
        hasAudio: true,
      }],
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
 
