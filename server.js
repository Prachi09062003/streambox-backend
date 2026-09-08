const express = require("express");
const cors = require("cors");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

const YTDLP_PATH = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";

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
  if (value.includes("tiktok.com")) return "tiktok";
  if (value.includes("facebook.com") || value.includes("fb.watch")) return "facebook";
  if (value.includes("twitter.com") || value.includes("x.com") || value.includes("t.co")) return "twitter";
  return "generic";
}

// ============================================================
// UNIVERSAL MOBILE SCRAPER (Bypasses Cloud IP & Bot Blocks)
// ============================================================
async function fetchSocialMediaDirectLink(targetUrl) {
  try {
    let fetchUrl = targetUrl;
    
    // Resolve short-links like pin.it, fb.watch, or t.co
    if (targetUrl.includes("pin.it") || targetUrl.includes("fb.watch") || targetUrl.includes("t.co")) {
      fetchUrl = await new Promise((resolve) => {
        const client = targetUrl.startsWith("https") ? https : http;
        client.request(targetUrl, { method: "HEAD", headers: { "User-Agent": USER_AGENT } }, (res) => {
          resolve(res.headers.location ? new URL(res.headers.location, targetUrl).href : targetUrl);
        }).on("error", () => resolve(targetUrl)).end();
      });
    }

    const response = await fetch(fetchUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if (!response.ok) return null;
    const html = await response.text();

    let videoUrl = null;
    let title = "StreamBox Video";

    // Extract OpenGraph tags which natively contain pre-muxed video files with audio
    const ogVideoMatch = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/i) ||
                         html.match(/<meta\s+property="og:video:secure_url"\s+content="([^"]+)"/i) ||
                         html.match(/"video_url"\s*:\s*"([^"]+)"/i) ||
                         html.match(/"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/i);
    
    if (ogVideoMatch && ogVideoMatch[1]) {
      videoUrl = ogVideoMatch[1];
    }

    const ogTitleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (ogTitleMatch && ogTitleMatch[1]) {
      title = ogTitleMatch[1];
    }

    if (videoUrl) {
      return {
        url: videoUrl.replace(/&amp;/g, "&").replace(/u0026/g, "&").replace(/\\/g, ""),
        title: title.trim(),
      };
    }
  } catch (err) {
    console.error("[SCRAPER ERROR]", err.message);
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
// API EXTRACTION ROUTE
// ============================================================
app.post("/api/extract", async (req, res) => {
  try {
    const inputUrl = cleanInputUrl(req.body?.url);
    if (!inputUrl || !isValidHttpUrl(inputUrl)) {
      return res.status(400).json({ success: false, error: "Please provide a valid video URL." });
    }

    const platform = getPlatform(inputUrl);

    // Step 1: Attempt direct OpenGraph meta-scraping first (bypasses bot blocks & audio separation)
    const scrapedMedia = await fetchSocialMediaDirectLink(inputUrl);
    if (scrapedMedia && scrapedMedia.url) {
      return res.json({
        success: true,
        platform,
        title: scrapedMedia.title,
        thumbnail: null,
        qualities: [{
          id: scrapedMedia.url,
          label: "HD Quality (With Audio)",
          hasAudio: true,
          previewUrl: scrapedMedia.url,
        }],
      });
    }

    // Step 2: Fallback to yt-dlp with mobile emulation if meta-scraping fails
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