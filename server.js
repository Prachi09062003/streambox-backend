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

const EXPLICIT_YTDLP_PATH =
  process.env.YTDLP_PATH || "";

const EXPLICIT_FFMPEG_PATH =
  process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";

const DENO_PATH =
  process.env.DENO_PATH ||
  "/root/.deno/bin/deno";

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
        const location =
          response.headers.get("location");

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

      console.log(
        "[REDIRECT] Failed:",
        error.message
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
      console.log(
        `[PREPARE] Resolving ${platform} URL`
      );

      const resolved =
        await resolveRedirectUrl(url);

      if (resolved) {
        url = resolved;
      }
    }
  }

  // ====================================================
  // YOUTUBE NORMALIZATION
  // ====================================================

  if (platform === "youtube") {
    try {
      const parsed = new URL(url);

      // youtu.be/VIDEO_ID
      if (
        parsed.hostname === "youtu.be"
      ) {
        const id = parsed.pathname
          .split("/")
          .filter(Boolean)[0];

        if (id) {
          url =
            `https://www.youtube.com/watch?v=${id}`;
        }
      }

      // youtube.com/shorts/VIDEO_ID
      else if (
        parsed.pathname.startsWith("/shorts/")
      ) {
        const id = parsed.pathname
          .split("/")
          .filter(Boolean)[1];

        if (id) {
          url =
            `https://www.youtube.com/watch?v=${id}`;
        }
      }

      // youtube.com/embed/VIDEO_ID
      else if (
        parsed.pathname.startsWith("/embed/")
      ) {
        const id = parsed.pathname
          .split("/")
          .filter(Boolean)[1];

        if (id) {
          url =
            `https://www.youtube.com/watch?v=${id}`;
        }
      }

      // youtube.com/live/VIDEO_ID
      else if (
        parsed.pathname.startsWith("/live/")
      ) {
        const id = parsed.pathname
          .split("/")
          .filter(Boolean)[1];

        if (id) {
          url =
            `https://www.youtube.com/watch?v=${id}`;
        }
      }

      // youtube.com/watch?v=VIDEO_ID
      else if (
        parsed.hostname.includes(
          "youtube.com"
        )
      ) {
        const videoId =
          parsed.searchParams.get("v");

        if (videoId) {
          url =
            `https://www.youtube.com/watch?v=${videoId}`;
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

function runCommand(
  command,
  args,
  timeoutMs
) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let completed = false;

    const child = spawn(
      command,
      args,
      {
        shell: false,
        windowsHide: true,

        env: {
          ...process.env,

          PATH: [
            process.env.PATH || "",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/root/.deno/bin",
          ]
            .filter(Boolean)
            .join(":"),
        },
      }
    );

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

      error.code =
        "COMMAND_TIMEOUT";

      reject(error);
    }, timeoutMs);

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

    child.on(
      "error",
      (error) => {
        if (completed) {
          return;
        }

        completed = true;
        clearTimeout(timer);

        reject(error);
      }
    );

    child.on(
      "close",
      (code) => {
        if (completed) {
          return;
        }

        completed = true;
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
      command:
        "/usr/local/bin/yt-dlp",
      args: [],
    },
    {
      command:
        "/usr/bin/yt-dlp",
      args: [],
    },
    {
      command: "yt-dlp",
      args: [],
    },
    {
      command: "python3",
      args: [
        "-m",
        "yt_dlp",
      ],
    },
    {
      command: "python",
      args: [
        "-m",
        "yt_dlp",
      ],
    }
  );

  for (
    const item of possibleCommands
  ) {
    try {
      const result =
        await runCommand(
          item.command,
          [
            ...item.args,
            "--version",
          ],
          15000
        );

      console.log(
        `[YTDLP] Using ${item.command}`
      );

      console.log(
        `[YTDLP] Version: ${result.stdout.trim()}`
      );

      return item;
    } catch (error) {
      console.log(
        `[YTDLP] Not available: ${item.command}`,
        error.message
      );
    }
  }

  const error =
    new Error(
      "yt-dlp is not installed or cannot be executed in the Render container."
    );

  error.code =
    "YTDLP_NOT_FOUND";

  throw error;
}

// ======================================================
// FFMPEG
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

async function extractWithYtDlp(
  url,
  platform
) {
  const runner =
    await getYtDlpRunner();

  const args = [
    ...runner.args,

    // --------------------------------------------------
    // BASIC
    // --------------------------------------------------

    "--dump-single-json",
    "--no-playlist",
    "--skip-download",
    "--no-warnings",
    "--ignore-config",

    // --------------------------------------------------
    // FLEXIBLE FORMAT
    // --------------------------------------------------

    "--format",
    "best",

    // --------------------------------------------------
    // USER AGENT
    // --------------------------------------------------

    "--user-agent",
    USER_AGENT,
  ];

  // ====================================================
  // YOUTUBE
  // ====================================================

  if (platform === "youtube") {
    console.log(
      "[YTDLP] Enabling Deno for YouTube"
    );

    args.push(
      "--js-runtimes",
      `deno:${DENO_PATH}`,

      // Allow yt-dlp to obtain EJS components.
      "--remote-components",
      "ejs:github"
    );
  }

  // ====================================================
  // PLATFORM-SPECIFIC OPTIONS
  // ====================================================

  if (
    platform === "instagram" ||
    platform === "pinterest"
  ) {
    args.push(
      "--extractor-retries",
      "3"
    );
  }

  if (platform === "youtube") {
    args.push(
      "--extractor-retries",
      "3",

      "--fragment-retries",
      "3",

      "--retries",
      "3"
    );
  }

  // ----------------------------------------------------
  // REFERER
  // ----------------------------------------------------

  args.push(
    "--referer",
    url
  );

  // ----------------------------------------------------
  // URL MUST BE LAST
  // ----------------------------------------------------

  args.push(url);

  console.log(
    `[YTDLP] Extracting ${platform}: ${url}`
  );

  const result =
    await runCommand(
      runner.command,
      args,
      YTDLP_TIMEOUT
    );

  // ====================================================
  // PARSE JSON
  // ====================================================

  let metadata;

  try {
    metadata =
      JSON.parse(
        result.stdout
      );
  } catch {
    console.error(
      "[YTDLP] Invalid JSON:"
    );

    console.error(
      result.stdout.substring(
        0,
        2000
      )
    );

    console.error(
      "[YTDLP] stderr:"
    );

    console.error(
      result.stderr.substring(
        0,
        2000
      )
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

  // ====================================================
  // SELECT FORMAT
  // ====================================================

  let selectedFormat = null;

  // yt-dlp sometimes provides a direct
  // media URL at metadata.url.
  if (
    metadata.url &&
    isValidHttpUrl(
      metadata.url
    )
  ) {
    selectedFormat =
      metadata;
  }

  // ====================================================
  // SEARCH FORMATS
  // ====================================================

  if (
    !selectedFormat &&
    Array.isArray(
      metadata.formats
    )
  ) {
    const formats =
      metadata.formats
        .filter(
          (format) => {
            if (
              !format ||
              typeof format.url !==
                "string"
            ) {
              return false;
            }

            if (
              !isValidHttpUrl(
                format.url
              )
            ) {
              return false;
            }

            // Must contain video.
            if (
              !format.vcodec ||
              format.vcodec ===
                "none"
            ) {
              return false;
            }

            return true;
          }
        )
        .sort(
          (a, b) => {
            const aHeight =
              Number(
                a.height || 0
              );

            const bHeight =
              Number(
                b.height || 0
              );

            // Prefer <=1080 when available.
            const a1080 =
              aHeight > 1080
                ? 0
                : 1;

            const b1080 =
              bHeight > 1080
                ? 0
                : 1;

            if (
              b1080 !== a1080
            ) {
              return (
                b1080 - a1080
              );
            }

            if (
              bHeight !==
              aHeight
            ) {
              return (
                bHeight -
                aHeight
              );
            }

            // Prefer formats with audio.
            const aAudio =
              a.acodec &&
              a.acodec !==
                "none"
                ? 1
                : 0;

            const bAudio =
              b.acodec &&
              b.acodec !==
                "none"
                ? 1
                : 0;

            return (
              bAudio -
              aAudio
            );
          }
        );

    selectedFormat =
      formats[0] ||
      null;
  }

  // ====================================================
  // VALIDATE
  // ====================================================

  if (
    !selectedFormat ||
    !selectedFormat.url
  ) {
    throw new Error(
      `yt-dlp did not return a downloadable media URL for ${platform}.`
    );
  }

  const mediaUrl =
    selectedFormat.url;

  const hasAudio =
    selectedFormat.acodec &&
    selectedFormat.acodec !==
      "none";

  const extension =
    selectedFormat.ext ||
    metadata.ext ||
    "mp4";

  const formatId =
    selectedFormat.format_id ||
    "unknown";

  console.log(
    `[YTDLP] Selected format: ${formatId}`
  );

  console.log(
    `[YTDLP] Extension: ${extension}`
  );

  console.log(
    `[YTDLP] Audio: ${
      hasAudio
        ? "yes"
        : "no"
    }`
  );

  console.log(
    `[YTDLP] Resolution: ${
      selectedFormat.height
        ? selectedFormat.height +
          "p"
        : "unknown"
    }`
  );

  // ====================================================
  // RETURN
  // ====================================================

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

    formatId,
  };
}

// ======================================================
// BTCH FALLBACK
// ======================================================

async function runBtchExtractor(
  platform,
  url
) {
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
// MEDIA URL DETECTION
// ======================================================

function isMediaUrl(value) {
  if (
    !isValidHttpUrl(value)
  ) {
    return false;
  }

  const lower =
    value.toLowerCase();

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

// ======================================================
// RECURSIVE URL COLLECTION
// ======================================================

function collectUrls(
  value,
  output = [],
  depth = 0
) {
  if (
    value === null ||
    value === undefined ||
    depth > 20
  ) {
    return output;
  }

  if (
    typeof value ===
    "string"
  ) {
    if (
      isMediaUrl(value)
    ) {
      output.push(value);
    }

    return output;
  }

  if (
    Array.isArray(value)
  ) {
    for (
      const item of value
    ) {
      collectUrls(
        item,
        output,
        depth + 1
      );
    }

    return output;
  }

  if (
    typeof value ===
    "object"
  ) {
    for (
      const item of Object.values(
        value
      )
    ) {
      collectUrls(
        item,
        output,
        depth + 1
      );
    }
  }

  return output;
}

// ======================================================
// BTCH FALLBACK EXTRACTION
// ======================================================

async function extractWithBtch(
  url,
  platform
) {
  const result =
    await runBtchExtractor(
      platform,
      url
    );

  const urls = [
    ...new Set(
      collectUrls(result)
    ),
  ];

  if (
    urls.length === 0
  ) {
    throw new Error(
      "No downloadable media URL found."
    );
  }

  urls.sort(
    (a, b) => {
      function score(value) {
        const lower =
          value.toLowerCase();

        let score = 0;

        if (
          lower.includes(".mp4")
        ) {
          score += 100;
        }

        if (
          lower.includes(".m4v")
        ) {
          score += 90;
        }

        if (
          lower.includes(".mov")
        ) {
          score += 80;
        }

        if (
          lower.includes(".webm")
        ) {
          score += 70;
        }

        if (
          lower.includes("1080")
        ) {
          score += 40;
        }

        if (
          lower.includes("720")
        ) {
          score += 30;
        }

        if (
          lower.includes("480")
        ) {
          score += 20;
        }

        if (
          lower.includes("video")
        ) {
          score += 10;
        }

        return score;
      }

      return (
        score(b) -
        score(a)
      );
    }
  );

  const selectedUrl =
    urls[0];

  let extension = "mp4";

  const lower =
    selectedUrl.toLowerCase();

  if (
    lower.includes(".webm")
  ) {
    extension = "webm";
  } else if (
    lower.includes(".mov")
  ) {
    extension = "mov";
  } else if (
    lower.includes(".m4v")
  ) {
    extension = "m4v";
  }

  return {
    mediaUrl:
      selectedUrl,

    extension,

    title:
      `${platform} video`,

    thumbnail: null,
    duration: null,
    width: null,
    height: null,
    hasAudio: null,
  };
}

// ======================================================
// MAIN PLATFORM EXTRACTION
// ======================================================

async function extractPlatformMedia(
  platform,
  url
) {
  try {
    return await extractWithYtDlp(
      url,
      platform
    );
  } catch (error) {
    console.error(
      `[YTDLP] ${platform} failed:`,
      error.message
    );

    // YouTube has no btch fallback.
    if (
      platform ===
      "youtube"
    ) {
      throw error;
    }

    // Try btch for the other platforms.
    try {
      console.log(
        `[BTCH] Trying fallback for ${platform}`
      );

      return await extractWithBtch(
        url,
        platform
      );
    } catch (fallbackError) {
      console.error(
        `[BTCH] ${platform} failed:`,
        fallbackError.message
      );

      throw new Error(
        `No downloadable media found. yt-dlp: ${error.message}; fallback: ${fallbackError.message}`
      );
    }
  }
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
      version: "7.0.0",
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
      version: "7.0.0",
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
    const tools = {
      ytDlp: {
        path:
          EXPLICIT_YTDLP_PATH ||
          "/usr/local/bin/yt-dlp",
        installed: false,
        version: null,
        error: null,
      },

      ffmpeg: {
        path:
          getFfmpegCommand(),
        installed: false,
        version: null,
        error: null,
      },

      deno: {
        path: DENO_PATH,
        installed: false,
        version: null,
        error: null,
      },
    };

    // --------------------------------------------------
    // YT-DLP
    // --------------------------------------------------

    try {
      const runner =
        await getYtDlpRunner();

      const result =
        await runCommand(
          runner.command,
          [
            ...runner.args,
            "--version",
          ],
          15000
        );

      tools.ytDlp.path =
        runner.command;

      tools.ytDlp.installed =
        true;

      tools.ytDlp.version =
        result.stdout.trim();
    } catch (error) {
      tools.ytDlp.error =
        error.message;
    }

    // --------------------------------------------------
    // FFMPEG
    // --------------------------------------------------

    try {
      const result =
        await runCommand(
          getFfmpegCommand(),
          ["-version"],
          15000
        );

      tools.ffmpeg.installed =
        true;

      tools.ffmpeg.version =
        result.stdout
          .split("\n")[0]
          .trim();
    } catch (error) {
      tools.ffmpeg.error =
        error.message;
    }

    // --------------------------------------------------
    // DENO
    // --------------------------------------------------

    try {
      const result =
        await runCommand(
          DENO_PATH,
          ["--version"],
          15000
        );

      tools.deno.installed =
        true;

      tools.deno.version =
        result.stdout.trim();
    } catch (error) {
      tools.deno.error =
        error.message;
    }

    res.json({
      success:
        tools.ytDlp.installed &&
        tools.ffmpeg.installed &&
        tools.deno.installed,

      tools,
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
      method: "POST",
      endpoint:
        "/api/extract",

      supportedPlatforms: [
        "Instagram",
        "TikTok",
        "Facebook",
        "Pinterest",
        "Twitter/X",
        "YouTube",
      ],

      example: {
        url:
          "https://www.youtube.com/watch?v=example",
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
      // ------------------------------------------------
      // INPUT
      // ------------------------------------------------

      const rawUrl =
        req.body?.url;

      if (
        typeof rawUrl !==
          "string" ||
        !rawUrl.trim()
      ) {
        return res.status(400).json({
          success: false,
          code:
            "URL_REQUIRED",
          error:
            "A valid URL is required.",
        });
      }

      const inputUrl =
        cleanInputUrl(
          rawUrl
        );

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
            "Invalid HTTP/HTTPS URL.",
        });
      }

      // ------------------------------------------------
      // PLATFORM
      // ------------------------------------------------

      const platform =
        getPlatform(
          inputUrl
        );

      if (!platform) {
        return res.status(400).json({
          success: false,
          code:
            "UNSUPPORTED_PLATFORM",
          error:
            "Unsupported platform.",

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
      console.log(
        "=============================================="
      );

      console.log(
        `[REQUEST] ${inputUrl}`
      );

      console.log(
        `[PLATFORM] ${platform}`
      );

      // ------------------------------------------------
      // PREPARE URL
      // ------------------------------------------------

      const preparedUrl =
        await prepareUrl(
          platform,
          inputUrl
        );

      console.log(
        `[PREPARED] ${preparedUrl}`
      );

      // ------------------------------------------------
      // EXTRACT
      // ------------------------------------------------

      const extracted =
        await extractPlatformMedia(
          platform,
          preparedUrl
        );

      // ------------------------------------------------
      // VALIDATE
      // ------------------------------------------------

      if (
        !extracted ||
        !extracted.mediaUrl ||
        !isValidHttpUrl(
          extracted.mediaUrl
        )
      ) {
        throw new Error(
          "Extractor returned an invalid media URL."
        );
      }

      // ------------------------------------------------
      // RESOLUTION
      // ------------------------------------------------

      const resolution =
        extracted.height
          ? `${extracted.height}p`
          : null;

      const processingTimeMs =
        Date.now() -
        started;

      console.log(
        `[SUCCESS] ${platform} completed in ${processingTimeMs}ms`
      );

      console.log(
        "=============================================="
      );

      // ------------------------------------------------
      // RESPONSE
      // ------------------------------------------------

      return res.status(200).json({
        success: true,

        platform,

        mediaUrl:
          extracted.mediaUrl,

        extension:
          extracted.extension ||
          "mp4",

        resolutions:
          resolution
            ? {
                [resolution]:
                  extracted.mediaUrl,
              }
            : {
                original:
                  extracted.mediaUrl,
              },

        resolution,

        sourceUrl:
          inputUrl,

        preparedUrl,

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
          extracted.hasAudio ===
          undefined
            ? null
            : extracted.hasAudio,

        formatId:
          extracted.formatId ||
          null,
      });
    } catch (error) {
      console.error(
        "[EXTRACTION ERROR]",
        error.message
      );

      let code =
        error.code ||
        "EXTRACTOR_FAILED";

      if (
        error.code ===
          "YTDLP_NOT_FOUND" ||
        error.code ===
          "ENOENT"
      ) {
        code =
          "YTDLP_NOT_FOUND";
      }

      return res.status(502).json({
        success: false,

        code,

        error:
          error.message,

        message:
          "The content may be private, deleted, restricted, expired, image-only, or unsupported.",
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
      code:
        "ENDPOINT_NOT_FOUND",
      error:
        "Endpoint not found.",
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
    console.log(
      "=============================================="
    );

    console.log(
      "       STREAMBOX BACKEND v7.0.0"
    );

    console.log(
      "=============================================="
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Node: ${process.version}`
    );

    console.log(
      `yt-dlp: ${
        EXPLICIT_YTDLP_PATH ||
        "/usr/local/bin/yt-dlp"
      }`
    );

    console.log(
      `FFmpeg: ${getFfmpegCommand()}`
    );

    console.log(
      `Deno: ${DENO_PATH}`
    );

    console.log(
      "=============================================="
    );
  }
);