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
    version: "2.0.0",
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
  });
});

// ======================================================
// URL HELPERS
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

// Remove unnecessary tracking parameters
function cleanUrl(input) {
  try {
    const url = new URL(input.trim());

    // YouTube
    if (
      url.hostname.includes("youtube.com") ||
      url.hostname.includes("youtu.be")
    ) {
      const videoId =
        url.searchParams.get("v") ||
        extractYoutubeId(url.pathname);

      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }

    return url.toString();
  } catch {
    return input.trim();
  }
}

function extractYoutubeId(pathname) {
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  // /shorts/VIDEO_ID
  if (parts[0] === "shorts" && parts[1]) {
    return parts[1];
  }

  // /embed/VIDEO_ID
  if (parts[0] === "embed" && parts[1]) {
    return parts[1];
  }

  // youtu.be/VIDEO_ID
  if (parts[0]) {
    return parts[0];
  }

  return null;
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

  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();

  // Instagram
  if (
    hostname.includes("instagram.com") ||
    hostname.includes("instagr.am")
  ) {
    return "instagram";
  }

  // TikTok
  if (
    hostname.includes("tiktok.com") ||
    hostname === "vm.tiktok.com" ||
    hostname === "vt.tiktok.com"
  ) {
    return "tiktok";
  }

  // Facebook
  if (
    hostname.includes("facebook.com") ||
    hostname === "fb.watch" ||
    hostname.endsWith(".facebook.com")
  ) {
    return "facebook";
  }

  // X / Twitter
  if (
    hostname === "x.com" ||
    hostname.endsWith(".x.com") ||
    hostname === "twitter.com" ||
    hostname.endsWith(".twitter.com")
  ) {
    return "twitter";
  }

  // YouTube
  if (
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname.endsWith(".youtube.com") ||
    hostname === "youtu.be"
  ) {
    return "youtube";
  }

  // Pinterest
  if (
    hostname === "pinterest.com" ||
    hostname === "www.pinterest.com" ||
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
  const hostname = new URL(inputUrl).hostname.toLowerCase();

  // Only resolve known short/share URLs.
  const shouldResolve =
    hostname === "pin.it" ||
    hostname === "fb.watch" ||
    inputUrl.includes("/share/");

  if (!shouldResolve) {
    return inputUrl;
  }

  console.log("Resolving short/share URL:", inputUrl);

  try {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 15000);

    const response = await fetch(inputUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    clearTimeout(timeout);

    console.log("Resolved URL:", response.url);

    if (response.url && isValidHttpUrl(response.url)) {
      return response.url;
    }

    return inputUrl;
  } catch (error) {
    console.log(
      "Redirect resolution failed:",
      error.message
    );

    return inputUrl;
  }
}

// ======================================================
// DOWNLOADER FUNCTIONS
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
// MEDIA URL DETECTION
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

  const lower = value.toLowerCase();

  // Direct media extension
  if (
    MEDIA_EXTENSIONS.some((extension) =>
      lower.includes(extension)
    )
  ) {
    return true;
  }

  // Common CDN/media URL patterns
  const mediaPatterns = [
    "video",
    "videoplayback",
    "media",
    "download",
    "stream",
    "mp4",
    "m3u8",
    "mime=video",
    "mime%3dvideo",
    "mime%3Dvideo",
  ];

  return mediaPatterns.some((pattern) =>
    lower.includes(pattern)
  );
}

// ======================================================
// RECURSIVE RESPONSE PARSER
// ======================================================

function collectMediaUrls(value, results = [], path = "") {
  if (value === null || value === undefined) {
    return results;
  }

  // String
  if (typeof value === "string") {
    if (looksLikeMediaUrl(value)) {
      results.push({
        url: value,
        path,
      });
    }

    return results;
  }

  // Array
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      collectMediaUrls(
        value[i],
        results,
        `${path}[${i}]`
      );
    }

    return results;
  }

  // Object
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path
        ? `${path}.${key}`
        : key;

      // Prioritize media-looking keys
      const keyLower = key.toLowerCase();

      const isPriorityKey =
        keyLower.includes("video") ||
        keyLower.includes("media") ||
        keyLower.includes("download") ||
        keyLower.includes("stream") ||
        keyLower.includes("play") ||
        keyLower.includes("hd") ||
        keyLower.includes("sd") ||
        keyLower === "url" ||
        keyLower === "link";

      if (
        isPriorityKey &&
        typeof child === "string" &&
        looksLikeMediaUrl(child)
      ) {
        results.unshift({
          url: child,
          path: childPath,
          priority: true,
        });
      } else {
        collectMediaUrls(
          child,
          results,
          childPath
        );
      }
    }
  }

  return results;
}

// ======================================================
// NORMALIZE MEDIA
// ======================================================

