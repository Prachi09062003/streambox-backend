const express = require("express");
const cors = require("cors");
const { spawn, execFile } = require("child_process");

const {
  igdl,
  ttdl,
  fbdown,
  pinterest,
  twitter,
} = require("btch-downloader");

const app = express();

// ======================================================
// CONFIGURATION
// ======================================================

const PORT = process.env.PORT || 3000;

const EXTRACTION_TIMEOUT = 90 * 1000;
const YTDLP_TIMEOUT = 120 * 1000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(cors());

app.use(
  express.json({
    limit: "1mb",
  })
);

// ======================================================
// BASIC HELPERS
// ======================================================

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);

    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:"
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

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);

    const removeParams = [
      "si",
      "igsh",
      "igshid",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
    ];

    for (const param of removeParams) {
      parsed.searchParams.delete(param);
    }

    if (
      parsed.hostname === "x.com" ||
      parsed.hostname === "www.x.com"
    ) {
      parsed.hostname = "twitter.com";
    }

    if (parsed.hostname === "mobile.twitter.com") {
      parsed.hostname = "twitter.com";
    }

    if (
      parsed.hostname === "m.facebook.com" ||
      parsed.hostname === "mbasic.facebook.com"
    ) {
      parsed.hostname = "www.facebook.com";
    }

    return parsed.href;
  } catch {
    return url;
  }
}

// ======================================================
// PLATFORM DETECTION
// ======================================================

function getPlatform(url) {
  const value = url.toLowerCase();

  if (
    value.includes("instagram.com") ||
    value.includes("instagr.am")
  ) {
    return "instagram";
  }

  if (
    value.includes("tiktok.com") ||
    value.includes("vm.tiktok.com") ||
    value.includes("vt.tiktok.com")
  ) {
    return "tiktok";
  }

  if (
    value.includes("facebook.com") ||
    value.includes("fb.watch")
  ) {
    return "facebook";
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

  if (
    value.includes("youtube.com") ||
    value.includes("youtu.be")
  ) {
    return "youtube";
  }

  return null;
}

// ======================================================
// REDIRECT RESOLVER
// ======================================================

async function resolveRedirectUrl(inputUrl) {
  let currentUrl = inputUrl;

  console.log(`[RESOLVE] Starting URL: ${currentUrl}`);

  for (let attempt = 0; attempt < 5; attempt++) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, 15000);

    try {
      const response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      clearTimeout(timer);

      if (
        response.status >= 300 &&
        response.status < 400
      ) {
        const location = response.headers.get("location");

        if (!location) {
          break;
        }

        currentUrl = new URL(location, currentUrl).href;

        console.log(
          `[RESOLVE] Redirect ${attempt + 1}: ${currentUrl}`
        );

        continue;
      }

      if (response.url && response.url !== currentUrl) {
        currentUrl = response.url;
      }

      break;
    } catch (error) {
      clearTimeout(timer);

      console.log(
        `[RESOLVE] Attempt ${attempt + 1} failed: ${error.message}`
      );

      break;
    }
  }

  return normalizeUrl(currentUrl);
}

// ======================================================
// URL PREPARATION
// ======================================================

async function prepareUrl(platform, inputUrl) {
  let url = normalizeUrl(inputUrl);

  if (
    platform === "pinterest" &&
    (url.includes("pin.it") || url.includes("pinterest.com"))
  ) {
    console.log("[PREPARE] Resolving Pinterest URL");

    const resolved = await resolveRedirectUrl(url);

    if (resolved) {
      url = resolved;
    }

    console.log(`[PREPARE] Pinterest URL: ${url}`);
  }

  if (
    platform === "facebook" &&
    (url.includes("/share/") || url.includes("fb.watch"))
  ) {
    console.log("[PREPARE] Resolving Facebook share URL");

    const resolved = await resolveRedirectUrl(url);

    if (resolved) {
      url = resolved;
    }

    console.log(`[PREPARE] Facebook URL: ${url}`);
  }

  if (platform === "youtube") {
    try {
      const parsed = new URL(url);

      if (parsed.hostname === "youtu.be") {
        const videoId = parsed.pathname
          .split("/")
          .filter(Boolean)[0];

        if (videoId) {
          url = `https://www.youtube.com/watch?v=${videoId}`;
        }
      } else if (
        parsed.pathname.startsWith("/shorts/")
      ) {
        const videoId = parsed.pathname
          .split("/")
          .filter(Boolean)[1];

        if (videoId) {
          url = `https://www.youtube.com/watch?v=${videoId}`;
        }
      } else if (
        parsed.pathname.startsWith("/embed/")
      ) {
        const videoId = parsed.pathname
          .split("/")
          .filter(Boolean)[1];

        if (videoId) {
          url = `https://www.youtube.com/watch?v=${videoId}`;
        }
      }

      console.log(`[PREPARE] YouTube URL: ${url}`);
    } catch {
      // Keep the original URL if parsing fails.
    }
  }

  return url;
}

