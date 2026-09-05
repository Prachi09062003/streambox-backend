const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const {
  igdl,
  ttdl,
  fbdown,
  pinterest,
  twitter,
} = require("btch-downloader");

const app = express();

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 3000;

const EXTRACTION_TIMEOUT = 180000;
const DOWNLOAD_TIMEOUT = 600000;
const REDIRECT_TIMEOUT = 20000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const YTDLP_PATH =
  process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";

const FFMPEG_PATH =
  process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";

const DENO_PATH =
  process.env.DENO_PATH ||
  "/root/.deno/bin/deno";

const MEDIA_DIR =
  process.env.MEDIA_DIR ||
  path.join(os.tmpdir(), "streambox-media");

const MEDIA_TTL =
  Number(process.env.MEDIA_TTL_SECONDS || 1800) * 1000;

// Create media directory
fs.mkdirSync(MEDIA_DIR, {
  recursive: true,
});

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

// ============================================================
// PLATFORM DETECTION
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

  if (
    value.includes("youtube.com") ||
    value.includes("youtu.be")
  ) {
    return "youtube";
  }

  return null;
}

// ============================================================
// REDIRECT RESOLUTION
// ============================================================

async function resolveRedirectUrl(inputUrl) {
  let currentUrl = inputUrl;

  for (let i = 0; i < 8; i++) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, REDIRECT_TIMEOUT);

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

        currentUrl = new URL(
          location,
          currentUrl
        ).href;

        console.log(
          `[REDIRECT] ${i + 1}: ${currentUrl}`
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
        `[REDIRECT] Failed: ${error.message}`
      );

      break;
    }
  }

  return normalizeUrl(currentUrl);
}

// ============================================================
// URL PREPARATION
// ============================================================

