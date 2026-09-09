const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 3000;
const YTDLP_PATH =
  process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "Version/17.0 Mobile/15E148 Safari/604.1";

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

  if (
    value.includes("youtube.com") ||
    value.includes("youtu.be")
  ) {
    return "youtube";
  }

  if (
    value.includes("instagram.com") ||
    value.includes("instagr.am")
  ) {
    return "instagram";
  }

  if (
    value.includes("facebook.com") ||
    value.includes("fb.watch") ||
    value.includes("fb.com")
  ) {
    return "facebook";
  }

  if (value.includes("tiktok.com")) {
    return "tiktok";
  }

  if (
    value.includes("pinterest.com") ||
    value.includes("pin.it")
  ) {
    return "pinterest";
  }

  if (
    value.includes("twitter.com") ||
    value.includes("x.com")
  ) {
    return "twitter";
  }

  return "unknown";
}

// ============================================================
// URL VALIDATION
// ============================================================

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch (_) {
    return false;
  }
}

// ============================================================
// SAFE HEADERS
// ============================================================

function getHeaders(format) {
  const result = {};

  const source =
    format?.http_headers ||
    format?.headers ||
    {};

  if (!source || typeof source !== "object") {
    return result;
  }

  for (const [key, value] of Object.entries(source)) {
    if (value == null) continue;

    const lower = key.toLowerCase();

    // Never expose cookies from yt-dlp to the client.
    if (lower === "cookie") {
      continue;
    }

    // These are safe/useful for direct CDN requests.
    if (
      [
        "user-agent",
        "referer",
        "origin",
        "accept",
        "accept-language",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
        "sec-ch-ua",
        "sec-ch-ua-mobile",
        "sec-ch-ua-platform",
      ].includes(lower)
    ) {
      result[key] = String(value);
    }
  }

  return result;
}

// ============================================================
// MEDIA FORMAT HELPERS
// ============================================================

function isHttpMediaUrl(format) {
  if (!format || !format.url) {
    return false;
  }

  const url = String(format.url);

  if (
    !url.startsWith("http://") &&
    !url.startsWith("https://")
  ) {
    return false;
  }

  const lower = url.toLowerCase();

  // Do not send HLS/DASH manifests to Flutter as MP4.
  if (
    lower.includes(".m3u8") ||
    lower.includes(".mpd") ||
    lower.includes("m3u8") ||
    lower.includes("dash")
  ) {
    return false;
  }

  return true;
}

function hasVideo(format) {
  return (
    format &&
    format.vcodec &&
    format.vcodec !== "none"
  );
}

function hasAudio(format) {
  return (
    format &&
    format.acodec &&
    format.acodec !== "none"
  );
}

function isMp4(format) {
  const ext =
    String(format?.ext || "").toLowerCase();

  const container =
    String(format?.container || "").toLowerCase();

  const url =
    String(format?.url || "").toLowerCase();

  return (
    ext === "mp4" ||
    container.includes("mp4") ||
    url.includes(".mp4")
  );
}

function heightOf(format) {
  const height = Number(format?.height);

  if (
    Number.isFinite(height) &&
    height > 0
  ) {
    return height;
  }

  return null;
}

function bitrateOf(format) {
  const values = [
    format?.tbr,
    format?.vbr,
    format?.abr,
    format?.filesize,
    format?.filesize_approx,
  ];

  for (const value of values) {
    const number = Number(value);

    if (
      Number.isFinite(number) &&
      number > 0
    ) {
      return number;
    }
  }

  return 0;
}

// ============================================================
// FORMAT SORTING
// ============================================================

function compareFormats(a, b) {
  const heightA = heightOf(a) || 0;
  const heightB = heightOf(b) || 0;

  if (heightA !== heightB) {
    return heightB - heightA;
  }

  const mp4A = isMp4(a) ? 1 : 0;
  const mp4B = isMp4(b) ? 1 : 0;

  if (mp4A !== mp4B) {
    return mp4B - mp4A;
  }

  const bitrateA = bitrateOf(a);
  const bitrateB = bitrateOf(b);

  return bitrateB - bitrateA;
}

// ============================================================
// PICK BEST FORMAT FOR HEIGHT
// ============================================================

function pickBest(formats, height) {
  const matching = formats.filter(
    (format) =>
      heightOf(format) === height
  );

  if (matching.length === 0) {
    return null;
  }

  matching.sort(compareFormats);

  return matching[0];
}

