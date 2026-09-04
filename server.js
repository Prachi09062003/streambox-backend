const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
const YTDLP_TIMEOUT = 8 * 60 * 1000;
const FFMPEG_TIMEOUT = 8 * 60 * 1000;
const REDIRECT_TIMEOUT = 15 * 1000;

const MAX_FILE_AGE = 15 * 60 * 1000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

// ======================================================
// TEMP DIRECTORY
// ======================================================

const TEMP_DIR = path.join(
  process.env.TMPDIR ||
    process.env.TMP ||
    process.env.TEMP ||
    "/tmp",
  "streambox"
);

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, {
    recursive: true,
  });
}

// ======================================================
// EXECUTABLE PATHS
// ======================================================

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
    `[RESOLVE] Starting: ${currentUrl}`
  );

  for (let attempt = 0; attempt < 5; attempt++) {
    const controller =
      new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, REDIRECT_TIMEOUT);

    try {
      const response = await fetch(
        currentUrl,
        {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "User-Agent": USER_AGENT,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language":
              "en-US,en;q=0.9",
          },
        }
      );

      clearTimeout(timer);

      if (
        response.status >= 300 &&
        response.status < 400
      ) {
        const location =
          response.headers.get(
            "location"
          );

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
// PREPARE URL
// ======================================================

async function prepareUrl(
  platform,
  inputUrl
) {
  let url = normalizeUrl(inputUrl);

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

    url =
      await resolveRedirectUrl(url);
  }

  if (
    platform === "facebook" &&
    (
      url.includes("/share/") ||
      url.includes("fb.watch")
    )
  ) {
    console.log(
      "[PREPARE] Resolving Facebook URL"
    );

    url =
      await resolveRedirectUrl(url);
  }

  if (
    platform === "tiktok" &&
    (
      url.includes("vm.tiktok.com") ||
      url.includes("vt.tiktok.com")
    )
  ) {
    console.log(
      "[PREPARE] Resolving TikTok URL"
    );

    url =
      await resolveRedirectUrl(url);
  }

  if (platform === "youtube") {
    try {
      const parsed =
        new URL(url);

      if (
        parsed.hostname ===
        "youtu.be"
      ) {
        const videoId =
          parsed.pathname
            .split("/")
            .filter(Boolean)[0];

        if (videoId) {
          url =
            `https://www.youtube.com/watch?v=${videoId}`;
        }
      } else if (
        parsed.pathname.startsWith(
          "/shorts/"
        )
      ) {
        const videoId =
          parsed.pathname
            .split("/")
            .filter(Boolean)[1];

        if (videoId) {
          url =
            `https://www.youtube.com/watch?v=${videoId}`;
        }
      } else if (
        parsed.pathname.startsWith(
          "/embed/"
        )
      ) {
        const videoId =
          parsed.pathname
            .split("/")
            .filter(Boolean)[1];

        if (videoId) {
          url =
            `https://www.youtube.com/watch?v=${videoId}`;
        }
      } else if (
        parsed.pathname.startsWith(
          "/live/"
        )
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
        `[PREPARE] YouTube: ${url}`
      );
    } catch {
      // Keep original URL
    }
  }

  return url;
}

// ======================================================
// TIMEOUT HELPER
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

      const env = {
        ...process.env,

        PATH:
          "/usr/local/bin:/usr/bin:/bin:" +
          (process.env.PATH || ""),
      };

      try {
        child = spawn(
          command,
          args,
          {
            shell: false,
            windowsHide: true,
            env,
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

          const error =
            new Error(
              `${command} timed out after ${Math.round(
                timeoutMs / 1000
              )} seconds`
            );

          error.code =
            "COMMAND_TIMEOUT";

          reject(error);
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
                  stdout.trim() ||
                  `${command} exited with code ${code}`
              );

            error.code =
              `COMMAND_EXIT_${code}`;

            error.stderr =
              stderr;

            error.stdout =
              stdout;

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
// COMMAND CHECK
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

    const combined =
      `${result.stdout}\n${result.stderr}`
        .trim();

    const version =
      combined
        .split("\n")
        .find(
          (line) =>
            line.trim()
        ) || null;

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
      code:
        error.code || null,
    };
  }
}

// ======================================================
// FIND YT-DLP
// ======================================================