// ======================================================
// MEDIA URL HELPERS
// ======================================================

function isLikelyMediaUrl(url) {
  if (!isValidHttpUrl(url)) {
    return false;
  }

  const lower = url.toLowerCase();

  return (
    lower.includes(".mp4") ||
    lower.includes(".m4v") ||
    lower.includes(".mov") ||
    lower.includes(".webm") ||
    lower.includes(".m3u8") ||
    lower.includes(".mpd") ||
    lower.includes("video") ||
    lower.includes("media") ||
    lower.includes("download") ||
    lower.includes("rapidcdn") ||
    lower.includes("cdn") ||
    lower.includes("stream")
  );
}

function isKnownMediaKey(key) {
  const normalized = key.toLowerCase();

  const exactKeys = [
    "url",
    "video_url",
    "videourl",
    "download",
    "download_url",
    "downloadurl",
    "media_url",
    "mediaurl",
    "source",
    "stream",
    "stream_url",
    "streamurl",
    "play",
    "play_url",
    "playurl",
    "file",
    "file_url",
    "fileurl",
  ];

  return exactKeys.includes(normalized);
}

function scoreMediaUrl(url) {
  if (typeof url !== "string") {
    return -1;
  }

  const lower = url.toLowerCase();

  let score = 0;

  if (lower.includes(".mp4")) score += 100;
  if (lower.includes(".m4v")) score += 90;
  if (lower.includes(".mov")) score += 80;
  if (lower.includes(".webm")) score += 70;
  if (lower.includes(".m3u8")) score += 50;
  if (lower.includes(".mpd")) score += 40;

  if (lower.includes("video")) score += 25;
  if (lower.includes("download")) score += 20;
  if (lower.includes("media")) score += 15;
  if (lower.includes("rapidcdn")) score += 15;
  if (lower.includes("cdn")) score += 10;

  return score;
}

// ======================================================
// RECURSIVE MEDIA URL EXTRACTION
// ======================================================

function extractAllMediaUrls(value, found = [], depth = 0) {
  if (
    value === null ||
    value === undefined ||
    depth > 15
  ) {
    return found;
  }

  if (typeof value === "string") {
    if (
      isValidHttpUrl(value) &&
      isLikelyMediaUrl(value) &&
      !found.includes(value)
    ) {
      found.push(value);
    }

    return found;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractAllMediaUrls(item, found, depth + 1);
    }

    return found;
  }

  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const knownMediaKey = isKnownMediaKey(key);

      if (
        knownMediaKey &&
        typeof item === "string" &&
        isValidHttpUrl(item) &&
        !found.includes(item)
      ) {
        // Trust direct media keys even when the URL
        // does not visibly contain ".mp4".
        found.push(item);
      }

      extractAllMediaUrls(item, found, depth + 1);
    }
  }

  return found;
}

function extractBestMediaUrl(result) {
  const urls = extractAllMediaUrls(result);

  if (urls.length === 0) {
    return null;
  }

  urls.sort((a, b) => {
    return scoreMediaUrl(b) - scoreMediaUrl(a);
  });

  console.log(`[MEDIA] Found ${urls.length} candidate URL(s)`);

  urls.slice(0, 5).forEach((url, index) => {
    console.log(
      `[MEDIA] Candidate ${index + 1}: score=${scoreMediaUrl(url)}`
    );
  });

  return urls[0];
}

