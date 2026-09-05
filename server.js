const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 3000;

const EXTRACTION_TIMEOUT = 180000;
const DOWNLOAD_TIMEOUT = 600000;

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

const DENO_PATH =
  process.env.DENO_PATH ||
  "/root/.deno/bin/deno";

const MEDIA_DIR =
  process.env.MEDIA_DIR ||
  path.join(os.tmpdir(), "streambox-media");

const MEDIA_TTL =
  Number(
    process.env.MEDIA_TTL_SECONDS || 1800
  ) * 1000;

fs.mkdirSync(MEDIA_DIR, {
  recursive: true,
});

// Extraction sessions.
// token -> metadata
const extractionSessions = new Map();

// ============================================================
// MIDDLEWARE
// ============================================================

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

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function isYouTubeUrl(url) {
  try {
    const hostname =
      new URL(url).hostname
        .toLowerCase()
        .replace(/^www\./, "");

    return (
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "youtu.be" ||
      hostname === "music.youtube.com"
    );
  } catch {
    return false;
  }
}

// ============================================================
// PLATFORM
// ============================================================

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

  return "generic";
}

// ============================================================
// REDIRECT
// ============================================================

async function resolveRedirectUrl(inputUrl) {
  let currentUrl = inputUrl;

  for (let i = 0; i < 8; i++) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, 20000);

    try {
      const response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: controller.signal,
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

        currentUrl =
          new URL(
            location,
            currentUrl
          ).href;

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
      break;
    }
  }

  return normalizeUrl(currentUrl);
}

// ============================================================
// PREPARE URL
// ============================================================

async function prepareUrl(
  platform,
  inputUrl
) {
  let url = normalizeUrl(inputUrl);

  if (
    platform === "pinterest" ||
    platform === "tiktok" ||
    platform === "facebook"
  ) {
    const resolved =
      await resolveRedirectUrl(url);

    if (resolved) {
      url = resolved;
    }
  }

  return url;
}

// ============================================================
// COMMAND
// ============================================================

