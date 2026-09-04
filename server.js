const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");

const {
  igdl,
  ttdl,
  fbdown,
  pinterest,
  twitter,
} = require("btch-downloader");

const app = express();

// ======================================================
// CONFIG
// ======================================================

const PORT = process.env.PORT || 3000;

const EXTRACTION_TIMEOUT = 120000;
const YTDLP_TIMEOUT = 180000;
const REDIRECT_TIMEOUT = 15000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const EXPLICIT_YTDLP_PATH = process.env.YTDLP_PATH || "";
const EXPLICIT_FFMPEG_PATH = process.env.FFMPEG_PATH || "";

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

  return value.trim().replace(/^<|>$/g, "");
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);

    [
      "si",
      "igsh",
      "igshid",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
    ].forEach((parameter) => {
      url.searchParams.delete(parameter);
    });

    if (
      url.hostname === "x.com" ||
      url.hostname === "www.x.com" ||
      url.hostname === "mobile.twitter.com"
    ) {
      url.hostname = "twitter.com";
    }

    if (
      url.hostname === "m.facebook.com" ||
      url.hostname === "mbasic.facebook.com"
    ) {
      url.hostname = "www.facebook.com";
    }

    return url.href;
  } catch {
    return value;
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
// REDIRECT RESOLUTION
// ======================================================

async function resolveRedirectUrl(inputUrl) {
  let currentUrl = inputUrl;

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

        currentUrl = new URL(
          location,
          currentUrl
        ).href;

        continue;
      }

      if (response.url) {
        currentUrl = response.url;
      }

      break;
    } catch (error) {
      clearTimeout(timer);
      console.log("[REDIRECT] Failed:", error.message);
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

  const shouldResolve =
    platform === "pinterest" ||
    platform === "tiktok" ||
    platform === "facebook";

  if (shouldResolve) {
    if (
      url.includes("pin.it") ||
      url.includes("vm.tiktok.com") ||
      url.includes("vt.tiktok.com") ||
      url.includes("fb.watch") ||
      url.includes("/share/")
    ) {
      console.log(`[PREPARE] Resolving ${platform} URL`);

      const resolved = await resolveRedirectUrl(url);

      if (resolved) {
        url = resolved;
      }
    }
  }

  if (platform === "youtube") {
    try {
      const parsed = new URL(url);

      if (parsed.hostname === "youtu.be") {
        const id = parsed.pathname
          .split("/")
          .filter(Boolean)[0];

        if (id) {
          url = `https://www.youtube.com/watch?v=${id}`;
        }
      } else if (
        parsed.pathname.startsWith("/shorts/")
      ) {
        const id = parsed.pathname
          .split("/")
          .filter(Boolean)[1];

        if (id) {
          url = `https://www.youtube.com/watch?v=${id}`;
        }
      } else if (
        parsed.pathname.startsWith("/embed/")
      ) {
        const id = parsed.pathname
          .split("/")
          .filter(Boolean)[1];

        if (id) {
          url = `https://www.youtube.com/watch?v=${id}`;
        }
      } else if (
        parsed.pathname.startsWith("/live/")
      ) {
        const id = parsed.pathname
          .split("/")
          .filter(Boolean)[1];

        if (id) {
          url = `https://www.youtube.com/watch?v=${id}`;
        }
      }
    } catch {
      // Keep original URL.
    }
  }

  return url;
}

// ======================================================
// COMMAND RUNNER
// ======================================================

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let completed = false;

    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: [
          process.env.PATH || "",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
        ]
          .filter(Boolean)
          .join(":"),
      },
    });

    const timer = setTimeout(() => {
      if (completed) {
        return;
      }

      completed = true;

      try {
        child.kill("SIGKILL");
      } catch {}

      const error = new Error(
        `${command} timed out after ${Math.round(
          timeoutMs / 1000
        )} seconds`
      );

      error.code = "COMMAND_TIMEOUT";

      reject(error);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (completed) {
        return;
      }

      completed = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (completed) {
        return;
      }

      completed = true;
      clearTimeout(timer);

      if (code !== 0) {
        const error = new Error(
          stderr.trim() ||
            `${command} exited with code ${code}`
        );

        error.code = `COMMAND_EXIT_${code}`;

        reject(error);
        return;
      }

      resolve({
        stdout,
        stderr,
      });
    });
  });
}

// ======================================================
// FIND YT-DLP
// ======================================================