async function prepareUrl(platform, inputUrl) {
  let url = normalizeUrl(inputUrl);

  // ----------------------------------------------------------
  // PINTEREST
  // ----------------------------------------------------------

  if (platform === "pinterest") {
    console.log(
      "[PREPARE] Resolving Pinterest URL"
    );

    const resolved =
      await resolveRedirectUrl(url);

    if (resolved) {
      url = resolved;
    }

    console.log(
      `[PREPARED] Pinterest: ${url}`
    );

    return url;
  }

  // ----------------------------------------------------------
  // TIKTOK
  // ----------------------------------------------------------

  if (platform === "tiktok") {
    if (
      url.includes("vm.tiktok.com") ||
      url.includes("vt.tiktok.com")
    ) {
      console.log(
        "[PREPARE] Resolving TikTok short URL"
      );

      const resolved =
        await resolveRedirectUrl(url);

      if (resolved) {
        url = resolved;
      }
    }

    return url;
  }

  // ----------------------------------------------------------
  // FACEBOOK
  // ----------------------------------------------------------

  if (platform === "facebook") {
    if (
      url.includes("fb.watch") ||
      url.includes("/share/")
    ) {
      console.log(
        "[PREPARE] Resolving Facebook URL"
      );

      const resolved =
        await resolveRedirectUrl(url);

      if (resolved) {
        url = resolved;
      }
    }

    return url;
  }

  // ----------------------------------------------------------
  // YOUTUBE
  // ----------------------------------------------------------

  if (platform === "youtube") {
    try {
      const parsed = new URL(url);

      let videoId = null;

      // youtu.be/VIDEO_ID
      if (
        parsed.hostname === "youtu.be" ||
        parsed.hostname === "www.youtu.be"
      ) {
        videoId =
          parsed.pathname
            .split("/")
            .filter(Boolean)[0];
      }

      // youtube.com/shorts/VIDEO_ID
      if (
        parsed.pathname.startsWith("/shorts/")
      ) {
        videoId =
          parsed.pathname
            .split("/")
            .filter(Boolean)[1];
      }

      // youtube.com/embed/VIDEO_ID
      if (
        parsed.pathname.startsWith("/embed/")
      ) {
        videoId =
          parsed.pathname
            .split("/")
            .filter(Boolean)[1];
      }

      // youtube.com/live/VIDEO_ID
      if (
        parsed.pathname.startsWith("/live/")
      ) {
        videoId =
          parsed.pathname
            .split("/")
            .filter(Boolean)[1];
      }

      // youtube.com/watch?v=VIDEO_ID
      if (
        parsed.pathname === "/watch"
      ) {
        videoId =
          parsed.searchParams.get("v");
      }

      if (videoId) {
        url =
          `https://www.youtube.com/watch?v=${videoId}`;

        console.log(
          `[PREPARED] YouTube normalized: ${url}`
        );
      }
    } catch {}

    return url;
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

    console.log("");
    console.log(
      `[COMMAND] ${command} ${args.join(" ")}`
    );

    const child = spawn(
      command,
      args,
      {
        env,
        cwd: options.cwd || process.cwd(),
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

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "yt-dlp";
}

// ============================================================
// YT-DLP BASE ARGS
// ============================================================

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
// YOUTUBE EXTRA ARGS
// ============================================================

function getYouTubeArgs() {
  return [
    "--js-runtimes",
    `deno:${DENO_PATH}`,

    "--remote-components",
    "ejs:github",

    // Let yt-dlp choose its supported default client.
    "--extractor-args",
    "youtube:player_client=default,mweb",
  ];
}

// ============================================================
// EXTRACT METADATA ONLY
// ============================================================

async function extractMetadata(
  url,
  platform
) {
  const ytDlp =
    getYtDlpPath();

  const args = [
    ...getCommonYtDlpArgs(),

    "--dump-single-json",

    "--skip-download",

    "--format-sort",
    "res:1080",

    "--referer",
    url,
  ];

 // ----------------------------------------------------------
// YOUTUBE
// ----------------------------------------------------------
if (platform === "youtube") {
  try {
    const parsed = new URL(url);
    let videoId = null;

    // youtu.be/VIDEO_ID
    if (
      parsed.hostname === "youtu.be" ||
      parsed.hostname === "www.youtu.be"
    ) {
      videoId = parsed.pathname
        .split("/")
        .filter(Boolean)[0];
    }

    // youtube.com/shorts/VIDEO_ID
    if (parsed.pathname.startsWith("/shorts/")) {
      videoId = parsed.pathname
        .split("/")
        .filter(Boolean)[1];
    }

    // youtube.com/embed/VIDEO_ID
    if (parsed.pathname.startsWith("/embed/")) {
      videoId = parsed.pathname
        .split("/")
        .filter(Boolean)[1];
    }

    // youtube.com/live/VIDEO_ID
    if (parsed.pathname.startsWith("/live/")) {
      videoId = parsed.pathname
        .split("/")
        .filter(Boolean)[1];
    }

    // youtube.com/watch?v=VIDEO_ID
    if (parsed.pathname === "/watch") {
      videoId = parsed.searchParams.get("v");
    }

    if (videoId) {
      url = `https://www.youtube.com/watch?v=${videoId}`;

      console.log(
        `[PREPARED] YouTube normalized: ${url}`
      );
    }
  } catch (error) {
    console.log(
      `[PREPARE] YouTube URL normalization failed: ${error.message}`
    );
  }

  return url;
}

  // IMPORTANT:
  // Do NOT force --format best here.
  //
  // This fixes the Pinterest error where
  // "best" was not available.

  args.push(url);

  try {
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
        "yt-dlp returned empty metadata"
      );
    }

    const lines =
      stdout
        .split(/\r?\n/)
        .filter(Boolean);

    let json = null;

    // Last JSON object is normally the metadata.
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
          json = parsed;
          break;
        }
      } catch {}
    }

    if (!json) {
      throw new Error(
        "Could not parse yt-dlp metadata"
      );
    }

    return json;
  } catch (error) {
    console.log(
      `[YTDLP] ${platform} metadata failed: ${error.message}`
    );

    throw error;
  }
}

// ============================================================
// FORMAT INFORMATION
// ============================================================

function isHttpUrl(value) {
  return (
    typeof value === "string" &&
    /^https?:\/\//i.test(value)
  );
}

function getFormats(metadata) {
  if (
    !metadata ||
    !Array.isArray(metadata.formats)
  ) {
    return [];
  }

  return metadata.formats.filter(
    (format) =>
      format &&
      isHttpUrl(format.url)
  );
}