async function findYtDlp() {
  const possiblePaths = [
    YTDLP_PATH,
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    "/bin/yt-dlp",
    "yt-dlp",
  ];

  const uniquePaths =
    [...new Set(possiblePaths)];

  for (
    const executable
    of uniquePaths
  ) {
    try {
      const result =
        await runCommand(
          executable,
          ["--version"],
          10000
        );

      const version =
        result.stdout
          .trim()
          .split("\n")[0] ||
        result.stderr
          .trim()
          .split("\n")[0] ||
        null;

      console.log(
        `[YTDLP] Found: ${executable}`
      );

      console.log(
        `[YTDLP] Version: ${version}`
      );

      return {
        path: executable,
        version,
      };
    } catch {
      // Try next
    }
  }

  return null;
}

// ======================================================
// FIND FFMPEG
// ======================================================

async function findFfmpeg() {
  const possiblePaths = [
    FFMPEG_PATH,
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "ffmpeg",
  ];

  const uniquePaths =
    [...new Set(possiblePaths)];

  for (
    const executable
    of uniquePaths
  ) {
    try {
      const result =
        await runCommand(
          executable,
          ["-version"],
          10000
        );

      const combined =
        `${result.stdout}\n${result.stderr}`
          .trim();

      const version =
        combined
          .split("\n")
          .find(
            (line) =>
              line.includes("ffmpeg version")
          ) ||
        combined
          .split("\n")[0] ||
        null;

      console.log(
        `[FFMPEG] Found: ${executable}`
      );

      return {
        path: executable,
        version,
      };
    } catch {
      // Try next
    }
  }

  return null;
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
        `Unsupported extractor: ${platform}`
      );
  }
}

// ======================================================
// MEDIA URL DETECTION
// ======================================================

function isLikelyMediaUrl(url) {
  if (!isValidHttpUrl(url)) {
    return false;
  }

  const lower =
    url.toLowerCase();

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
    lower.includes("stream") ||
    lower.includes("cdn")
  );
}

function isKnownMediaKey(key) {
  const normalized =
    key.toLowerCase();

  return [
    "url",
    "video_url",
    "videourl",
    "video",
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
  ].includes(normalized);
}

// ======================================================
// QUALITY
// ======================================================

function getNumericQuality(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return 0;
  }

  const text =
    String(value);

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
      Number(heightMatch[1]) *
      1000
    );
  }

  return 0;
}

function scoreMediaUrl(url) {
  if (
    typeof url !== "string"
  ) {
    return -1;
  }

  const lower =
    url.toLowerCase();

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
    score += 60;
  }

  if (
    lower.includes(".m3u8")
  ) {
    score += 45;
  }

  if (
    lower.includes("1080")
  ) {
    score += 35;
  }

  if (
    lower.includes("720")
  ) {
    score += 25;
  }

  if (
    lower.includes("480")
  ) {
    score += 15;
  }

  if (
    lower.includes("video")
  ) {
    score += 20;
  }

  if (
    lower.includes("download")
  ) {
    score += 15;
  }

  return score;
}

// ======================================================
// MEDIA CANDIDATES
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

  if (
    typeof value === "string"
  ) {
    if (
      isValidHttpUrl(value) &&
      isLikelyMediaUrl(value)
    ) {
      found.push({
        url: value,
        width: 0,
        height: 0,
        quality:
          getNumericQuality(value),
        score:
          scoreMediaUrl(value),
      });
    }

    return found;
  }

  if (Array.isArray(value)) {
    for (
      const item of value
    ) {
      collectMediaCandidates(
        item,
        found,
        depth + 1
      );
    }

    return found;
  }

  if (
    typeof value === "object"
  ) {
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

    const objectQuality =
      width > 0 &&
      height > 0
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
            width,
            height,
            quality:
              objectQuality ||
              getNumericQuality(
                item
              ),
            score:
              scoreMediaUrl(item) +
              objectQuality /
                100000,
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

function extractBestMedia(
  result
) {
  const candidates =
    collectMediaCandidates(
      result
    );

  const unique = [];
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

      unique.push(
        candidate
      );
    }
  }

  unique.sort(
    (a, b) => {
      const qualityDiff =
        (b.quality || 0) -
        (a.quality || 0);

      if (
        qualityDiff !== 0
      ) {
        return qualityDiff;
      }

      return (
        (b.score || 0) -
        (a.score || 0)
      );
    }
  );

  return unique;
}

// ======================================================
// SAFE FILE NAME
// ======================================================

