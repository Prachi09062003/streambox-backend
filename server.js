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

const FFPROBE_PATH =
  process.env.FFPROBE_PATH ||
  "/usr/bin/ffprobe";

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

// ============================================================
// EXTRACTION SESSIONS
// ============================================================

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
// INSTAGRAM OPENGRAPH FALLBACK SCRAPER
// ============================================================

async function fetchInstagramDirectUrl(targetUrl) {
  try {
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    
    // Search for OpenGraph video meta tag which holds the direct video CDN link
    const match = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/i);
    if (match && match[1]) {
      // Decode HTML entities if any
      return match[1].replace(/&amp;/g, "&");
    }

    return null;
  } catch (error) {
    console.error("[OG SCRAPER ERROR]", error?.message || error);
    return null;
  }
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
// COMMAND RUNNER
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

    child.stdout.on(
      "data",
      (data) => {
        stdout += data.toString();
      }
    );

    child.stderr.on(
      "data",
      (data) => {
        stderr += data.toString();
      }
    );

    child.on(
      "error",
      (error) => {
        if (finished) return;

        finished = true;

        clearTimeout(timer);

        reject(error);
      }
    );

    child.on(
      "close",
      (code) => {
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
          const error =
            new Error(
              stderr.trim() ||
                stdout.trim() ||
                `Command failed with code ${code}`
            );

          error.code = code;
          error.stdout = stdout;
          error.stderr = stderr;

          reject(error);
        }
      }
    );
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

  for (
    const candidate of candidates
  ) {
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

  if (format?.format_note) {
    return String(
      format.format_note
    );
  }

  return "Best";
}