function runCommand(
  command,
  args,
  options = {}
) {
  return new Promise((resolve, reject) => {
    const timeout =
      options.timeout || 120000;

    const env = {
      ...process.env,
      PATH:
        `/root/.deno/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
    };

    const child = spawn(
      command,
      args,
      {
        env,
        cwd:
          options.cwd || process.cwd(),
        windowsHide: true,
      }
    );

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;

      finished = true;

      try {
        child.kill("SIGKILL");
      } catch {}

      reject(
        new Error(
          `Command timed out after ${Math.round(
            timeout / 1000
          )} seconds`
        )
      );
    }, timeout);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve({
          code,
          stdout,
          stderr,
        });
      } else {
        const error = new Error(
          stderr.trim() ||
            stdout.trim() ||
            `Command failed with code ${code}`
        );

        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;

        reject(error);
      }
    });
  });
}

// ============================================================
// YT-DLP
// ============================================================

function getYtDlpPath() {
  if (
    YTDLP_PATH &&
    fs.existsSync(YTDLP_PATH)
  ) {
    return YTDLP_PATH;
  }

  const candidates = [
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "yt-dlp";
}

function getCommonYtDlpArgs() {
  return [
    "--ignore-config",
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--retries",
    "5",
    "--fragment-retries",
    "5",
    "--extractor-retries",
    "5",
    "--retry-sleep",
    "1",
    "--user-agent",
    USER_AGENT,
  ];
}

// ============================================================
// METADATA
// ============================================================

async function extractMetadata(url) {
  const ytDlp =
    getYtDlpPath();

  const args = [
    ...getCommonYtDlpArgs(),
    "--dump-single-json",
    "--skip-download",
    url,
  ];

  const result =
    await runCommand(
      ytDlp,
      args,
      {
        timeout:
          EXTRACTION_TIMEOUT,
      }
    );

  const stdout =
    result.stdout.trim();

  if (!stdout) {
    throw new Error(
      "yt-dlp returned empty metadata."
    );
  }

  const lines =
    stdout
      .split(/\r?\n/)
      .filter(Boolean);

  for (
    let i = lines.length - 1;
    i >= 0;
    i--
  ) {
    try {
      const parsed =
        JSON.parse(lines[i]);

      if (
        parsed &&
        typeof parsed === "object"
      ) {
        return parsed;
      }
    } catch {}
  }

  throw new Error(
    "Could not parse yt-dlp metadata."
  );
}

// ============================================================
// FORMAT HELPERS
// ============================================================

function isHttpUrl(value) {
  return (
    typeof value === "string" &&
    /^https?:\/\//i.test(value)
  );
}

function hasVideo(format) {
  const codec =
    String(
      format?.vcodec || ""
    ).toLowerCase();

  return (
    codec &&
    codec !== "none"
  );
}

function hasAudio(format) {
  const codec =
    String(
      format?.acodec || ""
    ).toLowerCase();

  return (
    codec &&
    codec !== "none"
  );
}

function formatHeight(format) {
  const height =
    Number(format?.height || 0);

  return Number.isFinite(height)
    ? height
    : 0;
}

function formatLabel(format) {
  const height =
    formatHeight(format);

  if (height > 0) {
    return `${height}p`;
  }

  if (
    format?.format_note
  ) {
    return String(
      format.format_note
    );
  }

  return "Best";
}

// ============================================================
// BUILD QUALITY LIST
// ============================================================

function buildQualityList(metadata) {
  if (
    !metadata ||
    !Array.isArray(metadata.formats)
  ) {
    return [];
  }

  const formats =
    metadata.formats.filter(
      (format) =>
        format &&
        hasVideo(format)
    );

  // Prefer formats containing audio.
  // Then prefer MP4.
  // Then higher resolution.
  formats.sort((a, b) => {
    const audioA =
      hasAudio(a) ? 1 : 0;

    const audioB =
      hasAudio(b) ? 1 : 0;

    if (audioA !== audioB) {
      return audioB - audioA;
    }

    const mp4A =
      String(a.ext || "")
        .toLowerCase() === "mp4"
        ? 1
        : 0;

    const mp4B =
      String(b.ext || "")
        .toLowerCase() === "mp4"
        ? 1
        : 0;

    if (mp4A !== mp4B) {
      return mp4B - mp4A;
    }

    return (
      formatHeight(b) -
      formatHeight(a)
    );
  });

  // Group by height.
  // Keep the best candidate for each resolution.
  const byHeight =
    new Map();

  for (const format of formats) {
    const height =
      formatHeight(format);

    if (height <= 0) {
      continue;
    }

    const current =
      byHeight.get(height);

    if (!current) {
      byHeight.set(
        height,
        format
      );
      continue;
    }

    const currentScore =
      formatScore(current);

    const newScore =
      formatScore(format);

    if (
      newScore >
      currentScore
    ) {
      byHeight.set(
        height,
        format
      );
    }
  }

  const result = [];

  const sortedHeights =
    Array.from(
      byHeight.keys()
    ).sort((a, b) => b - a);

  for (
    const height of sortedHeights
  ) {
    const format =
      byHeight.get(height);

    if (!format) continue;

    result.push({
      id:
        String(format.format_id),
      label:
        formatLabel(format),
      height,
      width:
        Number(format.width || 0) ||
        null,
      extension:
        format.ext || "mp4",
      previewUrl:
        isHttpUrl(format.url)
          ? format.url
          : null,
      hasAudio:
        hasAudio(format),
      hasVideo:
        hasVideo(format),
      formatNote:
        format.format_note ||
        null,
    });
  }

  // Best combined format first.
  const combined =
    formats.find(
      (format) =>
        hasVideo(format) &&
        hasAudio(format) &&
        formatHeight(format) > 0
    );

  if (
    combined &&
    !result.some(
      (item) =>
        item.id ===
        String(combined.format_id)
    )
  ) {
    result.unshift({
      id:
        String(combined.format_id),
      label:
        `${formatLabel(combined)} • Audio`,
      height:
        formatHeight(combined),
      width:
        Number(combined.width || 0) ||
        null,
      extension:
        combined.ext || "mp4",
      previewUrl:
        isHttpUrl(combined.url)
          ? combined.url
          : null,
      hasAudio: true,
      hasVideo: true,
      formatNote:
        combined.format_note ||
        null,
    });
  }

  return result;
}

function formatScore(format) {
  let score = 0;

  if (hasVideo(format)) {
    score += 1000;
  }

  if (hasAudio(format)) {
    score += 500;
  }

  if (
    String(format.ext || "")
      .toLowerCase() === "mp4"
  ) {
    score += 400;
  }

  score += Math.min(
    formatHeight(format),
    2160
  );

  return score;
}

// ============================================================
// TOKEN
// ============================================================

function createToken() {
  return crypto
    .randomBytes(24)
    .toString("hex");
}

// ============================================================
// EXTRACT SESSION
// ============================================================

function createExtractionSession(data) {
  const token =
    createToken();

  extractionSessions.set(
    token,
    {
      ...data,
      createdAt: Date.now(),
    }
  );

  return token;
}

function getExtractionSession(token) {
  if (
    !token ||
    !/^[a-f0-9]{48}$/i.test(token)
  ) {
    return null;
  }

  const session =
    extractionSessions.get(token);

  if (!session) {
    return null;
  }

  if (
    Date.now() -
      session.createdAt >
    MEDIA_TTL
  ) {
    extractionSessions.delete(
      token
    );

    return null;
  }

  return session;
}

// ============================================================
// SERVER DOWNLOAD
// ============================================================

async function downloadSelectedFormat(
  session,
  formatId
) {
  const jobToken =
    createToken();

  const jobDir =
    path.join(
      MEDIA_DIR,
      jobToken
    );

  fs.mkdirSync(
    jobDir,
    {
      recursive: true,
    }
  );

  const outputTemplate =
    path.join(
      jobDir,
      "streambox.%(ext)s"
    );

  const ytDlp =
    getYtDlpPath();

  // Use requested format when possible.
  //
  // If it is video-only, add best available
  // audio. If it already contains audio,
  // yt-dlp will keep it.
  const formatSelector =
    `${formatId}+bestaudio/best`;

  const args = [
    ...getCommonYtDlpArgs(),

    "--format",
    formatSelector,

    "--merge-output-format",
    "mp4",

    "--output",
    outputTemplate,

    "--no-part",
    "--no-continue",

    "--referer",
    session.sourceUrl,

    session.sourceUrl,
  ];

  try {
    await runCommand(
      ytDlp,
      args,
      {
        timeout:
          DOWNLOAD_TIMEOUT,
        cwd:
          jobDir,
      }
    );

    const downloadedFile =
      findDownloadedFile(
        jobDir
      );

    if (!downloadedFile) {
      throw new Error(
        "yt-dlp completed but no media file was created."
      );
    }

    let finalFile =
      downloadedFile;

    if (
      !downloadedFile
        .toLowerCase()
        .endsWith(".mp4")
    ) {
      finalFile =
        path.join(
          jobDir,
          "streambox.mp4"
        );

      await normalizeToMp4(
        downloadedFile,
        finalFile
      );
    }

    if (
      !fs.existsSync(
        finalFile
      )
    ) {
      throw new Error(
        "Final MP4 file was not created."
      );
    }

    const stat =
      fs.statSync(
        finalFile
      );

    if (stat.size <= 0) {
      throw new Error(
        "Final video is empty."
      );
    }

    return {
      jobToken,
      jobDir,
      filePath:
        finalFile,
      fileSize:
        stat.size,
    };
  } catch (error) {
    try {
      fs.rmSync(
        jobDir,
        {
          recursive: true,
          force: true,
        }
      );
    } catch {}

    throw error;
  }
}

// ============================================================
// FIND FILE
// ============================================================

function findDownloadedFile(
  directory
) {
  if (
    !fs.existsSync(directory)
  ) {
    return null;
  }

  const extensions = [
    ".mp4",
    ".mkv",
    ".webm",
    ".mov",
    ".m4v",
    ".ts",
  ];

  const candidates =
    fs.readdirSync(directory)
      .filter((file) =>
        extensions.some(
          (ext) =>
            file
              .toLowerCase()
              .endsWith(ext)
        )
      )
      .map((file) => ({
        file,
        fullPath:
          path.join(
            directory,
            file
          ),
      }))
      .filter((item) => {
        try {
          return (
            fs.statSync(
              item.fullPath
            ).size > 0
          );
        } catch {
          return false;
        }
      });

  if (
    candidates.length === 0
  ) {
    return null;
  }

  candidates.sort(
    (a, b) =>
      fs.statSync(
        b.fullPath
      ).size -
      fs.statSync(
        a.fullPath
      ).size
  );

  return candidates[0].fullPath;
}

// ============================================================
// FFMPEG
// ============================================================

async function normalizeToMp4(
  inputFile,
  outputFile
) {
  const args = [
    "-y",

    "-i",
    inputFile,

    "-map",
    "0:v:0",

    "-map",
    "0:a:0?",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    "23",

    "-pix_fmt",
    "yuv420p",

    "-c:a",
    "aac",

    "-b:a",
    "128k",

    "-movflags",
    "+faststart",

    outputFile,
  ];

  await runCommand(
    FFMPEG_PATH,
    args,
    {
      timeout:
        DOWNLOAD_TIMEOUT,
    }
  );

  if (
    !fs.existsSync(
      outputFile
    )
  ) {
    throw new Error(
      "FFmpeg did not create the MP4."
    );
  }

  if (
    fs.statSync(
      outputFile
    ).size <= 0
  ) {
    throw new Error(
      "FFmpeg created an empty MP4."
    );
  }

  return outputFile;
}

// ============================================================
// CLEANUP
// ============================================================

function cleanupExpiredMedia() {
  if (
    fs.existsSync(MEDIA_DIR)
  ) {
    const now =
      Date.now();

    for (
      const entry of fs.readdirSync(
        MEDIA_DIR,
        {
          withFileTypes: true,
        }
      )
    ) {
      if (!entry.isDirectory()) {
        continue;
      }

      const directory =
        path.join(
          MEDIA_DIR,
          entry.name
        );

      try {
        const stat =
          fs.statSync(
            directory
          );

        if (
          now -
            stat.mtimeMs >
          MEDIA_TTL
        ) {
          fs.rmSync(
            directory,
            {
              recursive: true,
              force: true,
            }
          );
        }
      } catch {}
    }
  }

  for (
    const [
      token,
      session,
    ] of extractionSessions
  ) {
    if (
      Date.now() -
        session.createdAt >
      MEDIA_TTL
    ) {
      extractionSessions.delete(
        token
      );
    }
  }
}

setInterval(
  cleanupExpiredMedia,
  5 * 60 * 1000
);

// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    service:
      "StreamBox Backend",
    status: "online",
    version: "11.0.0",
    architecture:
      "yt-dlp + FFmpeg + quality selection",
    youtube:
      "disabled",
    genericLinks:
      "yt-dlp supported public URLs",
    timestamp:
      new Date().toISOString(),
  });
});

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,
      status: "online",
      service:
        "StreamBox Backend",
      version: "11.0.0",
      timestamp:
        new Date().toISOString(),
    });
  }
);

// ============================================================
// EXTRACT GET
// ============================================================

app.get(
  "/api/extract",
  (req, res) => {
    res.json({
      success: true,
      message:
        "Use POST /api/extract with { url }",
    });
  }
);

// ============================================================
// EXTRACT
// ============================================================

app.post(
  "/api/extract",
  async (req, res) => {
    const started =
      Date.now();

    try {
      const inputUrl =
        cleanInputUrl(
          req.body?.url
        );

      if (!inputUrl) {
        return res.status(400).json({
          success: false,
          error:
            "Please provide a video URL.",
        });
      }

      if (
        !isValidHttpUrl(
          inputUrl
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid URL.",
        });
      }

      if (
        isYouTubeUrl(
          inputUrl
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            "YouTube downloads are not supported by StreamBox.",
        });
      }

      let platform =
        getPlatform(
          inputUrl
        );

      const preparedUrl =
        await prepareUrl(
          platform,
          inputUrl
        );

      if (
        isYouTubeUrl(
          preparedUrl
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            "YouTube downloads are not supported by StreamBox.",
        });
      }

      // Instagram profile protection.
      if (
        platform ===
        "instagram"
      ) {
        try {
          const parsed =
            new URL(inputUrl);

          const segments =
            parsed.pathname
              .split("/")
              .filter(Boolean);

          const blocked =
            new Set([
              "accounts",
              "about",
              "explore",
              "direct",
              "reels",
              "reel",
              "p",
              "tv",
              "stories",
              "web",
              "developer",
              "privacy",
              "terms",
            ]);

          if (
            segments.length === 1 &&
            !blocked.has(
              segments[0]
                .toLowerCase()
            )
          ) {
            return res.status(400).json({
              success: false,
              error:
                "Instagram profile URLs are not supported. Please enter an Instagram video or reel URL.",
            });
          }
        } catch {}
      }

      console.log(
        `[EXTRACT] ${preparedUrl}`
      );

      const metadata =
        await extractMetadata(
          preparedUrl
        );

      const qualities =
        buildQualityList(
          metadata
        );

      if (
        qualities.length === 0
      ) {
        throw new Error(
          "No downloadable video qualities were found for this URL."
        );
      }

      // Limit the number of qualities
      // returned to Flutter.
      const limitedQualities =
        qualities
          .slice(0, 8);

      const token =
        createExtractionSession({
          sourceUrl:
            preparedUrl,
          originalUrl:
            inputUrl,
          platform,
          metadata,
          qualities:
            limitedQualities,
        });

      const best =
        limitedQualities[0];

      const processingTimeMs =
        Date.now() -
        started;

      return res.json({
        success: true,

        token,

        platform,

        sourceUrl:
          inputUrl,

        preparedUrl,

        title:
          metadata.title ||
          "StreamBox Video",

        thumbnail:
          metadata.thumbnail ||
          null,

        duration:
          metadata.duration ||
          null,

        width:
          metadata.width ||
          null,

        height:
          metadata.height ||
          null,

        previewUrl:
          best?.previewUrl ||
          null,

        qualities:
          limitedQualities,

        formats:
          limitedQualities,

        processingTimeMs,
      });
    } catch (error) {
      console.error(
        "[EXTRACT ERROR]",
        error?.message ||
          error
      );

      return res.status(500).json({
        success: false,
        error:
          friendlyYtDlpError(
            error
          ),
        processingTimeMs:
          Date.now() -
          started,
      });
    }
  }
);

// ============================================================
// DOWNLOAD SELECTED QUALITY
// ============================================================

app.post(
  "/api/download",
  async (req, res) => {
    try {
      const token =
        req.body?.token
          ?.toString()
          .trim();

      const formatId =
        req.body?.formatId
          ?.toString()
          .trim();

      if (!token) {
        return res.status(400).json({
          success: false,
          error:
            "Download session is missing.",
        });
      }

      if (!formatId) {
        return res.status(400).json({
          success: false,
          error:
            "Video quality is missing.",
        });
      }

      const session =
        getExtractionSession(
          token
        );

      if (!session) {
        return res.status(404).json({
          success: false,
          error:
            "Download session expired. Please extract the URL again.",
        });
      }

      const allowed =
        session.qualities.some(
          (quality) =>
            String(
              quality.id
            ) ===
            String(formatId)
        );

      if (!allowed) {
        return res.status(400).json({
          success: false,
          error:
            "Selected video quality is no longer available.",
        });
      }

      console.log(
        `[DOWNLOAD] ${session.platform} ${formatId}`
      );

      const job =
        await downloadSelectedFormat(
          session,
          formatId
        );

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Length",
        job.fileSize
      );

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="StreamBox.mp4"'
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      const stream =
        fs.createReadStream(
          job.filePath
        );

      stream.on(
        "error",
        (error) => {
          console.error(
            "[STREAM ERROR]",
            error
          );

          if (
            !res.headersSent
          ) {
            res.status(500).end();
          }
        }
      );

      stream.on(
        "close",
        () => {
          setTimeout(() => {
            try {
              fs.rmSync(
                job.jobDir,
                {
                  recursive: true,
                  force: true,
                }
              );
            } catch {}
          }, 5000);
        }
      );

      stream.pipe(res);
    } catch (error) {
      console.error(
        "[DOWNLOAD ERROR]",
        error?.message ||
          error
      );

      if (
        !res.headersSent
      ) {
        res.status(500).json({
          success: false,
          error:
            friendlyYtDlpError(
              error
            ),
        });
      }
    }
  }
);

// ============================================================
// FRIENDLY ERRORS
// ============================================================

function friendlyYtDlpError(
  error
) {
  const message =
    String(
      error?.message ||
        error ||
        ""
    );

  const lower =
    message.toLowerCase();

  if (
    lower.includes("private") ||
    lower.includes("login") ||
    lower.includes("sign in")
  ) {
    return "This video appears to require login or is private.";
  }

  if (
    lower.includes("unsupported url")
  ) {
    return "This website or URL is not supported.";
  }

  if (
    lower.includes("age-restricted")
  ) {
    return "This video is age restricted and cannot be downloaded.";
  }

  if (
    lower.includes("not available")
  ) {
    return "This video is not available.";
  }

  if (
    lower.includes("copyright")
  ) {
    return "This media cannot be accessed because of a copyright restriction.";
  }

  if (
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return "The server took too long to process this video. Please try again.";
  }

  return message.length > 500
    ? "Unable to process this video. Please try another public video URL."
    : message ||
        "Unable to process this video.";
}

// ============================================================
// TOOLS
// ============================================================

app.get(
  "/api/tools",
  async (req, res) => {
    const result = {
      success: true,

      ytDlp: {
        path:
          getYtDlpPath(),
        installed:
          fs.existsSync(
            getYtDlpPath()
          ),
      },

      ffmpeg: {
        path:
          FFMPEG_PATH,
        installed:
          fs.existsSync(
            FFMPEG_PATH
          ),
      },

      deno: {
        path:
          DENO_PATH,
        installed:
          fs.existsSync(
            DENO_PATH
          ),
      },

      timestamp:
        new Date().toISOString(),
    };

    try {
      const version =
        await runCommand(
          getYtDlpPath(),
          ["--version"],
          {
            timeout: 15000,
          }
        );

      result.ytDlp.version =
        version.stdout.trim();
    } catch (error) {
      result.ytDlp.version =
        null;
    }

    try {
      const ffmpeg =
        await runCommand(
          FFMPEG_PATH,
          ["-version"],
          {
            timeout: 15000,
          }
        );

      result.ffmpeg.version =
        ffmpeg.stdout
          .split(/\r?\n/)[0];
    } catch (error) {
      result.ffmpeg.version =
        null;
    }

    try {
      const deno =
        await runCommand(
          DENO_PATH,
          ["--version"],
          {
            timeout: 15000,
          }
        );

      result.deno.version =
        deno.stdout
          .split(/\r?\n/)[0];
    } catch (error) {
      result.deno.version =
        null;
    }

    res.json(result);
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      error:
        "Endpoint not found",
      path: req.path,
      method: req.method,
    });
  }
);

// ============================================================
// GLOBAL ERROR
// ============================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
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
      error:
        "Internal server error",
    });
  }
);

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");
    console.log(
      "============================================================"
    );
    console.log(
      "              STREAMBOX BACKEND v11.0.0"
    );
    console.log(
      "============================================================"
    );
    console.log(
      `Port: ${PORT}`
    );
    console.log(
      `Node: ${process.version}`
    );
    console.log(
      `yt-dlp: ${getYtDlpPath()}`
    );
    console.log(
      `FFmpeg: ${FFMPEG_PATH}`
    );
    console.log(
      `Deno: ${DENO_PATH}`
    );
    console.log("");
    console.log(
      "YouTube: DISABLED"
    );
    console.log(
      "Generic yt-dlp public URLs: ENABLED"
    );
    console.log(
      "Quality selection: ENABLED"
    );
    console.log(
      "Preview metadata: ENABLED"
    );
    console.log(
      "============================================================"
    );
  }
);