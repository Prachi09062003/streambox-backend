const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 3000;

const YTDLP_PATH = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 " +
  "Mobile/15E148 Safari/604.1";

app.use(cors());

app.use(
  express.json({
    limit: "1mb",
  })
);

// ============================================================
// HELPERS
// ============================================================

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}

function cleanInputUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/^<|>$/g, "");
}

function getPlatform(url) {
  const value = url.toLowerCase();

  if (
    value.includes("instagram.com") ||
    value.includes("instagr.am")
  ) {
    return "instagram";
  }

  if (
    value.includes("pinterest.com") ||
    value.includes("pin.it")
  ) {
    return "pinterest";
  }

  if (value.includes("tiktok.com")) {
    return "tiktok";
  }

  if (
    value.includes("facebook.com") ||
    value.includes("fb.watch")
  ) {
    return "facebook";
  }

  if (
    value.includes("twitter.com") ||
    value.includes("x.com") ||
    value.includes("t.co")
  ) {
    return "twitter";
  }

  if (
    value.includes("youtube.com") ||
    value.includes("youtu.be")
  ) {
    return "youtube";
  }

  return "generic";
}

// ============================================================
// RUN COMMAND
// ============================================================

function runCommand(command, args, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;

      finished = true;

      try {
        child.kill("SIGKILL");
      } catch (_) {}

      reject(
        new Error(
          "The extractor took too long and was stopped."
        )
      );
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      reject(err);
    });

    child.on("close", (code) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve(stdout);
        return;
      }

      const lastLine = stderr
        .trim()
        .split("\n")
        .filter(Boolean)
        .pop();

      reject(
        new Error(
          lastLine ||
            `Command failed with code ${code}`
        )
      );
    });
  });
}

// ============================================================
// ERROR HANDLING
// ============================================================

function friendlyExtractError(rawMessage, platform) {
  const msg = (rawMessage || "").toLowerCase();

  if (
    msg.includes("login") ||
    msg.includes("private") ||
    msg.includes("rate-limit") ||
    msg.includes("429") ||
    msg.includes("too many requests")
  ) {
    return `This ${platform} link needs a login, is private, or is being rate-limited right now.`;
  }

  if (msg.includes("unsupported url")) {
    return "That link isn't a supported video page.";
  }

  if (
    msg.includes("unable to extract") ||
    msg.includes("no video formats") ||
    msg.includes("requested format is not available")
  ) {
    return `Could not find a playable video on that ${platform} link.`;
  }

  return "Could not extract playable video from this link.";
}

// ============================================================
// FORMAT HELPERS
// ============================================================

function hasVideo(fmt) {
  return (
    fmt &&
    fmt.vcodec &&
    fmt.vcodec !== "none"
  );
}

function hasAudio(fmt) {
  return (
    fmt &&
    fmt.acodec &&
    fmt.acodec !== "none"
  );
}

function isHttpUrl(url) {
  if (!url) return false;

  try {
    const parsed = new URL(url);

    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:"
    );
  } catch {
    return false;
  }
}

// ============================================================
// MANIFEST FILTER
// ============================================================

function isManifestFormat(fmt) {
  if (!fmt) return true;

  const protocol = String(
    fmt.protocol || ""
  ).toLowerCase();

  const url = String(
    fmt.url || ""
  ).toLowerCase();

  if (
    protocol.includes("m3u8") ||
    protocol.includes("m3u8_native") ||
    protocol.includes("dash") ||
    protocol.includes("http_dash_segments")
  ) {
    return true;
  }

  if (
    url.includes(".m3u8") ||
    url.includes(".mpd")
  ) {
    return true;
  }

  return false;
}

// ============================================================
// DIRECT DOWNLOADABLE FORMAT
// ============================================================

function isDirectDownloadable(fmt) {
  if (!fmt || !fmt.url) {
    return false;
  }

  if (!isHttpUrl(fmt.url)) {
    return false;
  }

  if (isManifestFormat(fmt)) {
    return false;
  }

  return true;
}

// ============================================================
// SAFE HEADERS
// ============================================================
//
// We return the headers yt-dlp says are required by the CDN.
//
// Cookie headers are intentionally excluded because returning
// session cookies to the client is undesirable.
//
// ============================================================

