const express = require("express");

const {
  igdl,
  ttdl,
  fbdown,
  twitter,
  youtube,
  pinterest,
} = require("btch-downloader");

const app = express();

app.use(express.json({ limit: "1mb" }));

// ======================================================
// CONFIG
// ======================================================

const PORT = process.env.PORT || 3000;

// ======================================================
// BASIC ROUTES
// ======================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "StreamBox Backend",
    status: "online",
    version: "2.1.0",
    supportedPlatforms: [
      "instagram",
      "tiktok",
      "facebook",
      "twitter",
      "youtube",
      "pinterest",
    ],
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    timestamp: new Date().toISOString(),
    node: process.version,
  });
});

// ======================================================
// URL VALIDATION
// ======================================================

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

// ======================================================
// YOUTUBE HELPERS
// ======================================================

function extractYoutubeId(input) {
  try {
    const url = new URL(input);

    const hostname = url.hostname.toLowerCase();

    // youtu.be/VIDEO_ID
    if (hostname === "youtu.be") {
      const id = url.pathname
        .split("/")
        .filter(Boolean)[0];

      return id || null;
    }

    // youtube.com
    const pathnameParts = url.pathname
      .split("/")
      .filter(Boolean);

    // /watch?v=
    const watchId = url.searchParams.get("v");

    if (watchId) {
      return watchId;
    }

    // /shorts/VIDEO_ID
    if (
      pathnameParts[0] === "shorts" &&
      pathnameParts[1]
    ) {
      return pathnameParts[1];
    }

    // /embed/VIDEO_ID
    if (
      pathnameParts[0] === "embed" &&
      pathnameParts[1]
    ) {
      return pathnameParts[1];
    }

    // /live/VIDEO_ID
    if (
      pathnameParts[0] === "live" &&
      pathnameParts[1]
    ) {
      return pathnameParts[1];
    }

    return null;
  } catch {
    return null;
  }
}

// ======================================================
// CLEAN URL
// ======================================================

function cleanUrl(input) {
  try {
    const url = new URL(input.trim());

    const hostname =
      url.hostname.toLowerCase();

    // --------------------------------------------------
    // YouTube
    // --------------------------------------------------

    if (
      hostname.includes("youtube.com") ||
      hostname === "youtu.be"
    ) {
      const videoId =
        extractYoutubeId(input);

      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }

    // --------------------------------------------------
    // Other platforms
    // --------------------------------------------------

    return url.toString();
  } catch {
    return input.trim();
  }
}

// ======================================================
// PLATFORM DETECTION
// ======================================================

function detectPlatform(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const hostname =
    url.hostname.toLowerCase();

  // Instagram
  if (
    hostname === "instagram.com" ||
    hostname.endsWith(".instagram.com") ||
    hostname === "instagr.am" ||
    hostname.endsWith(".instagr.am")
  ) {
    return "instagram";
  }

  // TikTok
  if (
    hostname === "tiktok.com" ||
    hostname.endsWith(".tiktok.com") ||
    hostname === "vm.tiktok.com" ||
    hostname === "vt.tiktok.com"
  ) {
    return "tiktok";
  }

  // Facebook
  if (
    hostname === "facebook.com" ||
    hostname.endsWith(".facebook.com") ||
    hostname === "fb.watch"
  ) {
    return "facebook";
  }

  // Twitter / X
  if (
    hostname === "twitter.com" ||
    hostname.endsWith(".twitter.com") ||
    hostname === "x.com" ||
    hostname.endsWith(".x.com")
  ) {
    return "twitter";
  }

  // YouTube
  if (
    hostname === "youtube.com" ||
    hostname.endsWith(".youtube.com") ||
    hostname === "youtu.be"
  ) {
    return "youtube";
  }

  // Pinterest
  if (
    hostname === "pinterest.com" ||
    hostname.endsWith(".pinterest.com") ||
    hostname === "pin.it"
  ) {
    return "pinterest";
  }

  return null;
}

// ======================================================
// SHORT URL RESOLVER
// ======================================================

