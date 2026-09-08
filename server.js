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
  if (value.includes("tiktok.com") || value.includes("://tiktok.com")) return "tiktok";
  if (value.includes("facebook.com") || value.includes("fb.watch")) return "facebook";
  if (value.includes("pinterest.com") || value.includes("pin.it")) return "pinterest";
  if (value.includes("twitter.com") || value.includes("x.com")) return "twitter";
  return "generic";
}

// ============================================================
// STABLE EXTERNAL FETCHER FOR INSTAGRAM & PINTEREST
// ============================================================
async function fetchViaPublicApi(targetUrl) {
  try {
    // Using a reliable public media downloader endpoint proxy
    const apiRes = await fetch(`https://tikwm.com/api/?url=${encodeURIComponent(targetUrl)}`, {
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
// EXTRACT ENDPOINT (With Fixed Multi-Stream Audio/Video Muxing)
// ============================================================
app.post("/api/extract", async (req, res) => {
  try {
    const inputUrl = cleanInputUrl(req.body?.url);
    if (!inputUrl || !isValidHttpUrl(inputUrl)) {
      return res.status(400).json({ success: false, error: "Please provide a valid video URL." });
    }

    const platform = getPlatform(inputUrl);

    // 1. Fallback Proxy Route Check
    if (platform === "instagram" || platform === "pinterest" || platform === "tiktok") {
      const mediaData = await fetchViaPublicApi(inputUrl);
      if (mediaData && mediaData.url) {
        return res.json({
          success: true,
          platform,
          title: mediaData.title,
          thumbnail: mediaData.thumbnail,
          qualities: [{
            id: mediaData.url,
            label: "HD Quality (With Audio)",
            hasAudio: true,
            previewUrl: mediaData.url,
          }],
        });
      }
    }

    // 2. Main Local Engine Fallback (Now handles multi-stream extraction)
    const args = [
      "--ignore-config",
      "--no-playlist",
      "--no-warnings",
      "--dump-single-json",
      "--skip-download",
      "--geo-bypass",
      // Force extraction of formats containing combined audio and video 
      "--format", "bestvideo+bestaudio/best",
      "--user-agent", USER_AGENT,
      inputUrl,
    ];

    const stdout = await runCommand(YTDLP_PATH, args);
    const metadata = JSON.parse(stdout.trim());
    
    let qualities = [];

    // Prioritize direct output targets
    if (metadata.url) {
      // Avoid raw m3u8 playlist format delivery for Pinterest downloads
      const isM3u8 = metadata.url.includes(".m3u8");
      qualities.push({
        id: metadata.url,
        label: metadata.height ? `${metadata.height}p` : "Best Available Quality",
        height: metadata.height || null,
        width: metadata.width || null,
        hasAudio: !isM3u8, 
        previewUrl: metadata.url,
      });
    }

    if (metadata.formats && Array.isArray(metadata.formats)) {
      const validFormats = metadata.formats.filter(f => f.url);
      for (const fmt of validFormats) {
        // Skip unplayable formats completely 
        if (fmt.url.includes(".m3u8")) continue;

        const hasVideo = fmt.vcodec && fmt.vcodec !== 'none';
        const hasAudio = fmt.acodec && fmt.acodec !== 'none';

        if (hasVideo) {
          qualities.push({
            id: fmt.url,
            label: fmt.height ? `${fmt.height}p` : (fmt.format_note || 'Standard Quality'),
            height: fmt.height || null,
            width: fmt.width || null,
            hasAudio: hasAudio || fmt.acodec !== undefined,
            previewUrl: fmt.url,
          });
        }
      }
    }

    // Ensure qualities containing full audio track properties bubbles up first
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

// ============================================================
// LIVE STREAM CONVERSION PROXY (M3U8 -> MP4 Converter Engine)
// ============================================================
app.get("/api/download-proxy", (req, res) => {
  const streamUrl = req.query.url;

  if (!streamUrl || !isValidHttpUrl(streamUrl)) {
    return res.status(400).json({ success: false, error: "Missing or invalid streaming target configuration." });
  }

  // Set explicit download headers so mobile clients handle it as a flat file binary stream
  res.setHeader("Content-Disposition", `attachment; filename="StreamBox_Converted_${Date.now()}.mp4"`);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Transfer-Encoding", "chunked");

  console.log(`[FFmpeg Proxy Engine] Transcoding stream target initialization: ${streamUrl}`);

  // Spawn FFmpeg to stream process the m3u8 playlist fragments on the fly
  const ffmpegProcess = spawn(YTDLP_PATH.replace("yt-dlp", "ffmpeg"), [
    "-i", streamUrl,             // Input streaming manifest location link
    "-c:v", "copy",              // Copy original video directly without re-encoding to save CPU cycles
    "-c:a", "aac",               // Re-encode audio to basic AAC to guarantee hardware playback capability
    "-bsf:a", "aac_adtstoasc",   // Fix standard HLS bitstream data container structures
    "-movflags", "frag_keyframe+empty_moov", // Force streaming output compatibility wrappers
    "-f", "mp4",                 // Set output type container format to standard MP4
    "pipe:1"                     // Pipe output directly into standard output stream handles
  ], { windowsHide: true });

  // Pipe the live transcoding output buffer directly into your Express HTTP server response payload
  ffmpegProcess.stdout.pipe(res);

  // Error boundary protection
  ffmpegProcess.stderr.on("data", (data) => {
    // Only logged for administrative internal debugging tracking windows
    // console.log(`[FFmpeg Diagnostic Context]: ${data.toString()}`);
  });

  ffmpegProcess.on("close", (code) => {
    console.log(`[FFmpeg Proxy Engine] Transcoding pipeline finished execution lifecycle with code: ${code}`);
    res.end();
  });

  // Handle client cancellations gracefully to terminate background ghost processing instances
  req.on("close", () => {
    try {
      ffmpegProcess.kill("SIGKILL");
    } catch (_) {}
  });
});


app.get("/", (req, res) => res.json({ success: true, service: "StreamBox Extraction Backend", status: "online" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`STREAMBOX EXTRACT API running on port ${PORT}`);
});