function getHeaders(fmt) {
  const source = fmt?.http_headers || {};
  const result = {};

  for (const [key, value] of Object.entries(source)) {
    if (!value) continue;

    const lowerKey = key.toLowerCase();

    // Securely exclude cookies
    if (lowerKey === "cookie") {
      continue;
    }

    // Pass everything your Flutter client needs to bypass the Instagram CDN block
    if (
      lowerKey === "user-agent" ||
      lowerKey === "referer" ||
      lowerKey === "origin" ||
      lowerKey === "accept" ||
      lowerKey.startsWith("sec-ch-") ||
      lowerKey.startsWith("sec-fetch-")
    ) {
      result[key] = String(value);
    }
  }

  if (!Object.keys(result).some(k => k.toLowerCase() === "user-agent")) {
    result["User-Agent"] = USER_AGENT;
  }

  return result;
}


// ============================================================
// BITRATE / QUALITY HELPERS
// ============================================================

function getNumber(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : 0;
}

function getHeight(fmt) {
  const height = getNumber(fmt?.height);

  return height > 0
    ? Math.round(height)
    : 0;
}

function getWidth(fmt) {
  const width = getNumber(fmt?.width);

  return width > 0
    ? Math.round(width)
    : 0;
}

function getBitrate(fmt) {
  return (
    getNumber(fmt?.tbr) ||
    getNumber(fmt?.vbr) ||
    getNumber(fmt?.abr) ||
    0
  );
}

function getAudioBitrate(fmt) {
  return (
    getNumber(fmt?.abr) ||
    getNumber(fmt?.tbr) ||
    0
  );
}

// ============================================================
// FORMAT SCORING
// ============================================================

function scoreProgressive(fmt) {
  let score = 0;

  if (fmt.ext === "mp4") {
    score += 100000;
  }

  if (fmt.container === "mp4") {
    score += 50000;
  }

  score += getHeight(fmt) * 100;

  score += getBitrate(fmt);

  if (
    fmt.vcodec &&
    String(fmt.vcodec).startsWith("avc")
  ) {
    score += 5000;
  }

  if (
    fmt.acodec &&
    String(fmt.acodec).startsWith("mp4a")
  ) {
    score += 5000;
  }

  return score;
}

function scoreVideoOnly(fmt) {
  let score = 0;

  if (fmt.ext === "mp4") {
    score += 100000;
  }

  if (fmt.container === "mp4") {
    score += 50000;
  }

  score += getHeight(fmt) * 100;

  score += getBitrate(fmt);

  if (
    fmt.vcodec &&
    String(fmt.vcodec).startsWith("avc")
  ) {
    score += 5000;
  }

  return score;
}

function scoreAudio(fmt) {
  let score = 0;

  if (fmt.ext === "m4a") {
    score += 100000;
  }

  if (fmt.container === "m4a") {
    score += 50000;
  }

  if (
    fmt.acodec &&
    String(fmt.acodec).startsWith("mp4a")
  ) {
    score += 5000;
  }

  score += getAudioBitrate(fmt);

  return score;
}

// ============================================================
// QUALITY LABEL
// ============================================================

function qualityLabel(height) {
  if (!height || height <= 0) {
    return "Available Quality";
  }

  return `${height}p`;
}

// ============================================================
// FORMAT ID
// ============================================================

function makeQualityId(
  type,
  height,
  index
) {
  return `${type}-${height || "unknown"}-${index}`;
}

// ============================================================
// BUILD PROGRESSIVE QUALITY
// ============================================================

function buildProgressiveQuality(
  fmt,
  index
) {
  const height = getHeight(fmt);
  const width = getWidth(fmt);

  return {
    id: makeQualityId(
      "progressive",
      height,
      index
    ),

    label: qualityLabel(height),

    height:
      height > 0
        ? height
        : null,

    width:
      width > 0
        ? width
        : null,

    hasVideo: true,
    hasAudio: true,

    needsMerge: false,

    // Direct combined video + audio URL.
    url: fmt.url,

    headers: getHeaders(fmt),

    // Useful metadata for Flutter.
    videoCodec:
      fmt.vcodec || null,

    audioCodec:
      fmt.acodec || null,

    ext:
      fmt.ext || "mp4",

    type: "progressive",
  };
}

// ============================================================
// BUILD SEPARATE STREAM QUALITY
// ============================================================