async function resolveRedirectUrl(inputUrl) {
  let hostname;

  try {
    hostname =
      new URL(inputUrl).hostname.toLowerCase();
  } catch {
    return inputUrl;
  }

  const shouldResolve =
    hostname === "pin.it" ||
    hostname === "fb.watch" ||
    inputUrl.includes("/share/");

  if (!shouldResolve) {
    return inputUrl;
  }

  console.log(
    "Resolving short/share URL:",
    inputUrl
  );

  const controller =
    new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 15000);

  try {
    const response = await fetch(
      inputUrl,
      {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,

        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",

          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

          "Accept-Language":
            "en-US,en;q=0.9",
        },
      }
    );

    console.log(
      "Resolved URL:",
      response.url
    );

    if (
      response.url &&
      isValidHttpUrl(response.url)
    ) {
      return response.url;
    }

    return inputUrl;
  } catch (error) {
    console.log(
      "Redirect resolution failed:",
      error.message
    );

    return inputUrl;
  } finally {
    clearTimeout(timeout);
  }
}

// ======================================================
// DOWNLOADER SELECTION
// ======================================================

function getDownloader(platform) {
  switch (platform) {
    case "instagram":
      return igdl;

    case "tiktok":
      return ttdl;

    case "facebook":
      return fbdown;

    case "twitter":
      return twitter;

    case "youtube":
      return youtube;

    case "pinterest":
      return pinterest;

    default:
      return null;
  }
}

// ======================================================
// MEDIA URL HELPERS
// ======================================================

const MEDIA_EXTENSIONS = [
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".flv",
  ".3gp",
  ".m3u8",
  ".ts",
];

function looksLikeMediaUrl(value) {
  if (typeof value !== "string") {
    return false;
  }

  if (!isValidHttpUrl(value)) {
    return false;
  }

  const lower =
    value.toLowerCase();

  // Direct extension
  if (
    MEDIA_EXTENSIONS.some(
      (extension) =>
        lower.includes(extension)
    )
  ) {
    return true;
  }

  // Known CDN/download services
  const knownMediaHosts = [
    "rapidcdn.app",
    "cdninstagram.com",
    "fbcdn.net",
    "fbsbx.com",
    "tiktokcdn.com",
    "tiktokv.com",
    "pinimg.com",
    "twimg.com",
    "googlevideo.com",
    "ytimg.com",
  ];

  try {
    const hostname =
      new URL(value)
        .hostname
        .toLowerCase();

    if (
      knownMediaHosts.some(
        (host) =>
          hostname === host ||
          hostname.endsWith(`.${host}`)
      )
    ) {
      return true;
    }
  } catch {}

  const mediaPatterns = [
    "videoplayback",
    "video/",
    "/video",
    "media/",
    "/media",
    "download",
    "stream",
    "mime=video",
    "mime%3dvideo",
    "mime%3d%76%69%64%65%6f",
  ];

  return mediaPatterns.some(
    (pattern) =>
      lower.includes(pattern)
  );
}

// ======================================================
// DIRECT MEDIA FIELD CHECK
// ======================================================

const DIRECT_MEDIA_KEYS = [
  "url",
  "video_url",
  "videoUrl",
  "video",
  "download",
  "downloadUrl",
  "download_url",
  "media",
  "mediaUrl",
  "media_url",
  "play",
  "playUrl",
  "play_url",
  "hd",
  "hdUrl",
  "hd_url",
  "sd",
  "sdUrl",
  "sd_url",
  "nowm",
  "nowmUrl",
  "nowm_url",
];

function isDirectMediaKey(key) {
  const normalized =
    key
      .toLowerCase()
      .replace(/[-_]/g, "");

  return DIRECT_MEDIA_KEYS.some(
    (item) =>
      item
        .toLowerCase()
        .replace(/[-_]/g, "") ===
      normalized
  );
}

// ======================================================
// RECURSIVE MEDIA EXTRACTION
// ======================================================

