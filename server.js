const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

const YTDLP_PATH = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ============================================================
// HELPERS
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
  if (value.includes("pinterest.com") || value.includes("pin.it")) return "pinterest";
  if (value.includes("tiktok.com")) return "tiktok";
  if (value.includes("facebook.com") || value.includes("fb.watch")) return "facebook";
  if (value.includes("twitter.com") || value.includes("x.com") || value.includes("t.co")) return "twitter";
  return "generic";
}

function runCommand(command, args, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The extractor took too long and was stopped."));
    }, timeoutMs);

    child.stdout.on("data", (data) => (stdout += data.toString()));
    child.stderr.on("data", (data) => (stderr += data.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else {
        const lastLine = stderr.trim().split("\n").filter(Boolean).pop();
        reject(new Error(lastLine || `Command failed with code ${code}`));
      }
    });
  });
}

function friendlyExtractError(rawMessage, platform) {
  const msg = (rawMessage || "").toLowerCase();
  if (msg.includes("login") || msg.includes("private") || msg.includes("rate-limit") || msg.includes("429")) {
    return `This ${platform} link needs a login, is private, or is being rate-limited right now.`;
  }
  if (msg.includes("unsupported url")) {
    return "That link isn't a supported video page.";
  }
  if (msg.includes("unable to extract") || msg.includes("no video formats")) {
    return `Could not find a playable video on that ${platform} link.`;
  }
  return "Could not extract playable video from this link.";
}

// A format is only safe to hand to a plain client-side GET request if it's
// already progressive (both video AND audio in one file) and served over
// plain HTTP(S), not HLS (.m3u8) or DASH manifests, which a bare GET can't
// download meaningfully (you'd just save the playlist text, not the media).
function isDirectDownloadable(fmt) {
  if (!fmt || !fmt.url) return false;
  const hasVideo = fmt.vcodec && fmt.vcodec !== "none";
  const hasAudio = fmt.acodec && fmt.acodec !== "none";
  const protocol = (fmt.protocol || "").toLowerCase();
  const looksLikeManifest =
    protocol.includes("m3u8") ||
    protocol.includes("dash") ||
    fmt.url.includes(".m3u8") ||
    fmt.url.includes(".mpd");
  return hasVideo && hasAudio && !looksLikeManifest;
}

// ============================================================
// EXTRACTION
// Everything happens here; there is no server-side download route.
// The client downloads the returned URL directly, so we only ever
// return formats that are safe for a plain client-side GET, plus
// whatever headers (Referer/User-Agent/cookies) that specific CDN
// URL actually needs, since Instagram/Facebook/TikTok links are
// often referer-locked and will 403 without them.
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
      "--geo-bypass",
      "--socket-timeout", "30",
      "--retries", "3",
      "--user-agent", USER_AGENT,
      "--dump-single-json",
      "--skip-download",
      inputUrl,
    ];

    let stdout;
    try {
      stdout = await runCommand(YTDLP_PATH, args, { timeoutMs: 45000 });
    } catch (err) {
      throw new Error(friendlyExtractError(err.message, platform));
    }

    let metadata;
    try {
      metadata = JSON.parse(stdout.trim());
    } catch {
      throw new Error("The extractor returned an unreadable response.");
    }

    const formats = Array.isArray(metadata.formats) ? metadata.formats : [];
    let candidates = formats.filter(isDirectDownloadable);

    // Some extractors only ever populate the top-level fields (not a
    // formats[] array) for single-format platforms - fall back to that.
    if (candidates.length === 0 && isDirectDownloadable(metadata)) {
      candidates = [metadata];
    }

    // Keep the best (highest bitrate) entry per height, highest first.
    const byHeight = new Map();
    for (const fmt of candidates) {
      const h = fmt.height || 0;
      const existing = byHeight.get(h);
      if (!existing || (fmt.tbr || 0) > (existing.tbr || 0)) byHeight.set(h, fmt);
    }

    const sorted = Array.from(byHeight.values())
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .slice(0, 4);

    const qualities = sorted.map((fmt) => ({
      id: fmt.url,
      label: fmt.height ? `${fmt.height}p` : fmt.format_note || "Available Quality",
      height: fmt.height || null,
      width: fmt.width || null,
      hasAudio: true,
      // Headers this exact CDN URL needs to be fetched successfully.
      // yt-dlp already resolves the right Referer/cookies per platform.
      headers: fmt.http_headers || {},
    }));

    if (qualities.length === 0) {
      throw new Error(
        `No direct, downloadable video file was found for this ${platform} link - only a streaming manifest is available, which this app can't save.`
      );
    }

    return res.json({
      success: true,
      platform,
      title: metadata.title || "StreamBox Video",
      thumbnail: metadata.thumbnail || null,
      qualities,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message?.length > 250 ? "Unable to extract video link." : error.message,
    });
  }
});

app.get("/", (req, res) => res.json({ success: true, service: "StreamBox Extraction Backend", status: "online" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`STREAMBOX EXTRACT API running on port ${PORT}`);
});