async function getYtDlpRunner() {
  const possibleCommands = [];

  if (EXPLICIT_YTDLP_PATH) {
    possibleCommands.push({
      command: EXPLICIT_YTDLP_PATH,
      args: [],
    });
  }

  possibleCommands.push(
    {
      command: "/usr/local/bin/yt-dlp",
      args: [],
    },
    {
      command: "/usr/bin/yt-dlp",
      args: [],
    },
    {
      command: "yt-dlp",
      args: [],
    },
    {
      command: "python3",
      args: ["-m", "yt_dlp"],
    },
    {
      command: "python",
      args: ["-m", "yt_dlp"],
    }
  );

  for (const item of possibleCommands) {
    try {
      await runCommand(
        item.command,
        [...item.args, "--version"],
        15000
      );

      console.log(
        `[YTDLP] Using ${item.command} ${
          item.args.length ? item.args.join(" ") : ""
        }`
      );

      return item;
    } catch (error) {
      console.log(
        `[YTDLP] Not available: ${item.command}`,
        error.message
      );
    }
  }

  const error = new Error(
    "yt-dlp is not installed or cannot be executed in the Render container."
  );

  error.code = "YTDLP_NOT_FOUND";

  throw error;
}

// ======================================================
// FIND FFMPEG
// ======================================================

function getFfmpegCommand() {
  return (
    EXPLICIT_FFMPEG_PATH ||
    "/usr/bin/ffmpeg"
  );
}

// ======================================================
// YT-DLP EXTRACTION
// ======================================================

async function extractWithYtDlp(url, platform) {
  const runner = await getYtDlpRunner();

  const args = [
    ...runner.args,

    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "--ignore-config",

    // Prefer MP4 video and M4A audio.
    // Fall back to the best available format.
    "--format",
    "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/best[height<=1080]/best",

    "--user-agent",
    USER_AGENT,

    "--referer",
    url,

    "--ffmpeg-location",
    getFfmpegCommand(),

    url,
  ];

  console.log(
    `[YTDLP] Extracting ${platform}: ${url}`
  );

  const result = await runCommand(
    runner.command,
    args,
    YTDLP_TIMEOUT
  );

  let metadata;

  try {
    metadata = JSON.parse(result.stdout);
  } catch {
    console.error(
      "[YTDLP] Invalid JSON:",
      result.stdout.substring(0, 1000)
    );

    throw new Error(
      "yt-dlp returned invalid metadata."
    );
  }

  if (!metadata) {
    throw new Error(
      "yt-dlp returned empty metadata."
    );
  }

  let selectedFormat = null;

  if (
    metadata.url &&
    isValidHttpUrl(metadata.url)
  ) {
    selectedFormat = metadata;
  }

  if (
    !selectedFormat &&
    Array.isArray(metadata.formats)
  ) {
    const formats = metadata.formats
      .filter((format) => {
        return (
          format &&
          typeof format.url === "string" &&
          isValidHttpUrl(format.url) &&
          format.vcodec &&
          format.vcodec !== "none" &&
          (!format.height ||
            Number(format.height) <= 1080)
        );
      })
      .sort((a, b) => {
        const aHeight = Number(a.height || 0);
        const bHeight = Number(b.height || 0);

        if (bHeight !== aHeight) {
          return bHeight - aHeight;
        }

        const aAudio =
          a.acodec && a.acodec !== "none" ? 1 : 0;

        const bAudio =
          b.acodec && b.acodec !== "none" ? 1 : 0;

        return bAudio - aAudio;
      });

    selectedFormat = formats[0] || null;
  }

  if (
    !selectedFormat ||
    !selectedFormat.url
  ) {
    throw new Error(
      "yt-dlp did not return a downloadable media URL."
    );
  }

  const mediaUrl = selectedFormat.url;

  const hasAudio =
    selectedFormat.acodec &&
    selectedFormat.acodec !== "none";

  const extension =
    selectedFormat.ext ||
    metadata.ext ||
    "mp4";

  console.log(
    `[YTDLP] Selected format: ${
      selectedFormat.format_id || "unknown"
    }`
  );

  console.log(
    `[YTDLP] Extension: ${extension}`
  );

  console.log(
    `[YTDLP] Audio: ${
      hasAudio ? "yes" : "no"
    }`
  );

  return {
    mediaUrl,
    extension,
    title:
      metadata.title ||
      `${platform} video`,
    thumbnail:
      metadata.thumbnail ||
      null,
    duration:
      metadata.duration ||
      null,
    width:
      selectedFormat.width ||
      metadata.width ||
      null,
    height:
      selectedFormat.height ||
      metadata.height ||
      null,
    hasAudio,
  };
}