function normalizeMediaResponse(data, platform) {
  const resolutions = {};

  // ----------------------------------------------------
  // 1. Existing resolutions object
  // ----------------------------------------------------

  if (
    data &&
    typeof data === "object" &&
    data.resolutions &&
    typeof data.resolutions === "object"
  ) {
    for (const [quality, value] of Object.entries(
      data.resolutions
    )) {
      if (
        typeof value === "string" &&
        isValidHttpUrl(value)
      ) {
        resolutions[quality] = value;
      }
    }
  }

  // ----------------------------------------------------
  // 2. Known direct fields
  // ----------------------------------------------------

  const possibleFields = [
    "url",
    "download",
    "downloadUrl",
    "download_url",
    "video",
    "videoUrl",
    "video_url",
    "media",
    "mediaUrl",
    "media_url",
    "hd",
    "hdUrl",
    "hd_url",
    "sd",
    "sdUrl",
    "sd_url",
    "nowm",
    "nowmUrl",
    "nowm_url",
    "play",
    "playUrl",
    "play_url",
    "play_url_hd",
  ];

  if (data && typeof data === "object") {
    for (const field of possibleFields) {
      const value = data[field];

      if (
        typeof value === "string" &&
        isValidHttpUrl(value) &&
        looksLikeMediaUrl(value)
      ) {
        if (
          field.toLowerCase().includes("hd")
        ) {
          resolutions["1080p"] = value;
        } else if (
          field.toLowerCase().includes("sd")
        ) {
          resolutions["480p"] = value;
        } else {
          resolutions["auto"] = value;
        }
      }
    }
  }

  // ----------------------------------------------------
  // 3. Recursive fallback
  // ----------------------------------------------------

  const found = collectMediaUrls(data);

  // Remove duplicates
  const uniqueUrls = [];

  for (const item of found) {
    if (
      !uniqueUrls.includes(item.url)
    ) {
      uniqueUrls.push(item.url);
    }
  }

  // ----------------------------------------------------
  // 4. Add recursive results
  // ----------------------------------------------------

  for (const url of uniqueUrls) {
    if (
      !Object.values(resolutions).includes(url)
    ) {
      const lower = url.toLowerCase();

      if (
        lower.includes("1080") ||
        lower.includes("2160") ||
        lower.includes("hd")
      ) {
        resolutions["1080p"] = url;
      } else if (
        lower.includes("720")
      ) {
        resolutions["720p"] = url;
      } else if (
        lower.includes("480")
      ) {
        resolutions["480p"] = url;
      } else if (
        lower.includes("360")
      ) {
        resolutions["360p"] = url;
      } else if (
        !resolutions["auto"]
      ) {
        resolutions["auto"] = url;
      }
    }
  }

  // ----------------------------------------------------
  // 5. Remove duplicate URLs
  // ----------------------------------------------------

  const finalResolutions = {};

  for (const [quality, url] of Object.entries(
    resolutions
  )) {
    if (
      url &&
      !Object.values(finalResolutions).includes(url)
    ) {
      finalResolutions[quality] = url;
    }
  }

  // ----------------------------------------------------
  // 6. Sort quality
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

  for (const quality of qualityOrder) {
    if (finalResolutions[quality]) {
      sorted[quality] =
        finalResolutions[quality];
    }
  }

  // Add anything not in the standard list
  for (const [quality, url] of Object.entries(
    finalResolutions
  )) {
    if (!sorted[quality]) {
      sorted[quality] = url;
    }
  }

  return {
    success: Object.keys(sorted).length > 0,
    platform,
    resolutions: sorted,
  };
}

// ======================================================
// EXTRACT API
// ======================================================

app.post("/api/extract", async (req, res) => {
  const startedAt = Date.now();

  try {
    const originalUrl =
      typeof req.body?.url === "string"
        ? req.body.url.trim()
        : "";

    // --------------------------------------------------
    // Validate
    // --------------------------------------------------

    if (!originalUrl) {
      return res.status(400).json({
        success: false,
        error: "URL is required.",
      });
    }

    if (!isValidHttpUrl(originalUrl)) {
      return res.status(400).json({
        success: false,
        error: "Please provide a valid HTTP/HTTPS URL.",
      });
    }

    console.log("\n========================================");
    console.log("NEW EXTRACTION REQUEST");
    console.log("URL:", originalUrl);
    console.log("========================================");

    // --------------------------------------------------
    // Detect original platform
    // --------------------------------------------------

    let platform = detectPlatform(originalUrl);

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

    // --------------------------------------------------
    // Clean URL
    // --------------------------------------------------

    let workingUrl = cleanUrl(originalUrl);

    console.log(
      "Clean URL:",
      workingUrl
    );

    // --------------------------------------------------
    // Resolve short/share URL
    // --------------------------------------------------

    try {
      const resolved =
        await resolveRedirectUrl(
          workingUrl
        );

      if (
        resolved &&
        resolved !== workingUrl
      ) {
        workingUrl = resolved;

        // Re-detect after redirect
        const detectedAfterRedirect =
          detectPlatform(workingUrl);

        if (detectedAfterRedirect) {
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
        "Redirect resolver skipped:",
        error.message
      );
    }

    // --------------------------------------------------
    // Get downloader
    // --------------------------------------------------

    const downloader =
      getDownloader(platform);

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

    // --------------------------------------------------
    // Call downloader
    // --------------------------------------------------

    let result;

    try {
      result =
        await downloader(workingUrl);
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

    // --------------------------------------------------
    // Debug response
    // --------------------------------------------------

    console.log(
      `${platform} raw response type:`,
      typeof result
    );

    if (result && typeof result === "object") {
      console.log(
        `${platform} response keys:`,
        Object.keys(result)
      );
    }

    // --------------------------------------------------
    // Normalize
    // --------------------------------------------------

    const normalized =
      normalizeMediaResponse(
        result,
        platform
      );

    // --------------------------------------------------
    // Nothing found
    // --------------------------------------------------

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
        ).slice(0, 10000)
      );

      return res.status(422).json({
        success: false,
        platform,
        error:
          "No downloadable media URL was found for this post.",
        hint:
          "Make sure the post/video is public and accessible.",
      });
    }

    // --------------------------------------------------
    // Success
    // --------------------------------------------------

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
      sourceUrl: originalUrl,
      resolvedUrl: workingUrl,
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
});

// ======================================================
// 404
// ======================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found.",
  });
});

// ======================================================
// GLOBAL ERROR HANDLER
// ======================================================

app.use(
  (error, req, res, next) => {
    console.error(
      "GLOBAL ERROR:",
      error
    );

    res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, () => {
  console.log(
    `StreamBox Backend running on port ${PORT}`
  );
  console.log(
    `Node version: ${process.version}`
  );
});