function safeFileName(
  value
) {
  if (
    typeof value !== "string"
  ) {
    return "streambox_video";
  }

  return value
    .replace(
      /[<>:"/\\|?*\x00-\x1F]/g,
      ""
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim()
    .substring(0, 100) ||
    "streambox_video";
}

// ======================================================
// CREATE JOB ID
// ======================================================

function createJobId() {
  return crypto
    .randomBytes(18)
    .toString("hex");
}

// ======================================================
// FILE INFO
// ======================================================

function getFileSize(filePath) {
  try {
    return fs.statSync(
      filePath
    ).size;
  } catch {
    return 0;
  }
}

function fileExists(filePath) {
  try {
    return (
      fs.existsSync(
        filePath
      ) &&
      fs.statSync(
        filePath
      ).isFile()
    );
  } catch {
    return false;
  }
}

// ======================================================
// CLEANUP OLD FILES
// ======================================================

function cleanupTempFiles() {
  try {
    if (
      !fs.existsSync(
        TEMP_DIR
      )
    ) {
      return;
    }

    const now =
      Date.now();

    const files =
      fs.readdirSync(
        TEMP_DIR
      );

    for (
      const file of files
    ) {
      const fullPath =
        path.join(
          TEMP_DIR,
          file
        );

      try {
        const stat =
          fs.statSync(
            fullPath
          );

        if (
          now -
            stat.mtimeMs >
          MAX_FILE_AGE
        ) {
          fs.unlinkSync(
            fullPath
          );

          console.log(
            `[CLEANUP] Deleted ${file}`
          );
        }
      } catch {}
    }
  } catch (error) {
    console.log(
      `[CLEANUP] Error: ${error.message}`
    );
  }
}

setInterval(
  cleanupTempFiles,
  5 * 60 * 1000
);

// ======================================================
// FFMPEG NORMALIZE
// ======================================================

async function normalizeMediaToMp4(
  inputUrl,
  outputFile,
  referer = null
) {
  const ffmpeg =
    await findFfmpeg();

  if (!ffmpeg) {
    const error =
      new Error(
        "FFmpeg executable not found"
      );

    error.code =
      "FFMPEG_NOT_FOUND";

    throw error;
  }

  console.log(
    `[FFMPEG] Normalizing media`
  );

  console.log(
    `[FFMPEG] Input URL available`
  );

  const headers = [
    `User-Agent: ${USER_AGENT}`,
  ];

  if (referer) {
    headers.push(
      `Referer: ${referer}`
    );
  }

  const args = [
    "-y",

    "-hide_banner",

    "-loglevel",
    "warning",

    "-headers",
    `${headers.join("\r\n")}\r\n`,

    "-i",
    inputUrl,

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

    "-f",
    "mp4",

    outputFile,
  ];

  try {
    await runCommand(
      ffmpeg.path,
      args,
      FFMPEG_TIMEOUT
    );
  } catch (error) {
    console.error(
      "[FFMPEG] Failed:",
      error.stderr ||
        error.message
    );

    throw error;
  }

  if (
    !fileExists(outputFile)
  ) {
    throw new Error(
      "FFmpeg did not create output file"
    );
  }

  const size =
    getFileSize(
      outputFile
    );

  if (size <= 0) {
    throw new Error(
      "FFmpeg created an empty file"
    );
  }

  console.log(
    `[FFMPEG] MP4 created: ${size} bytes`
  );

  return {
    filePath: outputFile,
    size,
  };
}

// ======================================================
// YOUTUBE DOWNLOAD
// ======================================================

async function downloadYouTube(
  url
) {
  const ytDlp =
    await findYtDlp();

  if (!ytDlp) {
    const error =
      new Error(
        `yt-dlp executable not found. Expected ${YTDLP_PATH}`
      );

    error.code =
      "YTDLP_NOT_FOUND";

    throw error;
  }

  const ffmpeg =
    await findFfmpeg();

  if (!ffmpeg) {
    const error =
      new Error(
        "FFmpeg executable not found"
      );

    error.code =
      "FFMPEG_NOT_FOUND";

    throw error;
  }

  const jobId =
    createJobId();

  const outputTemplate =
    path.join(
      TEMP_DIR,
      `${jobId}.%(ext)s`
    );

  const finalFile =
    path.join(
      TEMP_DIR,
      `${jobId}.mp4`
    );

  console.log(
    `[YOUTUBE] Job: ${jobId}`
  );

  console.log(
    `[YOUTUBE] yt-dlp: ${ytDlp.path}`
  );

  console.log(
    `[YOUTUBE] FFmpeg: ${ffmpeg.path}`
  );

  const args = [
    "--no-playlist",

    "--no-warnings",

    "--ignore-config",

    "--restrict-filenames",

    "--format",
    "bv*[height<=1080]+ba/b[height<=1080]/b",

    "--merge-output-format",
    "mp4",

    "--ffmpeg-location",
    ffmpeg.path,

    "--output",
    outputTemplate,

    "--print",
    "after_move:filepath",

    "--user-agent",
    USER_AGENT,

    url,
  ];

  let result;

  try {
    result =
      await runCommand(
        ytDlp.path,
        args,
        YTDLP_TIMEOUT
      );
  } catch (error) {
    console.error(
      "[YOUTUBE] yt-dlp failed"
    );

    console.error(
      error.stderr ||
        error.message
    );

    if (
      error.code ===
      "ENOENT"
    ) {
      const notFound =
        new Error(
          `yt-dlp executable not found at ${ytDlp.path}`
        );

      notFound.code =
        "YTDLP_NOT_FOUND";

      throw notFound;
    }

    throw error;
  }

  console.log(
    "[YOUTUBE] yt-dlp completed"
  );

  let actualFile =
    null;

  const printedPaths =
    result.stdout
      .split("\n")
      .map(
        (line) =>
          line.trim()
      )
      .filter(Boolean);

  for (
    const line of printedPaths
  ) {
    if (
      line.endsWith(".mp4") &&
      fileExists(line)
    ) {
      actualFile =
        line;

      break;
    }
  }

  if (
    !actualFile &&
    fileExists(finalFile)
  ) {
    actualFile =
      finalFile;
  }

  if (!actualFile) {
    const files =
      fs
        .readdirSync(
          TEMP_DIR
        )
        .filter(
          (file) =>
            file.startsWith(
              jobId
            )
        );

    const mp4 =
      files.find(
        (file) =>
          file.endsWith(
            ".mp4"
          )
      );

    if (mp4) {
      actualFile =
        path.join(
          TEMP_DIR,
          mp4
        );
    }
  }

  if (
    !actualFile ||
    !fileExists(actualFile)
  ) {
    throw new Error(
      "yt-dlp completed but no MP4 file was created"
    );
  }

  const size =
    getFileSize(
      actualFile
    );

  if (size <= 0) {
    throw new Error(
      "YouTube MP4 file is empty"
    );
  }

  // ----------------------------------------------
  // Get metadata separately
  // ----------------------------------------------

  let metadata = {};

  try {
    const metadataResult =
      await runCommand(
        ytDlp.path,
        [
          "--dump-single-json",
          "--no-playlist",
          "--skip-download",
          "--no-warnings",
          "--ignore-config",
          "--user-agent",
          USER_AGENT,
          url,
        ],
        120000
      );

    metadata =
      JSON.parse(
        metadataResult.stdout
      );
  } catch (error) {
    console.log(
      "[YOUTUBE] Metadata lookup failed, continuing"
    );
  }

  return {
    filePath:
      actualFile,

    size,

    title:
      metadata.title ||
      "YouTube video",

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

    hasAudio:
      true,

    jobId,
  };
}

// ======================================================
// NON-YOUTUBE DOWNLOAD
// ======================================================

async function downloadOtherPlatform(
  platform,
  sourceUrl
) {
  const result =
    await withTimeout(
      runBtchExtractor(
        platform,
        sourceUrl
      ),
      EXTRACTION_TIMEOUT
    );

  console.log(
    `[RESULT] ${platform}: ${
      Array.isArray(result)
        ? "array"
        : typeof result
    }`
  );

  const candidates =
    extractBestMedia(
      result
    );

  console.log(
    `[${platform.toUpperCase()}] Candidates: ${candidates.length}`
  );

  candidates
    .slice(0, 10)
    .forEach(
      (candidate, index) => {
        console.log(
          `[${platform.toUpperCase()}] ` +
          `#${index + 1} ` +
          `${candidate.width || "?"}x${
            candidate.height || "?"
          }`
        );
      }
    );

  if (
    candidates.length === 0
  ) {
    if (
      platform === "pinterest"
    ) {
      const imageOnly =
        JSON.stringify(
          result
        )
          .toLowerCase()
          .includes(
            "image"
          );

      if (imageOnly) {
        const error =
          new Error(
            "This Pinterest Pin contains an image rather than a downloadable video."
          );

        error.code =
          "IMAGE_ONLY";

        throw error;
      }
    }

    const error =
      new Error(
        "No downloadable media URL found"
      );

    error.code =
      "NO_MEDIA_URL";

    throw error;
  }

  // ==================================================
  // Try candidates in order
  // ==================================================

  for (
    let index = 0;
    index <
      Math.min(
        candidates.length,
        5
      );
    index++
  ) {
    const candidate =
      candidates[index];

    const jobId =
      createJobId();

    const outputFile =
      path.join(
        TEMP_DIR,
        `${jobId}.mp4`
      );

    console.log(
      `[${platform.toUpperCase()}] Trying candidate ${
        index + 1
      }`
    );

    try {
      const normalized =
        await normalizeMediaToMp4(
          candidate.url,
          outputFile,
          sourceUrl
        );

      console.log(
        `[${platform.toUpperCase()}] MP4 ready`
      );

      return {
        filePath:
          normalized.filePath,

        size:
          normalized.size,

        width:
          candidate.width ||
          null,

        height:
          candidate.height ||
          null,

        hasAudio:
          null,

        sourceMediaUrl:
          candidate.url,

        jobId,
      };
    } catch (error) {
      console.error(
        `[${platform.toUpperCase()}] Candidate ${
          index + 1
        } failed:`,
        error.message
      );

      try {
        if (
          fs.existsSync(
            outputFile
          )
        ) {
          fs.unlinkSync(
            outputFile
          );
        }
      } catch {}
    }
  }

  throw new Error(
    `Unable to convert ${platform} media to MP4`
  );
}

// ======================================================
// MAIN MEDIA CREATION
// ======================================================

async function createMediaFile(
  platform,
  url
) {
  if (
    platform === "youtube"
  ) {
    return await downloadYouTube(
      url
    );
  }

  return await downloadOtherPlatform(
    platform,
    url
  );
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
      version: "6.0.0",
      architecture:
        "Server-side MP4 normalization",
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
      version: "6.0.0",
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
        YTDLP_PATH,
        ["--version"]
      );

    const ffmpeg =
      await checkCommand(
        FFMPEG_PATH,
        ["-version"]
      );

    const foundYtDlp =
      await findYtDlp();

    const foundFfmpeg =
      await findFfmpeg();

    res.json({
      success: true,

      node:
        process.version,

      platform:
        process.platform,

      architecture:
        process.arch,

      ytDlp: {
        installed:
          !!foundYtDlp,

        path:
          foundYtDlp?.path ||
          YTDLP_PATH,

        version:
          foundYtDlp?.version ||
          ytDlp.version ||
          null,

        configuredPath:
          YTDLP_PATH,
      },

      ffmpeg: {
        installed:
          !!foundFfmpeg,

        path:
          foundFfmpeg?.path ||
          FFMPEG_PATH,

        version:
          foundFfmpeg?.version ||
          ffmpeg.version ||
          null,

        configuredPath:
          FFMPEG_PATH,
      },

      tempDirectory:
        TEMP_DIR,

      timestamp:
        new Date().toISOString(),
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

      method:
        "POST",

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
      // ==============================================
      // VALIDATE
      // ==============================================

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

      // ==============================================
      // PLATFORM
      // ==============================================

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

      // ==============================================
      // PREPARE
      // ==============================================

      const preparedUrl =
        await prepareUrl(
          platform,
          inputUrl
        );

      console.log(
        `[REQUEST] Prepared URL: ${preparedUrl}`
      );

      // ==============================================
      // CREATE MP4
      // ==============================================

      let media;

      try {
        media =
          await createMediaFile(
            platform,
            preparedUrl
          );
      } catch (error) {
        console.error(
          `[EXTRACTION ERROR] ${platform}:`,
          error.message
        );

        const lower =
          (
            error.message ||
            ""
          ).toLowerCase();

        let code =
          error.code ||
          "EXTRACTOR_FAILED";

        if (
          error.code ===
            "YTDLP_NOT_FOUND" ||
          lower.includes(
            "yt-dlp executable not found"
          )
        ) {
          code =
            "YTDLP_NOT_FOUND";
        }

        if (
          error.code ===
            "FFMPEG_NOT_FOUND" ||
          lower.includes(
            "ffmpeg executable not found"
          )
        ) {
          code =
            "FFMPEG_NOT_FOUND";
        }

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
            error.message ||
            "Media extraction failed",

          message:
            "The content may be private, deleted, restricted, expired, unsupported, or the platform extractor may need an update.",

          sourceUrl:
            inputUrl,
        });
      }

      // ==============================================
      // VERIFY FILE
      // ==============================================

      if (
        !media?.filePath ||
        !fileExists(
          media.filePath
        )
      ) {
        return res.status(502).json({
          success: false,

          code:
            "MEDIA_FILE_NOT_CREATED",

          platform,

          error:
            "Backend failed to create the MP4 file",
        });
      }

      const size =
        getFileSize(
          media.filePath
        );

      if (size <= 0) {
        return res.status(502).json({
          success: false,

          code:
            "EMPTY_MEDIA_FILE",

          platform,

          error:
            "Generated MP4 file is empty",
        });
      }

      // ==============================================
      // MEDIA ID
      // ==============================================

      const fileName =
        path.basename(
          media.filePath
        );

      const mediaUrl =
        `${req.protocol}://${req.get(
          "host"
        )}/api/media/${encodeURIComponent(
          fileName
        )}`;

      const processingTimeMs =
        Date.now() -
        started;

      console.log(
        `[SUCCESS] ${platform}`
      );

      console.log(
        `[SUCCESS] File: ${fileName}`
      );

      console.log(
        `[SUCCESS] Size: ${size} bytes`
      );

      console.log(
        `[SUCCESS] Time: ${processingTimeMs}ms`
      );

      console.log(
        "================================================"
      );

      // ==============================================
      // RESPONSE
      // ==============================================

      return res.status(200).json({
        success: true,

        platform,

        mediaUrl,

        format:
          "mp4",

        extension:
          "mp4",

        fileName,

        fileSize:
          size,

        resolution:
          media.height
            ? `${media.height}p`
            : null,

        sourceUrl:
          inputUrl,

        processingTimeMs,

        title:
          media.title ||
          null,

        thumbnail:
          media.thumbnail ||
          null,

        duration:
          media.duration ||
          null,

        width:
          media.width ||
          null,

        height:
          media.height ||
          null,

        hasAudio:
          media.hasAudio ??
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
// MEDIA DOWNLOAD ENDPOINT
// ======================================================

app.get(
  "/api/media/:fileName",
  (req, res) => {
    try {
      const fileName =
        path.basename(
          req.params.fileName
        );

      if (
        !fileName ||
        fileName !==
          req.params.fileName
      ) {
        return res.status(400).json({
          success: false,

          code:
            "INVALID_FILE_NAME",

          error:
            "Invalid media file name",
        });
      }

      if (
        !fileName.endsWith(
          ".mp4"
        )
      ) {
        return res.status(400).json({
          success: false,

          code:
            "INVALID_MEDIA_TYPE",

          error:
            "Only MP4 media files are served",
        });
      }

      const filePath =
        path.join(
          TEMP_DIR,
          fileName
        );

      if (
        !fileExists(
          filePath
        )
      ) {
        return res.status(404).json({
          success: false,

          code:
            "MEDIA_EXPIRED",

          error:
            "Media file not found or has expired",
        });
      }

      const stat =
        fs.statSync(
          filePath
        );

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Length",
        stat.size
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`
      );

      res.setHeader(
        "Accept-Ranges",
        "bytes"
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      const stream =
        fs.createReadStream(
          filePath
        );

      stream.on(
        "error",
        (error) => {
          console.error(
            "[MEDIA STREAM ERROR]",
            error.message
          );

          if (
            !res.headersSent
          ) {
            res.status(500).end();
          }
        }
      );

      stream.pipe(res);
    } catch (error) {
      console.error(
        "[MEDIA ERROR]",
        error.message
      );

      if (
        !res.headersSent
      ) {
        res.status(500).json({
          success: false,

          code:
            "MEDIA_SERVER_ERROR",

          error:
            "Unable to serve media",
        });
      }
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
        "Endpoint not found",

      path:
        req.path,

      method:
        req.method,
    });
  }
);

// ======================================================
// GLOBAL ERROR
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
// START
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
      "          STREAMBOX BACKEND v6.0.0"
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
      `yt-dlp configured: ${YTDLP_PATH}`
    );

    console.log(
      `FFmpeg configured: ${FFMPEG_PATH}`
    );

    console.log(
      `Temp directory: ${TEMP_DIR}`
    );

    console.log("");

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

    console.log("");

    console.log(
      "Architecture:"
    );

    console.log(
      "Extractor → MP4 normalization → Flutter"
    );

    console.log(
      "================================================"
    );

    console.log("");
  }
);