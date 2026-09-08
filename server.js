const express = require("express");
const cors = require("cors");
const http = require("http");
const https = https;

const app = express();
const PORT = process.env.PORT || 3000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

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
  if (value.includes("twitter.com") || value.includes("x.com")) return "twitter";
  return "generic";
}

// ============================================================
// UNIVERSAL META & OG TAG EXTRACTOR (Bypasses IP Blocks)
// ============================================================
async function fetchSocialMediaDirectLink(targetUrl, platform) {
  try {
    let fetchUrl = targetUrl;
    
    // Resolve short-links like pin.it or fb.watch
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

    // Extract OpenGraph tags or embedded JSON media structures
    const ogVideoMatch = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/i) ||
                         html.match(/<meta\s+property="og:video:secure_url"\s+content="([^"]+)"/i);
    
    if (ogVideoMatch && ogVideoMatch[1]) {
      videoUrl = ogVideoMatch[1];
    } else if (platform === "instagram") {
      const match = html.match(/"video_url"\s*:\s*"([^"]+)"/i);
      if (match) videoUrl = match[1];
    } else if (platform === "pinterest") {
      const match = html.match(/"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/i) || html.match(/"url"\s*:\s*"([^"]+\.mp4[^"]*)"/i);
      if (match) videoUrl = match[1];
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

    // Direct fetch extraction handles Pinterest, Instagram, X/Twitter, and Facebook safely
    const mediaData = await fetchSocialMediaDirectLink(inputUrl, platform);

    if (!mediaData || !mediaData.url) {
      throw new Error("Unable to extract media stream. The post may be private or restricted.");
    }

    return res.json({
      success: true,
      platform,
      title: mediaData.title,
      thumbnail: null,
      qualities: [{
        id: mediaData.url,
        label: "HD Quality (With Audio)",
        hasAudio: true,
        previewUrl: mediaData.url,
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