// ============================================================
// BUILD QUALITIES
// ============================================================

function buildQualities(info, platform) {
  const formats = Array.isArray(info.formats)
    ? info.formats
    : [];

  // ----------------------------------------------------------
  // Only direct HTTP/HTTPS media formats.
  // ----------------------------------------------------------

  const directFormats = formats.filter(
    isHttpMediaUrl
  );

  // ----------------------------------------------------------
  // Progressive MP4
  //
  // Video + audio in ONE file.
  // ----------------------------------------------------------

  const progressiveMp4 =
    directFormats.filter(
      (format) =>
        hasVideo(format) &&
        hasAudio(format) &&
        isMp4(format)
    );

  // ----------------------------------------------------------
  // MP4 video-only
  // ----------------------------------------------------------

  const videoOnlyMp4 =
    directFormats.filter(
      (format) =>
        hasVideo(format) &&
        !hasAudio(format) &&
        isMp4(format)
    );

  // ----------------------------------------------------------
  // Audio formats.
  //
  // Prefer M4A/MP4 audio because it is easier to merge
  // into an MP4 on Android.
  // ----------------------------------------------------------

  const audioFormats =
    directFormats.filter(
      (format) =>
        !hasVideo(format) &&
        hasAudio(format)
    );

  audioFormats.sort((a, b) => {
    const m4aA =
      isMp4(a) ||
      String(a?.ext).toLowerCase() === "m4a"
        ? 1
        : 0;

    const m4aB =
      isMp4(b) ||
      String(b?.ext).toLowerCase() === "m4a"
        ? 1
        : 0;

    if (m4aA !== m4aB) {
      return m4aB - m4aA;
    }

    return bitrateOf(b) - bitrateOf(a);
  });

  const bestAudio =
    audioFormats.length > 0
      ? audioFormats[0]
      : null;

  // ----------------------------------------------------------
  // Available heights.
  // ----------------------------------------------------------

  const heights = new Set();

  for (const format of progressiveMp4) {
    const height = heightOf(format);

    if (height) {
      heights.add(height);
    }
  }

  for (const format of videoOnlyMp4) {
    const height = heightOf(format);

    if (height) {
      heights.add(height);
    }
  }

  const sortedHeights =
    Array.from(heights)
      .sort((a, b) => b - a)
      .slice(0, 8);

  const qualities = [];

  // ==========================================================
  // CREATE ONE QUALITY ENTRY PER HEIGHT
  // ==========================================================

  for (const height of sortedHeights) {
    const progressive =
      pickBest(
        progressiveMp4,
        height
      );

    // --------------------------------------------------------
    // CASE A:
    // Progressive MP4 exists.
    // --------------------------------------------------------

    if (progressive) {
      qualities.push({
        id:
          `progressive-${height}-` +
          `${progressive.format_id || "mp4"}`,

        label: `${height}p`,

        height,

        width:
          Number(progressive.width) ||
          null,

        hasVideo: true,
        hasAudio: true,
        needsMerge: false,

        url: progressive.url,

        headers:
          getHeaders(progressive),

        type: "progressive",
      });

      continue;
    }

    // --------------------------------------------------------
    // CASE B:
    // No progressive MP4.
    //
    // Use MP4 video-only + separate audio.
    // Flutter will merge locally.
    // --------------------------------------------------------

    const videoOnly =
      pickBest(
        videoOnlyMp4,
        height
      );

    if (videoOnly && bestAudio) {
      qualities.push({
        id:
          `merged-${height}-` +
          `${videoOnly.format_id || "video"}`,

        label:
          `${height}p • Video + Audio`,

        height,

        width:
          Number(videoOnly.width) ||
          null,

        hasVideo: true,
        hasAudio: true,
        needsMerge: true,

        videoUrl: videoOnly.url,

        audioUrl: bestAudio.url,

        videoHeaders:
          getHeaders(videoOnly),

        audioHeaders:
          getHeaders(bestAudio),

        type: "separate",
      });

      continue;
    }

    // --------------------------------------------------------
    // CASE C:
    // Video exists but audio is unavailable.
    // --------------------------------------------------------

    if (videoOnly) {
      qualities.push({
        id:
          `video-only-${height}-` +
          `${videoOnly.format_id || "video"}`,

        label:
          `${height}p • No Audio`,

        height,

        width:
          Number(videoOnly.width) ||
          null,

        hasVideo: true,
        hasAudio: false,
        needsMerge: false,

        url: videoOnly.url,

        headers:
          getHeaders(videoOnly),

        audioUnavailable: true,

        type: "video-only",
      });
    }
  }

  // ==========================================================
  // PINTEREST MP4 PREFERENCE
  // ==========================================================

  if (platform === "pinterest") {
    qualities.sort((a, b) => {
      const aMp4 =
        a.type === "progressive" ||
        a.type === "video-only";

      const bMp4 =
        b.type === "progressive" ||
        b.type === "video-only";

      if (aMp4 !== bMp4) {
        return bMp4 ? 1 : -1;
      }

      return (
        (b.height || 0) -
        (a.height || 0)
      );
    });
  }

  return qualities.slice(0, 8);
}