function formatScore(format) {
  let score = 0;

  if (hasVideo(format)) {
    score += 1000;
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

  if (hasAudio(format)) {
    score += 100;
  }

  return score;
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

  formats.sort((a, b) => {
    const heightA =
      formatHeight(a);

    const heightB =
      formatHeight(b);

    if (
      heightA !== heightB
    ) {
      return heightB - heightA;
    }

    const scoreA =
      formatScore(a);

    const scoreB =
      formatScore(b);

    return scoreB - scoreA;
  });

  const byHeight =
    new Map();

  for (
    const format of formats
  ) {
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
    ).sort(
      (a, b) => b - a
    );

  for (
    const height of sortedHeights
  ) {
    const format =
      byHeight.get(height);

    if (!format) {
      continue;
    }

    result.push({
      id:
        String(
          format.format_id
        ),

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
        String(
          combined.format_id
        )
    )
  ) {
    result.unshift({
      id:
        String(
          combined.format_id
        ),

      label:
        `${formatLabel(combined)} • Audio`,

      height:
        formatHeight(combined),

      width:
        Number(
          combined.width || 0
        ) || null,

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

// ============================================================
// TOKEN & SESSIONS
// ============================================================

function createToken() {
  return crypto
    .randomBytes(24)
    .toString("hex");
}

function createExtractionSession(data) {
  const token =
    createToken();

  extractionSessions.set(
    token,
    {
      ...data,

      createdAt:
        Date.now(),
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
    extractionSessions.get(
      token
    );

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
// VERIFY STREAMS (FFPROBE)
// ============================================================

async function verifyAudioStream(
  filePath
) {
  try {
    const result =
      await runCommand(
        FFPROBE_PATH,
        [
          "-v",
          "error",
          "-i",
          filePath,
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=codec_name",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
        ],
        {
          timeout: 30000,
        }
      );

    const codec =
      result.stdout.trim();

    console.log(
      `[AUDIO CHECK] Codec: ${
        codec || "NONE"
      }`
    );

    return Boolean(codec);
  } catch (error) {
    console.error(
      "[AUDIO CHECK ERROR]",
      error?.message ||
        error
    );

    return false;
  }
}

async function verifyVideoStream(
  filePath
) {
  try {
    const result =
      await runCommand(
        FFPROBE_PATH,
        [
          "-v",
          "error",
          "-i",
          filePath,
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=codec_name",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
        ],
        {
          timeout: 30000,
        }
      );

    const codec =
      result.stdout.trim();

    console.log(
      `[VIDEO CHECK] Codec: ${
        codec || "NONE"
      }`
    );

    return Boolean(codec);
  } catch (error) {
    console.error(
      "[VIDEO CHECK ERROR]",
      error?.message ||
        error
    );

    return false;
  }
}

// ============================================================
// SERVER DOWNLOAD (FINAL INSTAGRAM PROGRESSED FIX)
// ============================================================

async function downloadSelectedFormat(
  session,
  formatId
) {
  const jobToken = createToken();
  const jobDir = path.join(MEDIA_DIR, jobToken);

  fs.mkdirSync(jobDir, { recursive: true });

  const outputTemplate = path.join(jobDir, "streambox.%(ext)s");
  const ytDlp = getYtDlpPath();

  let formatSelector;
  if (session.platform === "instagram") {
    formatSelector = "best";
  } else {
    const selectedQuality = session.qualities.find(
      (quality) => String(quality.id) === String(formatId)
    );
    
    if (!selectedQuality) {
      throw new Error("Selected video quality is not available.");
    }
    
    formatSelector = selectedQuality.hasAudio ? `${formatId}/best` : `${formatId}+bestaudio/best`;
  }

  const args = [
    ...getCommonYtDlpArgs(),
    "-f",
    formatSelector,
    "--merge-output-format",
    "mp4",
    "--ffmpeg-location",
    FFMPEG_PATH,
    "--output",
    outputTemplate,
    "--no-part",
    "--no-continue",
    "--referer",
    session.sourceUrl,
    session.sourceUrl,
  ];

  try {
    // Attempt standard yt-dlp download first
    await runCommand(ytDlp, args, {
      timeout: DOWNLOAD_TIMEOUT,
      cwd: jobDir,
    });
  } catch (ytError) {
    // If Instagram and yt-dlp fails, attempt direct OpenGraph fallback scraping
    if (session.platform === "instagram") {
      console.log("[DOWNLOAD FALLBACK] yt-dlp failed, attempting direct OpenGraph scrape...");
      const directUrl = await fetchInstagramDirectUrl(session.sourceUrl);
      
      if (directUrl) {
        const fallbackArgs = [
          "-y",
          "-i",
          directUrl,
          "-c",
          "copy",
          path.join(jobDir, "streambox.mp4"),
        ];
        
        await runCommand(FFMPEG_PATH, fallbackArgs, {
          timeout: DOWNLOAD_TIMEOUT,
        });
      } else {
        throw ytError;
      }
    } else {
      throw ytError;
    }
  }

  const downloadedFile = findDownloadedFile(jobDir);

  if (!downloadedFile) {
    throw new Error("Completed but no media file was created.");
  }

  let finalFile = downloadedFile;

  if (!downloadedFile.toLowerCase().endsWith(".mp4")) {
    finalFile = path.join(jobDir, "streambox.mp4");
    await normalizeToMp4(downloadedFile, finalFile);
  }

  const stat = fs.statSync(finalFile);
  if (stat.size <= 0) {
    throw new Error("Final video is empty.");
  }

  return {
    jobToken,
    jobDir,
    filePath: finalFile,
    fileSize: stat.size,
  };
}

// ============================================================
// FIND FILE
// ============================================================

function findDownloadedFile(
  directory
) {
  if (
    !fs.existsSync(
      directory
    )
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
    fs.readdirSync(
      directory
    )
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

  const stat =
    fs.statSync(
      outputFile
    );

  if (stat.size <= 0) {
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
    fs.existsSync(
      MEDIA_DIR
    )
  ) {
    const now =
      Date.now();

    for (
      const entry of
        fs.readdirSync(
          MEDIA_DIR,
          {
            withFileTypes: true,
          }
        )
    ) {
      if (
        !entry.isDirectory()
      ) {
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
// ROOT & HEALTH
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,
      service: "StreamBox Backend",
      status: "online",
      version: "12.0.4",
      timestamp: new Date().toISOString(),
    });
  }
);

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,
      status: "online",
      timestamp: new Date().toISOString(),
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
          error: "Please provide a video URL.",
        });
      }

      if (
        !isValidHttpUrl(
          inputUrl
        )
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid URL.",
        });
      }

      if (
        isYouTubeUrl(
          inputUrl
        )
      ) {
        return res.status(400).json({
          success: false,
          error: "YouTube downloads are not supported by StreamBox.",
        });
      }

      const platform =
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
          error: "YouTube downloads are not supported by StreamBox.",
        });
      }

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
              segments[0].toLowerCase()
            )
          ) {
            return res.status(400).json({
              success: false,
              error: "Instagram profile URLs are not supported. Please enter an Instagram video or reel URL.",
            });
          }
        } catch {}
      }

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

      const limitedQualities =
        qualities.slice(
          0,
          8
        );

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
        previewUrl:
          best?.previewUrl ||
          null,
        qualities:
          limitedQualities,
        formats:
          limitedQualities,
        processingTimeMs:
          Date.now() -
          started,
      });
    } catch (error) {
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
// DOWNLOAD
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

      if (!token || !formatId) {
        return res.status(400).json({
          success: false,
          error: "Download session or quality ID is missing.",
        });
      }

      const session =
        getExtractionSession(
          token
        );

      if (!session) {
        return res.status(404).json({
          success: false,
          error: "Download session expired. Please extract the URL again.",
        });
      }

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
        () => {
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
          setTimeout(
            () => {
              try {
                fs.rmSync(
                  job.jobDir,
                  {
                    recursive:
                      true,
                    force:
                      true,
                  }
                );
              } catch {}
            },
            5000
          );
        }
      );

      stream.pipe(res);
    } catch (error) {
      if (
        !res.headersSent
      ) {
        return res.status(500).json({
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
// ERROR HANDLER & START
// ============================================================

function friendlyYtDlpError(error) {
  const message = String(error?.message || error || "");
  const lower = message.toLowerCase();

  if (lower.includes("private") || lower.includes("login")) {
    return "This video appears to require login or is private.";
  }
  if (lower.includes("copyright")) {
    return "This media cannot be accessed because of a copyright restriction.";
  }
  return message.length > 500 ? "Unable to process this video." : message || "Unable to process this video.";
}

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(`STREAMBOX BACKEND v12.0.4 running on port ${PORT}`);
  }
);