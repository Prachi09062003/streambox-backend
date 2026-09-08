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
  if (value.includes("tiktok.com") || value.includes("://tiktok.com")) return "tiktok";
  if (value.includes("facebook.com") || value.includes("fb.watch")) return "facebook";
  if (value.includes("pinterest.com") || value.includes("pin.it")) return "pinterest";
  if (value.includes("twitter.com") || value.includes("x.com")) return "twitter";
  return "generic";
}

// ============================================================
// PROCESS RUNNER
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
// EXTRACT ENDPOINT
// ============================================================
app.post("/api/extract", async (req, res) => {
  try {
    const inputUrl = cleanInputUrl(req.body?.url);
    if (!inputUrl || !isValidHttpUrl(inputUrl)) {
      return res.status(400).json({ success: false, error: "Please provide a valid video URL." });
    }

    const platform = getPlatform(inputUrl);

    const args = [
      "--ignore-config",
      "--no-playlist",
      "--no-warnings",
      "--dump-single-json",
      "--skip-download",
      "--geo-bypass",
      "--add-header", "Referer:https://www.pinterest.com/",
      "--user-agent", USER_AGENT,
      inputUrl,
    ];

    const stdout = await runCommand(YTDLP_PATH, args);
    const metadata = JSON.parse(stdout.trim());
    
    let qualities = [];

    if (metadata.url) {
      qualities.push({
        id: metadata.url,
        label: metadata.height ? `${metadata.height}p` : "Best Available Quality",
        height: metadata.height || null,
        width: metadata.width || null,
        hasAudio: true,
        previewUrl: metadata.url,
      });
    }

    if (metadata.formats && Array.isArray(metadata.formats)) {
      const validFormats = metadata.formats.filter(f => f.url);
      
      for (const fmt of validFormats) {
        const hasVideo = fmt.vcodec && fmt.vcodec !== 'none';
        const hasAudio = fmt.acodec && fmt.acodec !== 'none';

        if (hasVideo) {
          qualities.push({
            id: fmt.url,
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
      if (a.hasAudio !== b.hasAudio) return b.hasAudio ? 1 : -1;
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