function buildSeparateQuality(
  videoFmt,
  audioFmt,
  index
) {
  const height = getHeight(videoFmt);
  const width = getWidth(videoFmt);

  return {
    id: makeQualityId(
      "merged",
      height,
      index
    ),

    label: `${qualityLabel(height)} • Video + Audio`,

    height:
      height > 0
        ? height
        : null,

    width:
      width > 0
        ? width
        : null,

    hasVideo: true,
    hasAudio: true,

    // Flutter must download both and merge locally.
    needsMerge: true,

    // Video-only CDN URL.
    videoUrl: videoFmt.url,

    // Audio-only CDN URL.
    audioUrl: audioFmt.url,

    videoHeaders:
      getHeaders(videoFmt),

    audioHeaders:
      getHeaders(audioFmt),

    videoCodec:
      videoFmt.vcodec || null,

    audioCodec:
      audioFmt.acodec || null,

    videoExt:
      videoFmt.ext || "mp4",

    audioExt:
      audioFmt.ext || "m4a",

    type: "separate",
  };
}

// ============================================================
// BUILD VIDEO-ONLY FALLBACK
// ============================================================

function buildVideoOnlyQuality(
  videoFmt,
  index
) {
  const height = getHeight(videoFmt);
  const width = getWidth(videoFmt);

  return {
    id: makeQualityId(
      "video-only",
      height,
      index
    ),

    label: `${qualityLabel(height)} • No Audio`,

    height:
      height > 0
        ? height
        : null,

    width:
      width > 0
        ? width
        : null,

    hasVideo: true,
    hasAudio: false,

    needsMerge: false,

    url: videoFmt.url,

    headers:
      getHeaders(videoFmt),

    videoCodec:
      videoFmt.vcodec || null,

    ext:
      videoFmt.ext || "mp4",

    type: "video-only",

    audioUnavailable: true,
  };
}

// ============================================================
// PICK BEST AUDIO
// ============================================================

function selectBestAudio(audioFormats) {
  if (!audioFormats.length) {
    return null;
  }

  const sorted = [...audioFormats].sort(
    (a, b) =>
      scoreAudio(b) -
      scoreAudio(a)
  );

  return sorted[0];
}

// ============================================================
// BUILD QUALITY LIST
// ============================================================

function buildQualities(formats) {
  const directFormats =
    formats.filter(
      isDirectDownloadable
    );

  // ----------------------------------------------------------
  // Progressive = video + audio in the SAME file
  // ----------------------------------------------------------

  const progressiveFormats =
    directFormats.filter(
      (fmt) =>
        hasVideo(fmt) &&
        hasAudio(fmt)
    );

  // Prefer MP4 progressive formats.
  const mp4Progressive =
    progressiveFormats.filter(
      (fmt) =>
        String(fmt.ext || "").toLowerCase() ===
        "mp4"
    );

  const selectedProgressive =
    mp4Progressive.length
      ? mp4Progressive
      : progressiveFormats;

  // ----------------------------------------------------------
  // Video-only
  // ----------------------------------------------------------

  const videoOnlyFormats =
    directFormats.filter(
      (fmt) =>
        hasVideo(fmt) &&
        !hasAudio(fmt)
    );

  // ----------------------------------------------------------
  // Audio-only
  // ----------------------------------------------------------

  const audioOnlyFormats =
    directFormats.filter(
      (fmt) =>
        !hasVideo(fmt) &&
        hasAudio(fmt)
    );

  const bestAudio =
    selectBestAudio(
      audioOnlyFormats
    );

  // ==========================================================
  // GROUP PROGRESSIVE BY HEIGHT
  // ==========================================================

  const progressiveByHeight =
    new Map();

  for (const fmt of selectedProgressive) {
    const height = getHeight(fmt);

    if (height <= 0) {
      continue;
    }

    const current =
      progressiveByHeight.get(height);

    if (
      !current ||
      scoreProgressive(fmt) >
        scoreProgressive(current)
    ) {
      progressiveByHeight.set(
        height,
        fmt
      );
    }
  }

  // ==========================================================
  // GROUP VIDEO-ONLY BY HEIGHT
  // ==========================================================

  const videoByHeight =
    new Map();

  for (const fmt of videoOnlyFormats) {
    const height = getHeight(fmt);

    if (height <= 0) {
      continue;
    }

    const current =
      videoByHeight.get(height);

    if (
      !current ||
      scoreVideoOnly(fmt) >
        scoreVideoOnly(current)
    ) {
      videoByHeight.set(
        height,
        fmt
      );
    }
  }

  // ==========================================================
  // FINAL QUALITIES
  // ==========================================================

  const heights = new Set([
    ...progressiveByHeight.keys(),
    ...videoByHeight.keys(),
  ]);

  const sortedHeights =
    [...heights].sort(
      (a, b) => b - a
    );

  const qualities = [];

  let index = 0;

  for (const height of sortedHeights) {
    const progressive =
      progressiveByHeight.get(
        height
      );

    const videoOnly =
      videoByHeight.get(height);

    // --------------------------------------------------------
    // IMPORTANT:
    // If combined MP4 exists, prefer it.
    // --------------------------------------------------------

    if (progressive) {
      qualities.push(
        buildProgressiveQuality(
          progressive,
          index++
        )
      );

      continue;
    }

    // --------------------------------------------------------
    // If there is no combined stream but there is video-only
    // AND audio-only, return separate streams.
    // Flutter will merge them locally.
    // --------------------------------------------------------

    if (
      videoOnly &&
      bestAudio
    ) {
      qualities.push(
        buildSeparateQuality(
          videoOnly,
          bestAudio,
          index++
        )
      );

      continue;
    }

    // --------------------------------------------------------
    // If no audio exists, return video-only.
    // Flutter can show "No Audio".
    // --------------------------------------------------------

    if (videoOnly) {
      qualities.push(
        buildVideoOnlyQuality(
          videoOnly,
          index++
        )
      );
    }
  }

  // ==========================================================
  // LIMIT QUALITIES
  // ==========================================================
  //
  // Prevent a huge yt-dlp format list from being sent to
  // Flutter.
  //
  // Highest available qualities are returned.
  //
  // ==========================================================

  return qualities.slice(0, 8);
}

