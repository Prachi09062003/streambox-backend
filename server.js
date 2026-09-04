const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

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
const YTDLP_TIMEOUT = 180 * 1000;
const REDIRECT_TIMEOUT = 15 * 1000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const YTDLP_PATH =
  process.env.YTDLP_PATH ||
  "/usr/local/bin/yt-dlp";

const FFMPEG_PATH =
  process.env.FFMPEG_PATH ||
  "/usr/bin/ffmpeg";

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

    // X -> Twitter
    if (
      parsed.hostname === "x.com" ||
      parsed.hostname === "www.x.com"
    ) {
      parsed.hostname = "twitter.com";
    }

    if (
      parsed.hostname === "mobile.twitter.com"
    ) {
      parsed.hostname = "twitter.com";
    }

    // Facebook mobile domains
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

  console.log(
    `[RESOLVE] Starting URL: ${currentUrl}`
  );

  for (let attempt = 0; attempt < 5; attempt++) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, REDIRECT_TIMEOUT);

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
        const location =
          response.headers.get("location");

        if (!location) {
          break;
        }

        currentUrl = new URL(
          location,
          currentUrl
        ).href;

        console.log(
          `[RESOLVE] Redirect ${attempt + 1}`
        );

        continue;
      }

      if (
        response.url &&
        response.url !== currentUrl
      ) {
        currentUrl = response.url;
      }

      break;
    } catch (error) {
      clearTimeout(timer);

      console.log(
        `[RESOLVE] Failed: ${error.message}`
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

  // ----------------------------------------------------
  // Pinterest
  // ----------------------------------------------------

  if (
    platform === "pinterest" &&
    (
      url.includes("pin.it") ||
      url.includes("pinterest.com")
    )
  ) {
    console.log(
      "[PREPARE] Resolving Pinterest URL"
    );

    const resolved =
      await resolveRedirectUrl(url);

    if (resolved) {
      url = resolved;
    }

    console.log(
      `[PREPARE] Pinterest prepared`
    );
  }

  // ----------------------------------------------------
  // Facebook
  // ----------------------------------------------------

  if (
    platform === "facebook" &&
    (
      url.includes("/share/") ||
      url.includes("fb.watch")
    )
  ) {
    console.log(
      "[PREPARE] Resolving Facebook share URL"
    );

    const resolved =
      await resolveRedirectUrl(url);

    if (resolved) {
      url = resolved;
    }

    console.log(
      `[PREPARE] Facebook prepared`
    );
  }

  // ----------------------------------------------------
  // TikTok short URL
  // ----------------------------------------------------

  if (
    platform === "tiktok" &&
    (
      url.includes("vm.tiktok.com") ||
      url.includes("vt.tiktok.com")
    )
  ) {
    console.log(
      "[PREPARE] Resolving TikTok short URL"
    );

    const resolved =
      await resolveRedirectUrl(url);

    if (resolved) {
      url = resolved;
    }

    console.log(
      `[PREPARE] TikTok prepared`
    );
  }

  // ----------------------------------------------------
  // YouTube
  // ----------------------------------------------------

  if (platform === "youtube") {
    try {
      const parsed = new URL(url);

      // youtu.be/VIDEO_ID
      if (
        parsed.hostname === "youtu.be"
      ) {
        const videoId =
          parsed.pathname
            .split("/")
            .filter(Boolean)[0];

        if (videoId) {
          url =
            `https://www.youtube.com/watch?v=${videoId}`;
        }
      }

      // youtube.com/shorts/VIDEO_ID
      else if (
        parsed.pathname.startsWith("/shorts/")
      ) {
        const videoId =
          parsed.pathname
            .split("/")
            .filter(Boolean)[1];

        if (videoId) {
          url =
            `https://www.youtube.com/watch?v=${videoId}`;
        }
      }

      // youtube.com/embed/VIDEO_ID
      else if (
        parsed.pathname.startsWith("/embed/")
      ) {
        const videoId =
          parsed.pathname
            .split("/")
            .filter(Boolean)[1];

        if (videoId) {
          url =
            `https://www.youtube.com/watch?v=${videoId}`;
        }
      }

      // youtube.com/live/VIDEO_ID
      else if (
        parsed.pathname.startsWith("/live/")
      ) {
        const videoId =
          parsed.pathname
            .split("/")
            .filter(Boolean)[1];

        if (videoId) {
          url =
            `https://www.youtube.com/watch?v=${videoId}`;
        }
      }

      console.log(
        `[PREPARE] YouTube URL prepared: ${url}`
      );
    } catch {
      // Keep original URL
    }
  }

  return url;
}

// ======================================================
// MEDIA URL VALIDATION
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
    lower.includes("cdn") ||
    lower.includes("stream")
  );
}