// ============================================================
// FORMAT SCORING
// ============================================================

function scoreFormat(format) {
  let score = 0;

  const ext =
    String(format.ext || "")
      .toLowerCase();

  const protocol =
    String(format.protocol || "")
      .toLowerCase();

  const vcodec =
    String(format.vcodec || "")
      .toLowerCase();

  const acodec =
    String(format.acodec || "")
      .toLowerCase();

  const height =
    Number(format.height || 0);

  const fps =
    Number(format.fps || 0);

  // Prefer real video.
  if (
    vcodec &&
    vcodec !== "none"
  ) {
    score += 1000;
  }

  // Prefer audio.
  if (
    acodec &&
    acodec !== "none"
  ) {
    score += 500;
  }

  // MP4 is friendlier for Android.
  if (ext === "mp4") {
    score += 400;
  }

  // HLS/DASH are less desirable as direct URLs.
  if (
    protocol.includes("m3u8") ||
    protocol.includes("dash")
  ) {
    score -= 200;
  }

  // Resolution.
  score += Math.min(
    height,
    2160
  );

  // FPS.
  score += Math.min(
    fps * 2,
    120
  );

  // Avoid extremely high formats.
  if (height > 1080) {
    score -=
      (height - 1080) * 0.5;
  }

  return score;
}

// ============================================================
// SELECT FORMAT
// ============================================================

function selectBestFormat(
  metadata
) {
  const formats =
    getFormats(metadata);

  if (formats.length === 0) {
    return null;
  }

  const videoFormats =
    formats.filter(
      (format) => {
        const vcodec =
          String(
            format.vcodec || ""
          ).toLowerCase();

        return (
          vcodec &&
          vcodec !== "none"
        );
      }
    );

  const candidates =
    videoFormats.length > 0
      ? videoFormats
      : formats;

  candidates.sort(
    (a, b) =>
      scoreFormat(b) -
      scoreFormat(a)
  );

  const selected =
    candidates[0];

  return selected;
}

// ============================================================
// DIRECT MEDIA RESULT
// ============================================================

function makeExtractionResult(
  metadata
) {
  const format =
    selectBestFormat(metadata);

  if (!format) {
    return null;
  }

  const vcodec =
    String(
      format.vcodec || ""
    ).toLowerCase();

  const acodec =
    String(
      format.acodec || ""
    ).toLowerCase();

  return {
    mediaUrl: format.url,

    extension:
      format.ext || "mp4",

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
      format.width ||
      null,

    height:
      format.height ||
      null,

    hasAudio:
      acodec &&
      acodec !== "none",

    videoCodec:
      vcodec,

    audioCodec:
      acodec,

    formatId:
      format.format_id ||
      null,

    protocol:
      format.protocol ||
      null,

    formatNote:
      format.format_note ||
      null,
  };
}

// ============================================================
// SERVER-SIDE DOWNLOAD
// ============================================================

async function downloadWithYtDlp(
  url,
  platform,
  outputDir
) {
  const ytDlp =
    getYtDlpPath();

  fs.mkdirSync(
    outputDir,
    {
      recursive: true,
    }
  );

  const outputTemplate =
    path.join(
      outputDir,
      "streambox.%(ext)s"
    );

  const args = [
    ...getCommonYtDlpArgs(),

    // Best video + best audio,
    // fallback to best combined.
    "--format",
    "bv*+ba/b",

    // Merge into MP4 when possible.
    "--merge-output-format",
    "mp4",

    "--output",
    outputTemplate,

    "--no-part",

    "--no-continue",

    "--newline",

    "--referer",
    url,
  ];

  if (platform === "youtube") {
    args.push(
      ...getYouTubeArgs()
    );
  }

  args.push(url);

  try {
    const result =
      await runCommand(
        ytDlp,
        args,
        {
          timeout:
            DOWNLOAD_TIMEOUT,
          cwd:
            outputDir,
        }
      );

    console.log(
      `[DOWNLOAD] ${platform} completed`
    );

    return result;
  } catch (error) {
    console.log(
      `[DOWNLOAD] ${platform} failed`
    );

    console.log(
      error.message
    );

    throw error;
  }
}