// ======================================================
// BTCH FALLBACK
// ======================================================

async function runBtchExtractor(platform, url) {
  switch (platform) {
    case "instagram":
      return await igdl(url);

    case "tiktok":
      return await ttdl(url);

    case "facebook":
      return await fbdown(url);

    case "pinterest":
      return await pinterest(url);

    case "twitter":
      return await twitter(url);

    default:
      throw new Error(
        `No fallback extractor for ${platform}`
      );
  }
}

// ======================================================
// RECURSIVE URL EXTRACTION
// ======================================================

function isMediaUrl(value) {
  if (!isValidHttpUrl(value)) {
    return false;
  }

  const lower = value.toLowerCase();

  return (
    lower.includes(".mp4") ||
    lower.includes(".m4v") ||
    lower.includes(".mov") ||
    lower.includes(".webm") ||
    lower.includes(".m3u8") ||
    lower.includes("video") ||
    lower.includes("media") ||
    lower.includes("download") ||
    lower.includes("stream") ||
    lower.includes("cdn")
  );
}

function collectUrls(value, output = [], depth = 0) {
  if (
    value === null ||
    value === undefined ||
    depth > 20
  ) {
    return output;
  }

  if (typeof value === "string") {
    if (isMediaUrl(value)) {
      output.push(value);
    }

    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrls(item, output, depth + 1);
    }

    return output;
  }

  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      collectUrls(item, output, depth + 1);
    }
  }

  return output;
}

// ======================================================
// FALLBACK MEDIA EXTRACTION
// ======================================================

async function extractWithBtch(url, platform) {
  const result = await runBtchExtractor(
    platform,
    url
  );

  const urls = [
    ...new Set(collectUrls(result)),
  ];

  if (urls.length === 0) {
    throw new Error(
      "No downloadable media URL found."
    );
  }

  // Prefer MP4 and then other video formats.
  urls.sort((a, b) => {
    function score(value) {
      const lower = value.toLowerCase();

      let result = 0;

      if (lower.includes(".mp4")) result += 100;
      if (lower.includes(".m4v")) result += 90;
      if (lower.includes(".mov")) result += 80;
      if (lower.includes(".webm")) result += 70;
      if (lower.includes("1080")) result += 40;
      if (lower.includes("720")) result += 30;
      if (lower.includes("480")) result += 20;
      if (lower.includes("video")) result += 10;

      return result;
    }

    return score(b) - score(a);
  });

  const selectedUrl = urls[0];

  let extension = "mp4";

  const lower = selectedUrl.toLowerCase();

  if (lower.includes(".webm")) {
    extension = "webm";
  } else if (lower.includes(".mov")) {
    extension = "mov";
  } else if (lower.includes(".m4v")) {
    extension = "m4v";
  }

  return {
    mediaUrl: selectedUrl,
    extension,
    title: `${platform} video`,
    thumbnail: null,
    duration: null,
    width: null,
    height: null,
    hasAudio: null,
  };
}

// ======================================================
// MAIN EXTRACTION
// ======================================================

async function extractPlatformMedia(platform, url) {
  // Use yt-dlp first for all supported platforms.
  // It generally returns better format information.
  try {
    return await extractWithYtDlp(url, platform);
  } catch (error) {
    console.error(
      `[YTDLP] ${platform} failed:`,
      error.message
    );

    if (platform === "youtube") {
      throw error;
    }
  }

  // Fallback for Instagram, TikTok, Facebook,
  // Pinterest and Twitter/X.
  return await extractWithBtch(url, platform);
}

// ======================================================
// ROOT
// ======================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "StreamBox Backend",
    status: "online",
    version: "6.0.0",
    node: process.version,
    timestamp: new Date().toISOString(),
  });
});

// ======================================================
// HEALTH
// ======================================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "StreamBox Backend",
    status: "online",
    version: "6.0.0",
    node: process.version,
    timestamp: new Date().toISOString(),
  });
});

// ======================================================
// TOOLS
// ======================================================