// ============================================================
// RUN YT-DLP
// ============================================================

function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    const args = [
      "--dump-single-json",
      "--no-warnings",
      "--skip-download",
      "--no-playlist",
      "--no-check-certificates",
      "--no-cache-dir",

      "--user-agent",
      USER_AGENT,

      "--socket-timeout",
      "20",

      "--retries",
      "2",

      url,
    ];

    const child = spawn(
      YTDLP_PATH,
      args,
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on(
      "data",
      (chunk) => {
        stdout += chunk.toString();
      }
    );

    child.stderr.on(
      "data",
      (chunk) => {
        stderr += chunk.toString();
      }
    );

    const timeout =
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (_) {}

        reject(
          new Error(
            "Video extraction timed out."
          )
        );
      }, 60000);

    child.on(
      "error",
      (error) => {
        clearTimeout(timeout);

        reject(error);
      }
    );

    child.on(
      "close",
      (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          const message =
            stderr.trim() ||
            "yt-dlp extraction failed.";

          reject(
            new Error(message)
          );

          return;
        }

        try {
          const parsed =
            JSON.parse(stdout);

          resolve(parsed);
        } catch (error) {
          reject(
            new Error(
              "yt-dlp returned invalid JSON."
            )
          );
        }
      }
    );
  });
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "StreamBox Backend",
    extraction: "yt-dlp",
    mediaDownload: "client-side",
    serverProcessing: "none",
    ffmpeg: "client-side",
    status: "online",
  });
});

// ============================================================
// EXTRACTION API
// ============================================================

app.post(
  "/api/extract",
  async (req, res) => {
    try {
      const url =
        req.body?.url?.toString().trim();

      // ------------------------------------------------------
      // Validate URL
      // ------------------------------------------------------

      if (!url) {
        return res.status(400).json({
          success: false,
          error:
            "Video URL is required.",
        });
      }

      if (!isValidHttpUrl(url)) {
        return res.status(400).json({
          success: false,
          error:
            "Please enter a valid HTTP/HTTPS URL.",
        });
      }

      const platform =
        detectPlatform(url);

      console.log(
        `[EXTRACT] ${platform}: ${url}`
      );

      // ------------------------------------------------------
      // IMPORTANT:
      //
      // yt-dlp ONLY extracts metadata and direct URLs.
      //
      // No media is downloaded by Render.
      // ------------------------------------------------------

      const info =
        await runYtDlp(url);

      const qualities =
        buildQualities(
          info,
          platform
        );

      if (
        !qualities ||
        qualities.length === 0
      ) {
        return res.status(422).json({
          success: false,
          error:
            "No downloadable MP4 video was found. The video may use an unsupported stream or require authentication.",
        });
      }

      const title =
        info.title?.toString() ||
        "Video";

      const thumbnail =
        info.thumbnail
          ? info.thumbnail.toString()
          : null;

      // ------------------------------------------------------
      // RESPONSE
      //
      // Only JSON metadata + direct media URLs.
      // ------------------------------------------------------

      return res.json({
        success: true,

        platform,

        sourceUrl: url,

        title,

        thumbnail,

        qualities,
      });
    } catch (error) {
      console.error(
        "[EXTRACT ERROR]",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error?.message ||
          "Unable to extract video.",
      });
    }
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
// SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(
    `StreamBox backend running on port ${PORT}`
  );

  console.log(
    `yt-dlp path: ${YTDLP_PATH}`
  );

  console.log(
    "Server media download: DISABLED"
  );

  console.log(
    "Server FFmpeg: DISABLED"
  );

  console.log(
    "Client-side media download: ENABLED"
  );
});