// ============================================================
// FIND DOWNLOADED FILE
// ============================================================

function findDownloadedFile(
  directory
) {
  if (
    !fs.existsSync(directory)
  ) {
    return null;
  }

  const files =
    fs.readdirSync(
      directory
    );

  const mediaExtensions = [
    ".mp4",
    ".mkv",
    ".webm",
    ".mov",
    ".m4v",
  ];

  const candidates =
    files
      .filter((file) =>
        mediaExtensions.some(
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
    (a, b) => {
      const aSize =
        fs.statSync(
          a.fullPath
        ).size;

      const bSize =
        fs.statSync(
          b.fullPath
        ).size;

      return bSize - aSize;
    }
  );

  return candidates[0].fullPath;
}

// ============================================================
// FFMPEG NORMALIZATION
// ============================================================

async function normalizeToMp4(
  inputFile,
  outputFile
) {
  console.log(
    `[FFMPEG] Normalizing: ${inputFile}`
  );

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
    !fs.existsSync(outputFile)
  ) {
    throw new Error(
      "FFmpeg did not create the MP4 file"
    );
  }

  const size =
    fs.statSync(
      outputFile
    ).size;

  if (size <= 0) {
    throw new Error(
      "FFmpeg created an empty MP4"
    );
  }

  console.log(
    `[FFMPEG] MP4 ready: ${size} bytes`
  );

  return outputFile;
}

// ============================================================
// MEDIA TOKEN
// ============================================================

function createMediaToken() {
  return crypto
    .randomBytes(24)
    .toString("hex");
}

// ============================================================
// MEDIA JOB
// ============================================================

async function createMediaJob(
  url,
  platform
) {
  const token =
    createMediaToken();

  const jobDir =
    path.join(
      MEDIA_DIR,
      token
    );

  fs.mkdirSync(
    jobDir,
    {
      recursive: true,
    }
  );

  try {
    console.log("");
    console.log(
      `[JOB] ${token}`
    );

    // --------------------------------------------------------
    // Download
    // --------------------------------------------------------

    await downloadWithYtDlp(
      url,
      platform,
      jobDir
    );

    const downloadedFile =
      findDownloadedFile(
        jobDir
      );

    if (!downloadedFile) {
      throw new Error(
        "yt-dlp completed but no media file was created"
      );
    }

    // --------------------------------------------------------
    // Convert to MP4
    // --------------------------------------------------------

    const finalFile =
      path.join(
        jobDir,
        "streambox.mp4"
      );

    if (
      downloadedFile
        .toLowerCase()
        .endsWith(".mp4")
    ) {
      if (
        downloadedFile !== finalFile
      ) {
        fs.renameSync(
          downloadedFile,
          finalFile
        );
      }
    } else {
      await normalizeToMp4(
        downloadedFile,
        finalFile
      );
    }

    // --------------------------------------------------------
    // Validate
    // --------------------------------------------------------

    if (
      !fs.existsSync(finalFile)
    ) {
      throw new Error(
        "Final media file does not exist"
      );
    }

    const stat =
      fs.statSync(
        finalFile
      );

    if (stat.size <= 0) {
      throw new Error(
        "Final media file is empty"
      );
    }

    const titleFile =
      path.join(
        jobDir,
        "metadata.json"
      );

    // --------------------------------------------------------
    // Metadata
    // --------------------------------------------------------

    let metadata = null;

    try {
      metadata =
        await extractMetadata(
          url,
          platform
        );

      fs.writeFileSync(
        titleFile,
        JSON.stringify(
          metadata,
          null,
          2
        )
      );
    } catch (error) {
      console.log(
        `[METADATA] Optional metadata extraction failed: ${error.message}`
      );
    }

    console.log(
      `[JOB] Completed ${token}`
    );

    return {
      token,

      filePath:
        finalFile,

      fileSize:
        stat.size,

      title:
        metadata?.title ||
        "StreamBox Video",

      thumbnail:
        metadata?.thumbnail ||
        null,

      duration:
        metadata?.duration ||
        null,

      width:
        metadata?.width ||
        null,

      height:
        metadata?.height ||
        null,
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
// CLEANUP
// ============================================================

function cleanupExpiredMedia() {
  if (
    !fs.existsSync(MEDIA_DIR)
  ) {
    return;
  }

  const now =
    Date.now();

  const entries =
    fs.readdirSync(
      MEDIA_DIR,
      {
        withFileTypes: true,
      }
    );

  for (const entry of entries) {
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
        now - stat.mtimeMs >
        MEDIA_TTL
      ) {
        fs.rmSync(
          directory,
          {
            recursive: true,
            force: true,
          }
        );

        console.log(
          `[CLEANUP] Removed ${entry.name}`
        );
      }
    } catch {}
  }
}

setInterval(
  cleanupExpiredMedia,
  5 * 60 * 1000
);

// ============================================================
// ROOT
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,

      service:
        "StreamBox Backend",

      status:
        "online",

      version:
        "8.0.0",

      architecture:
        "yt-dlp + FFmpeg + temporary MP4",

      platforms: [
        "instagram",
        "tiktok",
        "facebook",
        "pinterest",
        "twitter",
        "youtube",
      ],

      timestamp:
        new Date().toISOString(),
    });
  }
);

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
      version:
        "8.0.0",
      timestamp:
        new Date().toISOString(),
    });
  }
);

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

      mediaDirectory:
        MEDIA_DIR,

      timestamp:
        new Date().toISOString(),
    };

    // yt-dlp version
    try {
      const ytDlp =
        getYtDlpPath();

      const version =
        await runCommand(
          ytDlp,
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

      result.ytDlp.error =
        error.message;
    }

    // ffmpeg version
    try {
      const ffmpeg =
        await runCommand(
          FFMPEG_PATH,
          ["-version"],
          {
            timeout: 15000,
          }
        );

      const firstLine =
        ffmpeg.stdout
          .split(/\r?\n/)[0];

      result.ffmpeg.version =
        firstLine;
    } catch (error) {
      result.ffmpeg.version =
        null;

      result.ffmpeg.error =
        error.message;
    }

    // Deno version
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

      result.deno.error =
        error.message;
    }

    res.json(result);
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
        "Use POST /api/extract",

      body: {
        url:
          "https://www.youtube.com/watch?v=example",
      },
    });
  }
);