// ======================================================
// SAFE DEBUGGING
// ======================================================

function summarizeObject(value, depth = 0) {
  if (depth > 3) {
    return "[nested object]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    if (isValidHttpUrl(value)) {
      return "[URL]";
    }

    return value.length > 200
      ? `${value.substring(0, 200)}...`
      : value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      first:
        value.length > 0
          ? summarizeObject(value[0], depth + 1)
          : null,
    };
  }

  const output = {};

  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === "string" &&
      isValidHttpUrl(item)
    ) {
      output[key] = "[URL]";
    } else if (typeof item === "string") {
      output[key] =
        item.length > 200
          ? `${item.substring(0, 200)}...`
          : item;
    } else if (
      typeof item === "object" &&
      item !== null
    ) {
      output[key] = summarizeObject(item, depth + 1);
    } else {
      output[key] = item;
    }
  }

  return output;
}

function makeSafeDebug(result) {
  return summarizeObject(result);
}

// ======================================================
// TIMEOUT WRAPPER
// ======================================================

async function withTimeout(promise, timeoutMs) {
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Operation timed out after ${Math.round(
            timeoutMs / 1000
          )} seconds`
        )
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      promise,
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ======================================================
// BTCH-DOWNLOADER EXTRACTOR
// ======================================================

async function runBtchExtractor(platform, url) {
  switch (platform) {
    case "instagram":
      console.log("[EXTRACTOR] Instagram -> igdl()");
      return await igdl(url);

    case "tiktok":
      console.log("[EXTRACTOR] TikTok -> ttdl()");
      return await ttdl(url);

    case "facebook":
      console.log("[EXTRACTOR] Facebook -> fbdown()");
      return await fbdown(url);

    case "pinterest":
      console.log("[EXTRACTOR] Pinterest -> pinterest()");
      return await pinterest(url);

    case "twitter":
      console.log("[EXTRACTOR] Twitter/X -> twitter()");
      return await twitter(url);

    default:
      throw new Error(
        `btch-downloader does not handle platform: ${platform}`
      );
  }
}

// ======================================================
// YT-DLP HELPERS
// ======================================================

async function withTimeout(
  promise,
  timeoutMs
) {

  let timer;

  const timeout =
    new Promise(
      (_, reject) => {

        timer =
          setTimeout(
            () => {

              reject(
                new Error(
                  `Extraction timed out after ${Math.round(timeoutMs / 1000)} seconds`
                )
              );

            },
            timeoutMs
          );
      }
    );

  try {

    return await Promise.race([
      promise,
      timeout
    ]);

  } finally {

    clearTimeout(timer);
  }
}

// ======================================================
// SAFE DEBUG RESULT
// ======================================================

function makeSafeDebug(
  result
) {

  if (
    result === null ||
    result === undefined
  ) {
    return null;
  }

  if (!metadata) {
    throw new Error("yt-dlp returned empty metadata");
  }

  const directUrl = extractBestMediaUrl(metadata);

  if (directUrl) {
    return {
      mediaUrl: directUrl,
      title: metadata.title || "YouTube video",
      duration: metadata.duration || null,
      thumbnail: metadata.thumbnail || null,
      width: metadata.width || null,
      height: metadata.height || null,
    };
  }

  if (
    metadata.url &&
    isValidHttpUrl(metadata.url)
  ) {
    return {
      mediaUrl: metadata.url,
      title: metadata.title || "YouTube video",
      duration: metadata.duration || null,
      thumbnail: metadata.thumbnail || null,
      width: metadata.width || null,
      height: metadata.height || null,
    };
  }

  if (
    Array.isArray(metadata.formats) &&
    metadata.formats.length > 0
  ) {
    const formats = metadata.formats
      .filter(
        (format) =>
          format &&
          typeof format.url === "string" &&
          isValidHttpUrl(format.url)
      )
      .filter(
        (format) =>
          format.vcodec &&
          format.vcodec !== "none"
      )
      .sort((a, b) => {
        return (
          Number(b.height || 0) -
          Number(a.height || 0)
        );
      });

    if (formats.length > 0) {
      return {
        mediaUrl: formats[0].url,
        title: metadata.title || "YouTube video",
        duration: metadata.duration || null,
        thumbnail: metadata.thumbnail || null,
        width: formats[0].width || null,
        height: formats[0].height || null,
      };
    }
  }

  throw new Error(
    "yt-dlp did not return a downloadable media URL"
  );
}

// ======================================================
// PLATFORM EXTRACTION
// ======================================================

async function extractPlatformMedia(platform, url) {
  if (platform === "youtube") {
    return await extractYouTubeWithYtDlp(url);
  }

  const result = await withTimeout(
    runBtchExtractor(platform, url),
    EXTRACTION_TIMEOUT
  );

  console.log(
    `[RESULT] ${platform} response type: ${
      Array.isArray(result)
        ? "array"
        : typeof result
    }`
  );

  if (
    result &&
    typeof result === "object"
  ) {
    console.log(
      `[RESULT] ${platform} response keys:`,
      Object.keys(result)
    );
  }

  const mediaUrl = extractBestMediaUrl(result);

  if (mediaUrl) {
    return {
      mediaUrl,
      raw: result,
    };
  }

  // Pinterest may return a valid image without a video.
  if (platform === "pinterest") {
    const imageUrl =
      findFirstUrlByKeys(result, [
        "image",
        "image_url",
        "imageUrl",
        "thumbnail",
      ]);

    const videoUrl =
      findFirstUrlByKeys(result, [
        "video_url",
        "videoUrl",
        "video",
        "videos",
      ]);

    if (imageUrl && !videoUrl) {
      const error = new Error(
        "This Pinterest Pin contains an image, not a video."
      );

      error.code = "IMAGE_ONLY";
      throw error;
    }
  }

  const error = new Error(
    "No downloadable media URL found"
  );

  error.code = "NO_MEDIA_URL";
  error.raw = result;

  throw error;
}

function findFirstUrlByKeys(value, keys, depth = 0) {
  if (
    value === null ||
    value === undefined ||
    depth > 15
  ) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstUrlByKeys(
        item,
        keys,
        depth + 1
      );

      if (found) {
        return found;
      }
    }

    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  for (const [key, item] of Object.entries(value)) {
    if (
      keys.includes(key.toLowerCase()) &&
      typeof item === "string" &&
      isValidHttpUrl(item)
    ) {
      return item;
    }

    const nested = findFirstUrlByKeys(
      item,
      keys,
      depth + 1
    );

    if (nested) {
      return nested;
    }
  }

  return null;
}

// ======================================================
// ROUTES
// ======================================================

app.post(
  '/api/extract',
  async (req, res) => {

    const started =
      Date.now();

    try {

      // ==================================================
      // 1. Validate body
      // ==================================================

      const body =
        req.body || {};

      const rawUrl =
        body.url;

      if (
        !rawUrl
      ) {

        return res.status(400).json({
          success: false,
          error: 'URL is required'
        });
      }

    if (typeof rawUrl !== "string") {
      return res.status(400).json({
        success: false,
        code: "INVALID_URL_TYPE",
        error: "URL must be a string",
      });
    }

    const inputUrl = cleanInputUrl(rawUrl);

    if (!inputUrl) {
      return res.status(400).json({
        success: false,
        code: "EMPTY_URL",
        error: "URL cannot be empty",
      });
    }

    if (!isValidHttpUrl(inputUrl)) {
      return res.status(400).json({
        success: false,
        code: "INVALID_URL",
        error: "Invalid HTTP/HTTPS URL",
      });
    }

    const platform = getPlatform(inputUrl);

    console.log("");
    console.log("================================================");
    console.log(`[REQUEST] ${inputUrl}`);
    console.log(`[REQUEST] Platform: ${platform || "unknown"}`);
    console.log("================================================");

    if (!platform) {
      return res.status(400).json({
        success: false,
        code: "UNSUPPORTED_PLATFORM",
        error: "Unsupported platform",
        supportedPlatforms: [
          "Instagram",
          "TikTok",
          "Facebook",
          "Pinterest",
          "Twitter/X",
          "YouTube",
        ],
      });
    }

    const preparedUrl = await prepareUrl(
      platform,
      inputUrl
    );

    console.log(
      `[REQUEST] Prepared URL: ${preparedUrl}`
    );

    let extracted;

    try {
      extracted = await extractPlatformMedia(
        platform,
        preparedUrl
      );
    } catch (error) {
      console.error(
        `[EXTRACTION ERROR] ${platform}:`,
        error.message
      );

      if (error.code === "IMAGE_ONLY") {
        return res.status(422).json({
          success: false,
          code: "IMAGE_ONLY",
          platform,
          error: error.message,
          sourceUrl: inputUrl,
          preparedUrl,
        });
      }

      const message = error.message || "";

      let code = error.code || "EXTRACTOR_FAILED";

      if (
        message.toLowerCase().includes("private") ||
        message.toLowerCase().includes("login") ||
        message.toLowerCase().includes("sign in")
      ) {
        code = "PRIVATE_CONTENT";
      }

      if (
        message.toLowerCase().includes("not found") ||
        message.toLowerCase().includes("deleted") ||
        message.toLowerCase().includes("unavailable")
      ) {
        code = "VIDEO_NOT_FOUND";
      }

      return res.status(502).json({
        success: false,
        code,
        platform,
        error: message || "Platform extraction failed",
        message:
          "The content may be private, deleted, restricted, expired, unsupported, or the platform extractor may need an update.",
        sourceUrl: inputUrl,
        preparedUrl,
      });
    }

    const mediaUrl = extracted.mediaUrl;

    if (
      !mediaUrl ||
      !isValidHttpUrl(mediaUrl)
    ) {
      return res.status(502).json({
        success: false,
        code: "INVALID_MEDIA_URL",
        platform,
        error: "Extractor returned an invalid media URL",
      });
    }

    const duration = Date.now() - started;

    console.log(
      `[SUCCESS] ${platform} extracted in ${duration}ms`
    );

    console.log("================================================");

    return res.status(200).json({
      success: true,
      platform,
      resolutions: {
        "720p": mediaUrl,
      },
      mediaUrl,
      sourceUrl: inputUrl,
      processingTimeMs: duration,
      title: extracted.title || null,
      thumbnail: extracted.thumbnail || null,
      duration: extracted.duration || null,
      width: extracted.width || null,
      height: extracted.height || null,
    });
  } catch (error) {
    console.error("[SERVER ERROR]", error);

    return res.status(500).json({
      success: false,
      code: "INTERNAL_SERVER_ERROR",
      error: error.message || "Internal server error",
    });
  }
});

// ======================================================
// 404 HANDLER
// ======================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    code: "ENDPOINT_NOT_FOUND",
    error: "Endpoint not found",
    path: req.path,
    method: req.method,
  });
});

// ======================================================
// GLOBAL ERROR HANDLER
// ======================================================

app.use((err, req, res, next) => {
  console.error("[GLOBAL ERROR]", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    success: false,
    code: "INTERNAL_SERVER_ERROR",
    error: "Internal server error",
  });
});

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log('');
    console.log(
      '================================================'
    );

    console.log(
      '       STREAMBOX BACKEND v3.0.0'
    );

    console.log(
      '================================================'
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Node: ${process.version}`
    );

    console.log(
      `Environment: ${
        process.env.NODE_ENV ||
        'production'
      }`
    );

    console.log(
      'Supported platforms:'
    );

    console.log(
      '✓ Instagram'
    );

    console.log(
      '✓ TikTok'
    );

    console.log(
      '✓ Facebook'
    );

    console.log(
      '✓ Pinterest'
    );

    console.log(
      '✓ Twitter/X'
    );

    console.log(
      '✓ YouTube'
    );

    console.log(
      '================================================'
    );

    console.log('');
  }
);