function collectMediaUrls(
  value,
  results = [],
  path = "",
  trusted = false
) {
  if (
    value === null ||
    value === undefined
  ) {
    return results;
  }

  // ----------------------------------------------------
  // String
  // ----------------------------------------------------

  if (typeof value === "string") {
    if (
      isValidHttpUrl(value) &&
      (trusted ||
        looksLikeMediaUrl(value))
    ) {
      results.push({
        url: value,
        path,
        trusted,
      });
    }

    return results;
  }

  // ----------------------------------------------------
  // Array
  // ----------------------------------------------------

  if (Array.isArray(value)) {
    for (
      let i = 0;
      i < value.length;
      i++
    ) {
      collectMediaUrls(
        value[i],
        results,
        `${path}[${i}]`,
        trusted
      );
    }

    return results;
  }

  // ----------------------------------------------------
  // Object
  // ----------------------------------------------------

  if (
    typeof value === "object"
  ) {
    for (
      const [key, child] of
      Object.entries(value)
    ) {
      const childPath =
        path
          ? `${path}.${key}`
          : key;

      const priority =
        isDirectMediaKey(key);

      // Direct media fields are trusted.
      if (
        priority &&
        typeof child === "string" &&
        isValidHttpUrl(child)
      ) {
        results.unshift({
          url: child,
          path: childPath,
          trusted: true,
        });

        continue;
      }

      // Recursively inspect everything else.
      collectMediaUrls(
        child,
        results,
        childPath,
        trusted
      );
    }
  }

  return results;
}

// ======================================================
// FIND PINTEREST VIDEO
// ======================================================

function findPinterestVideo(data) {
  const candidates = [];

  function walk(value) {
    if (
      value === null ||
      value === undefined
    ) {
      return;
    }

    if (
      typeof value === "string"
    ) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }

      return;
    }

    if (
      typeof value === "object"
    ) {
      for (
        const [key, child] of
        Object.entries(value)
      ) {
        const keyLower =
          key.toLowerCase();

        if (
          (
            keyLower.includes("video") ||
            keyLower.includes("download") ||
            keyLower === "url"
          ) &&
          typeof child === "string" &&
          isValidHttpUrl(child)
        ) {
          candidates.push(child);
        }

        walk(child);
      }
    }
  }

  walk(data);

  const unique =
    [...new Set(candidates)];

  return unique.find(
    (url) =>
      looksLikeMediaUrl(url) ||
      url.includes(
        "rapidcdn.app"
      ) ||
      url.includes(
        "video"
      )
  ) || null;
}

// ======================================================
// NORMALIZE RESPONSE
// ======================================================

function normalizeMediaResponse(
  data,
  platform
) {
  const resolutions = {};

  // ----------------------------------------------------
  // Unwrap nested result wrappers
  // ----------------------------------------------------

  let payload = data;

  for (
    let i = 0;
    i < 5;
    i++
  ) {
    if (
      payload &&
      typeof payload === "object" &&
      payload.result &&
      typeof payload.result === "object"
    ) {
      payload = payload.result;
    } else {
      break;
    }
  }

  console.log(
    "Normalized payload type:",
    Array.isArray(payload)
      ? "array"
      : typeof payload
  );

  // ----------------------------------------------------
  // Existing resolutions
  // ----------------------------------------------------

  if (
    payload &&
    typeof payload === "object" &&
    payload.resolutions &&
    typeof payload.resolutions === "object"
  ) {
    for (
      const [quality, value]
      of Object.entries(
        payload.resolutions
      )
    ) {
      if (
        typeof value === "string" &&
        isValidHttpUrl(value)
      ) {
        resolutions[quality] =
          value;
      }
    }
  }

  // ----------------------------------------------------
  // Recursive extraction
  // ----------------------------------------------------

  const found =
    collectMediaUrls(payload);

  // ----------------------------------------------------
  // Add URLs
  // ----------------------------------------------------

  for (const item of found) {
    const url = item.url;

    if (
      !url ||
      Object.values(
        resolutions
      ).includes(url)
    ) {
      continue;
    }

    const lower =
      url.toLowerCase();

    // HD
    if (
      lower.includes("2160") ||
      lower.includes("1440") ||
      lower.includes("1080") ||
      lower.includes("hd")
    ) {
      if (
        !resolutions["1080p"]
      ) {
        resolutions["1080p"] =
          url;
      }

      continue;
    }

    // 720
    if (
      lower.includes("720")
    ) {
      if (
        !resolutions["720p"]
      ) {
        resolutions["720p"] =
          url;
      }

      continue;
    }

    // 480
    if (
      lower.includes("480")
    ) {
      if (
        !resolutions["480p"]
      ) {
        resolutions["480p"] =
          url;
      }

      continue;
    }

    // 360
    if (
      lower.includes("360")
    ) {
      if (
        !resolutions["360p"]
      ) {
        resolutions["360p"] =
          url;
      }

      continue;
    }

    // Generic
    if (
      !resolutions["auto"]
    ) {
      resolutions["auto"] =
        url;
    }
  }

  // ----------------------------------------------------
  // Pinterest-specific handling
  // ----------------------------------------------------

  if (
    platform === "pinterest"
  ) {
    const pinterestVideo =
      findPinterestVideo(
        payload
      );

    if (
      pinterestVideo &&
      !Object.values(
        resolutions
      ).includes(
        pinterestVideo
      )
    ) {
      resolutions["auto"] =
        pinterestVideo;
    }
  }

  // ----------------------------------------------------
  // Remove duplicates
  // ----------------------------------------------------

  const unique = {};

  for (
    const [quality, url]
    of Object.entries(
      resolutions
    )
  ) {
    if (
      url &&
      !Object.values(
        unique
      ).includes(url)
    ) {
      unique[quality] =
        url;
    }
  }

  // ----------------------------------------------------
  // Sort
  // ----------------------------------------------------

  const qualityOrder = [
    "2160p",
    "1440p",
    "1080p",
    "720p",
    "480p",
    "360p",
    "240p",
    "auto",
  ];

  const sorted = {};

  for (
    const quality
    of qualityOrder
  ) {
    if (
      unique[quality]
    ) {
      sorted[quality] =
        unique[quality];
    }
  }

  for (
    const [quality, url]
    of Object.entries(unique)
  ) {
    if (
      !sorted[quality]
    ) {
      sorted[quality] =
        url;
    }
  }

  return {
    success:
      Object.keys(sorted)
        .length > 0,

    platform,

    resolutions:
      sorted,
  };
}