// ============================================================
// MAIN EXTRACT
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

      const platform =
        getPlatform(
          inputUrl
        );

      if (!platform) {
        return res.status(400).json({
          success: false,
          error:
            "Unsupported platform.",
        });
      }

      console.log("");
      console.log(
        "============================================================"
      );

      console.log(
        `[REQUEST] ${inputUrl}`
      );

      console.log(
        `[PLATFORM] ${platform}`
      );

      // ------------------------------------------------------
      // Prepare URL
      // ------------------------------------------------------

      const preparedUrl =
        await prepareUrl(
          platform,
          inputUrl
        );

      console.log(
        `[PREPARED] ${preparedUrl}`
      );

      // ------------------------------------------------------
      // Server-side download
      // ------------------------------------------------------

      const job =
        await createMediaJob(
          preparedUrl,
          platform
        );

      const processingTimeMs =
        Date.now() -
        started;

      // ------------------------------------------------------
      // Temporary media URL
      // ------------------------------------------------------

      const baseUrl =
        `${req.protocol}://${req.get("host")}`;

      const mediaUrl =
        `${baseUrl}/api/media/${job.token}`;

      console.log(
        `[SUCCESS] ${platform} completed in ${processingTimeMs}ms`
      );

      console.log(
        `[MEDIA] ${mediaUrl}`
      );

      console.log(
        "============================================================"
      );

      return res.status(200).json({
        success: true,

        platform,

        mediaUrl,

        downloadUrl:
          mediaUrl,

        sourceUrl:
          inputUrl,

        preparedUrl,

        extension:
          "mp4",

        mimeType:
          "video/mp4",

        resolution:
          job.height
            ? `${job.height}p`
            : null,

        width:
          job.width,

        height:
          job.height,

        title:
          job.title,

        thumbnail:
          job.thumbnail,

        duration:
          job.duration,

        fileSize:
          job.fileSize,

        processingTimeMs,
      });
    } catch (error) {
      const processingTimeMs =
        Date.now() -
        started;

      console.error("");
      console.error(
        "[EXTRACTION ERROR]"
      );

      console.error(
        error?.message ||
          error
      );

      console.error(
        "============================================================"
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Unable to download media.",

        processingTimeMs,
      });
    }
  }
);