app.get("/api/tools", async (req, res) => {
  let ytDlp = null;

  try {
    const runner = await getYtDlpRunner();

    const result = await runCommand(
      runner.command,
      [...runner.args, "--version"],
      15000
    );

    ytDlp = {
      installed: true,
      command: runner.command,
      arguments: runner.args,
      version: result.stdout.trim(),
    };
  } catch (error) {
    ytDlp = {
      installed: false,
      command: null,
      arguments: [],
      version: null,
      error: error.message,
    };
  }

  let ffmpeg = null;

  try {
    const result = await runCommand(
      getFfmpegCommand(),
      ["-version"],
      15000
    );

    ffmpeg = {
      installed: true,
      command: getFfmpegCommand(),
      version:
        result.stdout
          .trim()
          .split("\n")[0] || null,
    };
  } catch (error) {
    ffmpeg = {
      installed: false,
      command: getFfmpegCommand(),
      version: null,
      error: error.message,
    };
  }

  res.json({
    success: true,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    ytDlp,
    ffmpeg,
    environment: {
      YTDLP_PATH: EXPLICIT_YTDLP_PATH || null,
      FFMPEG_PATH: EXPLICIT_FFMPEG_PATH || null,
    },
  });
});

// ======================================================
// GET EXTRACT INFO
// ======================================================

app.get("/api/extract", (req, res) => {
  res.json({
    success: true,
    method: "POST",
    endpoint: "/api/extract",
    example: {
      url: "https://www.youtube.com/watch?v=example",
    },
  });
});

// ======================================================
// MAIN EXTRACT API
// ======================================================

app.post("/api/extract", async (req, res) => {
  const started = Date.now();

  try {
    const rawUrl = req.body?.url;

    if (
      typeof rawUrl !== "string" ||
      !rawUrl.trim()
    ) {
      return res.status(400).json({
        success: false,
        code: "URL_REQUIRED",
        error: "A valid URL is required.",
      });
    }

    const inputUrl = cleanInputUrl(rawUrl);

    if (!isValidHttpUrl(inputUrl)) {
      return res.status(400).json({
        success: false,
        code: "INVALID_URL",
        error: "Invalid HTTP/HTTPS URL.",
      });
    }

    const platform = getPlatform(inputUrl);

    if (!platform) {
      return res.status(400).json({
        success: false,
        code: "UNSUPPORTED_PLATFORM",
        error: "Unsupported platform.",
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

    console.log("");
    console.log("==============================================");
    console.log(`[REQUEST] ${inputUrl}`);
    console.log(`[PLATFORM] ${platform}`);

    const preparedUrl = await prepareUrl(
      platform,
      inputUrl
    );

    console.log(`[PREPARED] ${preparedUrl}`);

    const extracted =
      await extractPlatformMedia(
        platform,
        preparedUrl
      );

    if (
      !extracted ||
      !extracted.mediaUrl ||
      !isValidHttpUrl(extracted.mediaUrl)
    ) {
      throw new Error(
        "Extractor returned an invalid media URL."
      );
    }

    const resolution = extracted.height
      ? `${extracted.height}p`
      : null;

    const processingTimeMs =
      Date.now() - started;

    console.log(
      `[SUCCESS] ${platform} completed in ${processingTimeMs}ms`
    );

    console.log("==============================================");

    return res.status(200).json({
      success: true,
      platform,
      mediaUrl: extracted.mediaUrl,

      // Flutter can use this to select the correct extension.
      extension: extracted.extension || "mp4",

      resolutions: resolution
        ? {
            [resolution]: extracted.mediaUrl,
          }
        : {
            original: extracted.mediaUrl,
          },

      resolution,
      sourceUrl: inputUrl,
      preparedUrl,
      processingTimeMs,

      title: extracted.title || null,
      thumbnail: extracted.thumbnail || null,
      duration: extracted.duration || null,
      width: extracted.width || null,
      height: extracted.height || null,
      hasAudio:
        extracted.hasAudio === undefined
          ? null
          : extracted.hasAudio,
    });
  } catch (error) {
    console.error(
      "[EXTRACTION ERROR]",
      error.message
    );

    let code = error.code || "EXTRACTOR_FAILED";

    if (
      error.code === "YTDLP_NOT_FOUND" ||
      error.code === "ENOENT" ||
      error.message
        .toLowerCase()
        .includes("yt-dlp")
    ) {
      code = "YTDLP_NOT_FOUND";
    }

    return res.status(502).json({
      success: false,
      code,
      error: error.message,
      message:
        "The content may be private, deleted, restricted, expired, or unsupported.",
    });
  }
});

// ======================================================
// 404
// ======================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    code: "ENDPOINT_NOT_FOUND",
    error: "Endpoint not found.",
  });
});

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("==============================================");
  console.log("       STREAMBOX BACKEND v6.0.0");
  console.log("==============================================");
  console.log(`Port: ${PORT}`);
  console.log(`Node: ${process.version}`);
  console.log("yt-dlp: automatic detection");
  console.log(`FFmpeg: ${getFfmpegCommand()}`);
  console.log("==============================================");
});