function isKnownMediaKey(key) {
  const normalized =
    key.toLowerCase();

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

  return exactKeys.includes(
    normalized
  );
}

// ======================================================
// MEDIA QUALITY HELPERS
// ======================================================

function getNumericQuality(value) {
  if (value === null || value === undefined) {
    return 0;
  }

  const text = String(value);

  const match =
    text.match(
      /(\d{3,5})\s*[xX]\s*(\d{3,5})/
    );

  if (match) {
    return (
      Number(match[1]) *
      Number(match[2])
    );
  }

  const heightMatch =
    text.match(
      /(\d{3,5})p/
    );

  if (heightMatch) {
    return (
      Number(heightMatch[1]) * 1000
    );
  }

  return 0;
}

function scoreMediaUrl(url) {
  if (typeof url !== "string") {
    return -1;
  }

  const lower =
    url.toLowerCase();

  let score = 0;

  if (lower.includes(".mp4")) {
    score += 100;
  }

  if (lower.includes(".m4v")) {
    score += 90;
  }

  if (lower.includes(".mov")) {
    score += 80;
  }

  if (lower.includes(".webm")) {
    score += 70;
  }

  if (lower.includes(".m3u8")) {
    score += 50;
  }

  if (lower.includes(".mpd")) {
    score += 40;
  }

  if (lower.includes("1080")) {
    score += 35;
  }

  if (lower.includes("720")) {
    score += 25;
  }

  if (lower.includes("480")) {
    score += 15;
  }

  if (lower.includes("video")) {
    score += 25;
  }

  if (lower.includes("download")) {
    score += 20;
  }

  if (lower.includes("media")) {
    score += 15;
  }

  if (lower.includes("cdn")) {
    score += 10;
  }

  return score;
}

// ======================================================
// RECURSIVE MEDIA URL EXTRACTION
// ======================================================

function extractAllMediaUrls(
  value,
  found = [],
  depth = 0
) {
  if (
    value === null ||
    value === undefined ||
    depth > 20
  ) {
    return found;
  }

  // String
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

  // Array
  if (Array.isArray(value)) {
    for (const item of value) {
      extractAllMediaUrls(
        item,
        found,
        depth + 1
      );
    }

    return found;
  }

  // Object
  if (typeof value === "object") {
    for (
      const [key, item]
      of Object.entries(value)
    ) {
      const knownMediaKey =
        isKnownMediaKey(key);

      if (
        knownMediaKey &&
        typeof item === "string" &&
        isValidHttpUrl(item) &&
        !found.includes(item)
      ) {
        found.push(item);
      }

      extractAllMediaUrls(
        item,
        found,
        depth + 1
      );
    }
  }

  return found;
}

// ======================================================
// FIND URL BY KEY
// ======================================================