// ============================================================
// API: EXTRACT
// ============================================================

app.post(
  "/api/extract",
  async (req, res) => {
    const cleanUrl =
      cleanInputUrl(
        req.body?.url
      );

    if (
      !cleanUrl ||
      !isValidHttpUrl(cleanUrl)
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Please provide a valid HTTP or HTTPS video URL.",
      });
    }

    const platform =
      getPlatform(cleanUrl);

    try {
      console.log(
        `[EXTRACT] ${platform}: ${cleanUrl}`
      );

      // ======================================================
      // yt-dlp
      // ======================================================
      //
      // IMPORTANT:
      // No FFmpeg is executed here.
      //
      // We only ask yt-dlp for metadata and direct formats.
      //
      // ======================================================

            const args = [
        "--dump-single-json",
        "--no-warnings",
        "--skip-download",
        "--no-playlist",
        "--no-check-certificates",
        "--no-cache-dir",          // Prevents Render disk-fill / memory leaks
        "--rm-cache-dir",          // Clears out previous cache artifacts
        "--user-agent",
        USER_AGENT,
        "--socket-timeout",
        "20",
        "--retries",
        "2",
        cleanUrl,
      ];


      const stdout =
        await runCommand(
          YTDLP_PATH,
          args,
          {
            timeoutMs: 45000,
          }
        );

      let info;

      try {
        info = JSON.parse(stdout);
      } catch (parseError) {
        console.error(
          "[EXTRACT] Invalid yt-dlp JSON"
        );

        throw new Error(
          "The extractor returned invalid metadata."
        );
      }

      // ======================================================
      // FORMATS
      // ======================================================

      const formats =
        Array.isArray(info.formats)
          ? info.formats
          : [];

      const qualities =
        buildQualities(
          formats
        );

      if (!qualities.length) {
        throw new Error(
          "No direct downloadable video formats were found."
        );
      }

      // ======================================================
      // RESPONSE
      // ======================================================

      const response = {
        success: true,

        platform,

        sourceUrl: cleanUrl,

        title:
          info.title ||
          "Video",

        thumbnail:
          info.thumbnail ||
          null,

        duration:
          Number.isFinite(
            Number(info.duration)
          )
            ? Number(info.duration)
            : null,

        uploader:
          info.uploader ||
          info.channel ||
          null,

        qualities,

        // Useful debugging/diagnostic information.
        // Does not contain the full yt-dlp object.
        formatCount:
          formats.length,

        returnedQualityCount:
          qualities.length,
      };

      console.log(
        `[EXTRACT] ${platform} -> ${qualities.length} qualities`
      );

      return res.json(
        response
      );
    } catch (error) {
      console.error(
        "[EXTRACT ERROR]",
        error
      );

      return res.status(500).json({
        success: false,

        platform,

        error:
          friendlyExtractError(
            error?.message,
            platform
          ),
      });
    }
  }
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,

      service:
        "StreamBox Extraction Backend",

      status: "online",

      architecture: {
        extraction: "yt-dlp",

        serverProcessing:
          "none",

        download:
          "client-side",

        ffmpeg:
          "client-side",
      },
    });
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      error: "Endpoint not found.",
    });
  }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `STREAMBOX EXTRACTION API running on port ${PORT}`
    );

    console.log(
      `yt-dlp path: ${YTDLP_PATH}`
    );
  }
);