// ======================================================
// PINTEREST IMAGE-ONLY DETECTION
// ======================================================

function isPinterestImageOnly(
  data
) {
  let payload = data;

  for (
    let i = 0;
    i < 5;
    i++
  ) {
    if (
      payload &&
      typeof payload === "object" &&
      payload.result &&
      typeof payload.result === "object"
    ) {
      payload = payload.result;
    } else {
      break;
    }
  }

  if (
    Array.isArray(payload)
  ) {
    payload =
      payload[0];
  }

  if (
    !payload ||
    typeof payload !== "object"
  ) {
    return false;
  }

  const videoUrl =
    payload.video_url ??
    payload.videoUrl;

  const videos =
    payload.videos;

  const hasVideoUrl =
    typeof videoUrl === "string" &&
    videoUrl.trim().length > 0;

  const hasVideos =
    videos &&
    typeof videos === "object" &&
    Object.keys(videos).length > 0;

  const hasImage =
    typeof payload.image ===
      "string" ||
    (
      payload.images &&
      typeof payload.images ===
        "object"
    );

  return (
    !hasVideoUrl &&
    !hasVideos &&
    hasImage
  );
}

// ======================================================
// EXTRACT API
// ======================================================

app.post(
  "/api/extract",
  async (req, res) => {
    const startedAt =
      Date.now();

    try {
      // ------------------------------------------------
      // Read URL
      // ------------------------------------------------

      const originalUrl =
        typeof req.body?.url ===
          "string"
          ? req.body.url.trim()
          : "";

      // ------------------------------------------------
      // Validate
      // ------------------------------------------------

      if (!originalUrl) {
        return res.status(400).json({
          success: false,
          error:
            "URL is required.",
        });
      }

      if (
        !isValidHttpUrl(
          originalUrl
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Please provide a valid HTTP/HTTPS URL.",
        });
      }

      console.log(
        "\n========================================"
      );

      console.log(
        "NEW EXTRACTION REQUEST"
      );

      console.log(
        "URL:",
        originalUrl
      );

      console.log(
        "========================================"
      );

      // ------------------------------------------------
      // Detect platform
      // ------------------------------------------------

      let platform =
        detectPlatform(
          originalUrl
        );

      if (!platform) {
        return res.status(400).json({
          success: false,
          error:
            "Unsupported platform. Supported platforms are Instagram, TikTok, Facebook, X/Twitter, YouTube and Pinterest.",
        });
      }

      console.log(
        "Detected platform:",
        platform
      );

      // ------------------------------------------------
      // Clean URL
      // ------------------------------------------------

      let workingUrl =
        cleanUrl(
          originalUrl
        );

      console.log(
        "Clean URL:",
        workingUrl
      );

      // ------------------------------------------------
      // Resolve short URLs
      // ------------------------------------------------

      try {
        const resolved =
          await resolveRedirectUrl(
            workingUrl
          );

        if (
          resolved &&
          resolved !== workingUrl
        ) {
          workingUrl =
            resolved;

          const detectedAfterRedirect =
            detectPlatform(
              workingUrl
            );

          if (
            detectedAfterRedirect
          ) {
            platform =
              detectedAfterRedirect;
          }

          console.log(
            "Platform after redirect:",
            platform
          );
        }
      } catch (error) {
        console.log(
          "Redirect resolution skipped:",
          error.message
        );
      }

      // ------------------------------------------------
      // Downloader
      // ------------------------------------------------

      const downloader =
        getDownloader(
          platform
        );

      if (!downloader) {
        return res.status(400).json({
          success: false,
          error:
            "Downloader is not available for this platform.",
        });
      }

      console.log(
        `Calling ${platform} downloader...`
      );

      // ------------------------------------------------
      // Execute downloader
      // ------------------------------------------------

      let result;

      try {
        result =
          await downloader(
            workingUrl
          );
      } catch (error) {
        console.error(
          `${platform} downloader error:`,
          error
        );

        return res.status(502).json({
          success: false,
          platform,
          error:
            "The media extractor could not process this URL.",
          details:
            error?.message ||
            "Unknown extractor error.",
        });
      }

      // ------------------------------------------------
      // Debug
      // ------------------------------------------------

      console.log(
        `${platform} raw response type:`,
        typeof result
      );

      if (
        result &&
        typeof result === "object"
      ) {
        console.log(
          `${platform} response keys:`,
          Object.keys(result)
        );
      }

      // ------------------------------------------------
      // Pinterest image-only
      // ------------------------------------------------

      if (
        platform ===
          "pinterest" &&
        isPinterestImageOnly(
          result
        )
      ) {
        console.log(
          "Pinterest result is IMAGE ONLY."
        );

        return res.status(422).json({
          success: false,
          platform,
          error:
            "This Pinterest Pin contains an image, not a video.",
          mediaType:
            "image",
        });
      }

      // ------------------------------------------------
      // Normalize
      // ------------------------------------------------

      const normalized =
        normalizeMediaResponse(
          result,
          platform
        );

      // ------------------------------------------------
      // No media
      // ------------------------------------------------

      if (
        !normalized.success ||
        Object.keys(
          normalized.resolutions
        ).length === 0
      ) {
        console.error(
          "NO MEDIA URL FOUND"
        );

        console.error(
          "Raw downloader response:",
          JSON.stringify(
            result,
            null,
            2
          ).slice(
            0,
            10000
          )
        );

        return res.status(422).json({
          success: false,
          platform,
          error:
            "No downloadable video URL was found for this post.",
          hint:
            "Make sure the post/video is public and contains a supported video.",
        });
      }

      // ------------------------------------------------
      // Success
      // ------------------------------------------------

      console.log(
        "Found resolutions:",
        Object.keys(
          normalized.resolutions
        )
      );

      console.log(
        "Extraction time:",
        `${Date.now() - startedAt}ms`
      );

      console.log(
        "========================================\n"
      );

      return res.json({
        success: true,
        platform,
        sourceUrl:
          originalUrl,
        resolvedUrl:
          workingUrl,
        resolutions:
          normalized.resolutions,
      });
    } catch (error) {
      console.error(
        "UNEXPECTED SERVER ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Internal server error.",
        details:
          error?.message ||
          "Unknown error.",
      });
    }
  }
);

// ======================================================
// 404
// ======================================================

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      error:
        "Endpoint not found.",
    });
  }
);

// ======================================================
// GLOBAL ERROR HANDLER
// ======================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "GLOBAL ERROR:",
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      success: false,
      error:
        "Internal server error.",
    });
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  () => {
    console.log(
      `StreamBox Backend running on port ${PORT}`
    );

    console.log(
      `Node version: ${process.version}`
    );
  }
);