function findFirstUrlByKeys(
  value,
  keys,
  depth = 0
) {
  if (
    value === null ||
    value === undefined ||
    depth > 20
  ) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found =
        findFirstUrlByKeys(
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

  if (
    typeof value !== "object"
  ) {
    return null;
  }

  for (
    const [key, item]
    of Object.entries(value)
  ) {
    if (
      keys.includes(
        key.toLowerCase()
      ) &&
      typeof item === "string" &&
      isValidHttpUrl(item)
    ) {
      return item;
    }

    const nested =
      findFirstUrlByKeys(
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
// EXTRACT ALL QUALITY-AWARE MEDIA CANDIDATES
// ======================================================

function collectMediaCandidates(
  value,
  found = [],
  depth = 0
) {
  if (
    value === null ||
    value === undefined ||
    depth > 20
  ) {
    return found;
  }

  if (typeof value === "string") {
    if (
      isValidHttpUrl(value) &&
      isLikelyMediaUrl(value)
    ) {
      found.push({
        url: value,
        quality: getNumericQuality(value),
        score: scoreMediaUrl(value),
      });
    }

    return found;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectMediaCandidates(
        item,
        found,
        depth + 1
      );
    }

    return found;
  }

  if (typeof value === "object") {
    const width =
      Number(
        value.width ||
        value.video_width ||
        value.videoWidth ||
        0
      );

    const height =
      Number(
        value.height ||
        value.video_height ||
        value.videoHeight ||
        0
      );

    const quality =
      width > 0 && height > 0
        ? width * height
        : 0;

    for (
      const [key, item]
      of Object.entries(value)
    ) {
      if (
        typeof item === "string" &&
        isValidHttpUrl(item)
      ) {
        const likely =
          isLikelyMediaUrl(item) ||
          isKnownMediaKey(key);

        if (likely) {
          found.push({
            url: item,
            quality,
            width,
            height,
            score:
              scoreMediaUrl(item) +
              quality / 100000,
          });
        }
      }

      collectMediaCandidates(
        item,
        found,
        depth + 1
      );
    }
  }

  return found;
}

function extractBestMediaUrl(result) {
  const candidates =
    collectMediaCandidates(result);

  if (candidates.length === 0) {
    return null;
  }

  const unique = [];

  const seen =
    new Set();

  for (const candidate of candidates) {
    if (!seen.has(candidate.url)) {
      seen.add(candidate.url);
      unique.push(candidate);
    }
  }

  unique.sort(
    (a, b) =>
      (b.quality || 0) -
        (a.quality || 0) ||
      (b.score || 0) -
        (a.score || 0)
  );

  console.log(
    `[MEDIA] Found ${unique.length} candidate URL(s)`
  );

  unique
    .slice(0, 5)
    .forEach(
      (candidate, index) => {
        console.log(
          `[MEDIA] Candidate ${
            index + 1
          }: ` +
          `quality=${candidate.width || "?"}x${
            candidate.height || "?"
          } ` +
          `score=${candidate.score.toFixed(2)}`
        );
      }
    );

  return unique[0].url;
}

// ======================================================
// SAFE DEBUGGING
// ======================================================

function summarizeObject(
  value,
  depth = 0
) {
  if (depth > 3) {
    return "[nested object]";
  }

  if (
    value === null ||
    value === undefined
  ) {
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
          ? summarizeObject(
              value[0],
              depth + 1
            )
          : null,
    };
  }

  const output = {};

  for (
    const [key, item]
    of Object.entries(value)
  ) {
    if (
      typeof item === "string" &&
      isValidHttpUrl(item)
    ) {
      output[key] = "[URL]";
    } else if (
      typeof item === "string"
    ) {
      output[key] =
        item.length > 200
          ? `${item.substring(0, 200)}...`
          : item;
    } else if (
      typeof item === "object" &&
      item !== null
    ) {
      output[key] =
        summarizeObject(
          item,
          depth + 1
        );
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
// TIMEOUT
// ======================================================

async function withTimeout(
  promise,
  timeoutMs
) {
  let timer;

  const timeoutPromise =
    new Promise(
      (_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Operation timed out after ${Math.round(
                timeoutMs / 1000
              )} seconds`
            )
          );
        }, timeoutMs);
      }
    );

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
// BTCH EXTRACTOR
// ======================================================

async function runBtchExtractor(
  platform,
  url
) {
  switch (platform) {
    case "instagram":
      console.log(
        "[EXTRACTOR] Instagram -> igdl()"
      );

      return await igdl(url);

    case "tiktok":
      console.log(
        "[EXTRACTOR] TikTok -> ttdl()"
      );

      return await ttdl(url);

    case "facebook":
      console.log(
        "[EXTRACTOR] Facebook -> fbdown()"
      );

      return await fbdown(url);

    case "pinterest":
      console.log(
        "[EXTRACTOR] Pinterest -> pinterest()"
      );

      return await pinterest(url);

    case "twitter":
      console.log(
        "[EXTRACTOR] Twitter/X -> twitter()"
      );

      return await twitter(url);

    default:
      throw new Error(
        `btch-downloader does not handle platform: ${platform}`
      );
  }
}

// ======================================================
// COMMAND PATHS
// ======================================================

function getYtDlpCommand() {
  return YTDLP_PATH;
}

function getFfmpegCommand() {
  return FFMPEG_PATH;
}

// ======================================================
// COMMAND RUNNER
// ======================================================

function runCommand(
  command,
  args,
  timeoutMs
) {
  return new Promise(
    (resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let finished = false;

      let child;

      try {
        child = spawn(
          command,
          args,
          {
            shell: false,
            windowsHide: true,
            env: {
              ...process.env,
              PATH:
                process.env.PATH ||
                "/usr/local/bin:/usr/bin:/bin",
            },
          }
        );
      } catch (error) {
        reject(error);
        return;
      }

      const timer =
        setTimeout(() => {
          if (finished) {
            return;
          }

          finished = true;

          try {
            child.kill("SIGKILL");
          } catch {}

          reject(
            new Error(
              `${command} timed out after ${Math.round(
                timeoutMs / 1000
              )} seconds`
            )
          );
        }, timeoutMs);

      if (child.stdout) {
        child.stdout.on(
          "data",
          (chunk) => {
            stdout +=
              chunk.toString();
          }
        );
      }

      if (child.stderr) {
        child.stderr.on(
          "data",
          (chunk) => {
            stderr +=
              chunk.toString();
          }
        );
      }

      child.on(
        "error",
        (error) => {
          if (finished) {
            return;
          }

          finished = true;
          clearTimeout(timer);

          reject(error);
        }
      );

      child.on(
        "close",
        (code) => {
          if (finished) {
            return;
          }

          finished = true;
          clearTimeout(timer);

          if (code !== 0) {
            const error =
              new Error(
                stderr.trim() ||
                  `${command} exited with code ${code}`
              );

            error.code =
              `COMMAND_EXIT_${code}`;

            reject(error);

            return;
          }

          resolve({
            stdout,
            stderr,
          });
        }
      );
    }
  );
}

// ======================================================
// COMMAND HEALTH CHECK
// ======================================================

async function checkCommand(
  command,
  args
) {
  try {
    const result =
      await runCommand(
        command,
        args,
        15000
      );

    const version =
      result.stdout
        .trim()
        .split("\n")[0] ||
      result.stderr
        .trim()
        .split("\n")[0] ||
      null;

    return {
      installed: true,
      path: command,
      version,
    };
  } catch (error) {
    return {
      installed: false,
      path: command,
      version: null,
      error:
        error.message,
    };
  }
}

// ======================================================
// YOUTUBE EXTRACTION
// ======================================================

async function extractYouTubeWithYtDlp(
  url
) {
  console.log(
    "[YTDLP] Starting YouTube extraction"
  );

  console.log(
    `[YTDLP] Executable: ${getYtDlpCommand()}`
  );

  // ----------------------------------------------------
  // Ask yt-dlp for best video + best audio.
  // Limit to 1080p.
  // Prefer MP4-compatible video/audio.
  // ----------------------------------------------------

  const args = [
    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "--ignore-config",

    "--format",
    "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",

    "--merge-output-format",
    "mp4",

    "--user-agent",
    USER_AGENT,

    "--ffmpeg-location",
    getFfmpegCommand(),

    url,
  ];

  let result;

  try {
    result =
      await runCommand(
        getYtDlpCommand(),
        args,
        YTDLP_TIMEOUT
      );
  } catch (error) {
    console.error(
      "[YTDLP] Command failed:",
      error.message
    );

    // Helpful distinction for ENOENT
    if (
      error.code ===
      "ENOENT"
    ) {
      throw new Error(
        `yt-dlp executable not found at ${getYtDlpCommand()}`
      );
    }

    throw error;
  }

  let metadata;

  try {
    metadata =
      JSON.parse(
        result.stdout
      );
  } catch {
    console.error(
      "[YTDLP] Invalid JSON received"
    );

    console.error(
      result.stdout.substring(
        0,
        1500
      )
    );

    console.error(
      result.stderr.substring(
        0,
        1500
      )
    );

    throw new Error(
      "yt-dlp returned invalid JSON output"
    );
  }

  if (!metadata) {
    throw new Error(
      "yt-dlp returned empty metadata"
    );
  }

  console.log(
    `[YTDLP] Title: ${
      metadata.title ||
      "Unknown"
    }`
  );

  console.log(
    `[YTDLP] Duration: ${
      metadata.duration ||
      "Unknown"
    }`
  );

  console.log(
    `[YTDLP] Extractor: ${
      metadata.extractor ||
      "Unknown"
    }`
  );

  // ==================================================
  // DIRECT URL
  // ==================================================

  if (
    metadata.url &&
    isValidHttpUrl(
      metadata.url
    )
  ) {
    const hasAudio =
      metadata.acodec &&
      metadata.acodec !== "none";

    const height =
      Number(
        metadata.height || 0
      );

    console.log(
      "[YTDLP] Direct media URL found"
    );

    console.log(
      `[YTDLP] Resolution: ${
        height || "unknown"
      }p`
    );

    console.log(
      `[YTDLP] Audio: ${
        hasAudio
          ? "yes"
          : "no"
      }`
    );

    return {
      mediaUrl:
        metadata.url,

      title:
        metadata.title ||
        "YouTube video",

      duration:
        metadata.duration ||
        null,

      thumbnail:
        metadata.thumbnail ||
        null,

      width:
        metadata.width ||
        null,

      height:
        metadata.height ||
        null,

      hasAudio,
    };
  }

  // ==================================================
  // FORMAT SEARCH
  // ==================================================

  if (
    Array.isArray(
      metadata.formats
    )
  ) {
    const videoFormats =
      metadata.formats.filter(
        (format) => {
          if (
            !format ||
            typeof format.url !==
              "string" ||
            !isValidHttpUrl(
              format.url
            )
          ) {
            return false;
          }

          if (
            !format.vcodec ||
            format.vcodec === "none"
          ) {
            return false;
          }

          if (
            format.height &&
            Number(format.height) > 1080
          ) {
            return false;
          }

          return true;
        }
      );

    // ------------------------------------------------
    // Combined formats
    // ------------------------------------------------

    const combined =
      videoFormats.filter(
        (format) =>
          format.acodec &&
          format.acodec !== "none"
      );

    combined.sort(
      (a, b) => {
        const height =
          Number(b.height || 0) -
          Number(a.height || 0);

        if (height !== 0) {
          return height;
        }

        return (
          Number(b.tbr || 0) -
          Number(a.tbr || 0)
        );
      }
    );

    if (
      combined.length > 0
    ) {
      const selected =
        combined[0];

      console.log(
        `[YTDLP] Combined fallback selected: ${
          selected.format_id ||
          "unknown"
        }`
      );

      return {
        mediaUrl:
          selected.url,

        title:
          metadata.title ||
          "YouTube video",

        duration:
          metadata.duration ||
          null,

        thumbnail:
          metadata.thumbnail ||
          null,

        width:
          selected.width ||
          null,

        height:
          selected.height ||
          null,

        hasAudio: true,
      };
    }
  }

  // ==================================================
  // LAST FALLBACK
  // ==================================================

  const fallbackUrl =
    extractBestMediaUrl(
      metadata
    );

  if (fallbackUrl) {
    console.log(
      "[YTDLP] Generic fallback media URL found"
    );

    return {
      mediaUrl:
        fallbackUrl,

      title:
        metadata.title ||
        "YouTube video",

      duration:
        metadata.duration ||
        null,

      thumbnail:
        metadata.thumbnail ||
        null,

      width:
        metadata.width ||
        null,

      height:
        metadata.height ||
        null,

      hasAudio: null,
    };
  }

  throw new Error(
    "yt-dlp did not return a downloadable media URL"
  );
}

// ======================================================
// PLATFORM EXTRACTION
// ======================================================

async function extractPlatformMedia(
  platform,
  url
) {
  // ==================================================
  // YOUTUBE
  // ==================================================

  if (
    platform === "youtube"
  ) {
    return await extractYouTubeWithYtDlp(
      url
    );
  }

  // ==================================================
  // OTHER PLATFORMS
  // ==================================================

  const result =
    await withTimeout(
      runBtchExtractor(
        platform,
        url
      ),
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
    typeof result ===
      "object"
  ) {
    console.log(
      `[RESULT] ${platform} response keys:`,
      Object.keys(result)
    );
  }

  // ==================================================
  // MEDIA CANDIDATES
  // ==================================================

  const candidates =
    collectMediaCandidates(
      result
    );

  const uniqueCandidates = [];

  const seen =
    new Set();

  for (
    const candidate
    of candidates
  ) {
    if (
      !seen.has(
        candidate.url
      )
    ) {
      seen.add(
        candidate.url
      );

      uniqueCandidates.push(
        candidate
      );
    }
  }

  uniqueCandidates.sort(
    (a, b) =>
      (b.quality || 0) -
        (a.quality || 0) ||
      (b.score || 0) -
        (a.score || 0)
  );

  // ==================================================
  // LOG CANDIDATES
  // ==================================================

  uniqueCandidates
    .slice(0, 10)
    .forEach(
      (candidate, index) => {
        console.log(
          `[${platform.toUpperCase()}] Candidate ${
            index + 1
          }: ` +
          `${candidate.width || "?"}x${
            candidate.height || "?"
          }`
        );
      }
    );

  // ==================================================
  // SELECT BEST MEDIA
  // ==================================================

  if (
    uniqueCandidates.length > 0
  ) {
    const selected =
      uniqueCandidates[0];

    console.log(
      `[SELECTED] ${platform}: ${
        selected.width || "?"
      }x${
        selected.height || "?"
      }`
    );

    return {
      mediaUrl:
        selected.url,

      width:
        selected.width ||
        null,

      height:
        selected.height ||
        null,

      hasAudio:
        null,

      raw:
        result,
    };
  }

  // ==================================================
  // PINTEREST IMAGE CHECK
  // ==================================================

  if (
    platform === "pinterest"
  ) {
    const imageUrl =
      findFirstUrlByKeys(
        result,
        [
          "image",
          "image_url",
          "imageurl",
          "imageUrl",
          "thumbnail",
        ]
      );

    const videoUrl =
      findFirstUrlByKeys(
        result,
        [
          "video_url",
          "videourl",
          "videoUrl",
          "video",
          "videos",
        ]
      );

    if (
      imageUrl &&
      !videoUrl
    ) {
      const error =
        new Error(
          "This Pinterest Pin contains an image, not a video."
        );

      error.code =
        "IMAGE_ONLY";

      throw error;
    }
  }

  // ==================================================
  // NO MEDIA
  // ==================================================

  const error =
    new Error(
      "No downloadable media URL found"
    );

  error.code =
    "NO_MEDIA_URL";

  error.raw =
    result;

  console.log(
    "[DEBUG] Extractor result:",
    makeSafeDebug(result)
  );

  throw error;
}

// ======================================================
// ROOT
// ======================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,
      service:
        "StreamBox Backend",
      status: "online",
      version: "5.0.0",
      node:
        process.version,
      timestamp:
        new Date().toISOString(),
    });
  }
);

// ======================================================
// HEALTH
// ======================================================

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,
      service:
        "StreamBox Backend",
      status: "online",
      version: "5.0.0",
      node:
        process.version,
      timestamp:
        new Date().toISOString(),
    });
  }
);

// ======================================================
// TOOLS
// ======================================================

app.get(
  "/api/tools",
  async (req, res) => {
    const ytDlp =
      await checkCommand(
        getYtDlpCommand(),
        ["--version"]
      );

    const ffmpeg =
      await checkCommand(
        getFfmpegCommand(),
        ["-version"]
      );

    res.json({
      success: true,

      node:
        process.version,

      platform:
        process.platform,

      architecture:
        process.arch,

      ytDlp,

      ffmpeg,

      paths: {
        ytDlp:
          getYtDlpCommand(),

        ffmpeg:
          getFfmpegCommand(),
      },

      environment: {
        ytdlpPath:
          process.env.YTDLP_PATH ||
          null,

        ffmpegPath:
          process.env.FFMPEG_PATH ||
          null,
      },
    });
  }
);

// ======================================================
// GET EXTRACT INFO
// ======================================================

app.get(
  "/api/extract",
  (req, res) => {
    res.json({
      success: true,

      message:
        "Extract API is working.",

      method: "POST",

      endpoint:
        "/api/extract",

      usage: {
        body: {
          url:
            "https://www.youtube.com/watch?v=example",
        },
      },
    });
  }
);

// ======================================================
// MAIN EXTRACT API
// ======================================================

app.post(
  "/api/extract",
  async (req, res) => {
    const started =
      Date.now();

    try {
      // ==================================================
      // VALIDATE BODY
      // ==================================================

      const rawUrl =
        req.body?.url;

      if (!rawUrl) {
        return res.status(400).json({
          success: false,
          code:
            "URL_REQUIRED",
          error:
            "URL is required",
        });
      }

      if (
        typeof rawUrl !==
        "string"
      ) {
        return res.status(400).json({
          success: false,
          code:
            "INVALID_URL_TYPE",
          error:
            "URL must be a string",
        });
      }

      const inputUrl =
        cleanInputUrl(
          rawUrl
        );

      if (!inputUrl) {
        return res.status(400).json({
          success: false,
          code:
            "EMPTY_URL",
          error:
            "URL cannot be empty",
        });
      }

      if (
        !isValidHttpUrl(
          inputUrl
        )
      ) {
        return res.status(400).json({
          success: false,
          code:
            "INVALID_URL",
          error:
            "Invalid HTTP/HTTPS URL",
        });
      }

      // ==================================================
      // DETECT PLATFORM
      // ==================================================

      const platform =
        getPlatform(
          inputUrl
        );

      console.log("");

      console.log(
        "================================================"
      );

      console.log(
        `[REQUEST] URL: ${inputUrl}`
      );

      console.log(
        `[REQUEST] Platform: ${
          platform ||
          "unknown"
        }`
      );

      console.log(
        "================================================"
      );

      if (!platform) {
        return res.status(400).json({
          success: false,
          code:
            "UNSUPPORTED_PLATFORM",

          error:
            "Unsupported platform",

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

      // ==================================================
      // PREPARE URL
      // ==================================================

      const preparedUrl =
        await prepareUrl(
          platform,
          inputUrl
        );

      console.log(
        `[REQUEST] Prepared URL: ${preparedUrl}`
      );

      // ==================================================
      // EXTRACT
      // ==================================================

      let extracted;

      try {
        extracted =
          await extractPlatformMedia(
            platform,
            preparedUrl
          );
      } catch (error) {
        console.error(
          `[EXTRACTION ERROR] ${platform}:`,
          error.message
        );

        // ----------------------------------------------
        // Pinterest image
        // ----------------------------------------------

        if (
          error.code ===
          "IMAGE_ONLY"
        ) {
          return res.status(422).json({
            success: false,

            code:
              "IMAGE_ONLY",

            platform,

            error:
              error.message,

            sourceUrl:
              inputUrl,
          });
        }

        let code =
          error.code ||
          "EXTRACTOR_FAILED";

        const message =
          error.message ||
          "";

        const lower =
          message.toLowerCase();

        // ----------------------------------------------
        // yt-dlp missing
        // ----------------------------------------------

        if (
          platform === "youtube" &&
          (
            error.code ===
              "ENOENT" ||
            lower.includes(
              "executable not found"
            ) ||
            lower.includes(
              "spawn"
            )
          )
        ) {
          code =
            "YTDLP_NOT_FOUND";
        }

        // ----------------------------------------------
        // Private / Login
        // ----------------------------------------------

        if (
          lower.includes(
            "private"
          ) ||
          lower.includes(
            "login"
          ) ||
          lower.includes(
            "sign in"
          ) ||
          lower.includes(
            "authentication"
          )
        ) {
          code =
            "PRIVATE_CONTENT";
        }

        // ----------------------------------------------
        // Not found
        // ----------------------------------------------

        if (
          lower.includes(
            "not found"
          ) ||
          lower.includes(
            "deleted"
          ) ||
          lower.includes(
            "unavailable"
          ) ||
          lower.includes(
            "does not exist"
          )
        ) {
          code =
            "VIDEO_NOT_FOUND";
        }

        return res.status(502).json({
          success: false,

          code,

          platform,

          error:
            message ||
            "Platform extraction failed",

          message:
            "The content may be private, deleted, restricted, expired, unsupported, or the platform extractor may need an update.",

          sourceUrl:
            inputUrl,
        });
      }

      // ==================================================
      // VALIDATE EXTRACTED RESULT
      // ==================================================

      const mediaUrl =
        extracted?.mediaUrl;

      if (
        !mediaUrl ||
        !isValidHttpUrl(
          mediaUrl
        )
      ) {
        return res.status(502).json({
          success: false,

          code:
            "INVALID_MEDIA_URL",

          platform,

          error:
            "Extractor returned an invalid media URL",
        });
      }

      // ==================================================
      // RESOLUTION
      // ==================================================

      let resolution =
        null;

      if (
        extracted.height
      ) {
        resolution =
          `${extracted.height}p`;
      }

      // ==================================================
      // SUCCESS
      // ==================================================

      const processingTimeMs =
        Date.now() -
        started;

      console.log(
        `[SUCCESS] ${platform} extracted in ${processingTimeMs}ms`
      );

      console.log(
        `[SUCCESS] Resolution: ${
          resolution ||
          "unknown"
        }`
      );

      console.log(
        "================================================"
      );

      return res.status(200).json({
        success: true,

        platform,

        mediaUrl,

        resolutions:
          resolution
            ? {
                [resolution]:
                  mediaUrl,
              }
            : {
                original:
                  mediaUrl,
              },

        resolution,

        sourceUrl:
          inputUrl,

        processingTimeMs,

        title:
          extracted.title ||
          null,

        thumbnail:
          extracted.thumbnail ||
          null,

        duration:
          extracted.duration ||
          null,

        width:
          extracted.width ||
          null,

        height:
          extracted.height ||
          null,

        hasAudio:
          extracted.hasAudio ??
          null,
      });
    } catch (error) {
      console.error(
        "[SERVER ERROR]",
        error
      );

      return res.status(500).json({
        success: false,

        code:
          "INTERNAL_SERVER_ERROR",

        error:
          error.message ||
          "Internal server error",
      });
    }
  }
);

// ======================================================
// 404 HANDLER
// ======================================================

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,

      code:
        "ENDPOINT_NOT_FOUND",

      error:
        "Endpoint not found",

      path:
        req.path,

      method:
        req.method,
    });
  }
);

// ======================================================
// GLOBAL ERROR HANDLER
// ======================================================

app.use(
  (err, req, res, next) => {
    console.error(
      "[GLOBAL ERROR]",
      err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    res.status(500).json({
      success: false,

      code:
        "INTERNAL_SERVER_ERROR",

      error:
        "Internal server error",
    });
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");

    console.log(
      "================================================"
    );

    console.log(
      "       STREAMBOX BACKEND v5.0.0"
    );

    console.log(
      "================================================"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Node: ${process.version}`
    );

    console.log(
      `Platform: ${process.platform}`
    );

    console.log(
      `Architecture: ${process.arch}`
    );

    console.log(
      `yt-dlp: ${getYtDlpCommand()}`
    );

    console.log(
      `FFmpeg: ${getFfmpegCommand()}`
    );

    console.log(
      "Supported platforms:"
    );

    console.log(
      "✓ Instagram"
    );

    console.log(
      "✓ TikTok"
    );

    console.log(
      "✓ Facebook"
    );

    console.log(
      "✓ Pinterest"
    );

    console.log(
      "✓ Twitter/X"
    );

    console.log(
      "✓ YouTube"
    );

    console.log(
      "================================================"
    );

    console.log("");
  }
);