// ============================================================
// MEDIA STREAM
// ============================================================

app.get(
  "/api/media/:token",
  (req, res) => {
    try {
      const token =
        req.params.token;

      if (
        !/^[a-f0-9]{48}$/i.test(
          token
        )
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid media token.",
        });
      }

      const jobDir =
        path.join(
          MEDIA_DIR,
          token
        );

      const filePath =
        path.join(
          jobDir,
          "streambox.mp4"
        );

      if (
        !fs.existsSync(
          filePath
        )
      ) {
        return res.status(404).json({
          success: false,
          error:
            "Media expired or no longer available.",
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
        "Accept-Ranges",
        "bytes"
      );

      res.setHeader(
        "Cache-Control",
        "private, max-age=300"
      );

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="StreamBox.mp4"'
      );

      const range =
        req.headers.range;

      // ------------------------------------------------------
      // Range request
      // ------------------------------------------------------

      if (range) {
        const parts =
          range
            .replace(
              /bytes=/,
              ""
            )
            .split("-");

        const start =
          parseInt(
            parts[0],
            10
          );

        const end =
          parts[1]
            ? parseInt(
                parts[1],
                10
              )
            : stat.size - 1;

        if (
          Number.isNaN(start) ||
          start >= stat.size
        ) {
          return res.status(416).end();
        }

        const safeEnd =
          Math.min(
            end,
            stat.size - 1
          );

        const chunkSize =
          safeEnd -
          start +
          1;

        res.status(206);

        res.setHeader(
          "Content-Range",
          `bytes ${start}-${safeEnd}/${stat.size}`
        );

        res.setHeader(
          "Content-Length",
          chunkSize
        );

        const stream =
          fs.createReadStream(
            filePath,
            {
              start,
              end: safeEnd,
            }
          );

        stream.pipe(res);

        return;
      }

      // ------------------------------------------------------
      // Normal request
      // ------------------------------------------------------

      fs.createReadStream(
        filePath
      ).pipe(res);
    } catch (error) {
      console.error(
        "[MEDIA ERROR]",
        error
      );

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error:
            "Unable to serve media.",
        });
      }
    }
  }
);

app.get("/api/youtube-test", async (req, res) => {
  const testUrl =
    "https://www.youtube.com/watch?v=HPKQ2MyqDDg";

  try {
    const ytDlp = getYtDlpPath();

    const args = [
      ...getCommonYtDlpArgs(),

      "--verbose",
      "--dump-single-json",
      "--skip-download",

      "--referer",
      testUrl,

      ...getYouTubeArgs(),

      testUrl,
    ];

    const result = await runCommand(
      ytDlp,
      args,
      {
        timeout: EXTRACTION_TIMEOUT,
      }
    );

    res.json({
      success: true,
      message: "YouTube extraction test succeeded",
      ytDlp,
      deno: DENO_PATH,
      output: result.stdout,
      errors: result.stderr,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "YouTube extraction test failed",
      error: error.message,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
    });
  }
});

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      error:
        "Endpoint not found",
      path:
        req.path,
      method:
        req.method,
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
      "             STREAMBOX BACKEND v8.1.0"
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

    console.log(
      `Media directory: ${MEDIA_DIR}`
    );

    console.log("");
    console.log(
      "Supported:"
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
      "✓ Pinterest / pin.it"
    );

    console.log(
      "✓ Twitter / X"
    );

    console.log(
      "✓ YouTube Shorts"
    );

    console.log(
      "✓ YouTube Watch"
    );

    console.log(
      "✓ YouTube youtu.be"
    );

    console.log(
      "✓ YouTube Live"
    );

    console.log("");
    console.log(
      "Architecture:"
    );

    console.log(
      "URL → yt-dlp → FFmpeg → temporary MP4 → Flutter"
    );

    console.log(
      "============================================================"
    );

    console.log("");
  }
);