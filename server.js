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
const REDIRECT_TIMEOUT = 20000;
const DP_TIMEOUT = 30000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const YTDLP_PATH =
  process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";

const FFMPEG_PATH =
  process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";

const DENO_PATH =
  process.env.DENO_PATH || "/root/.deno/bin/deno";

const MEDIA_DIR =
  process.env.MEDIA_DIR ||
  path.join(os.tmpdir(), "streambox-media");

const MEDIA_TTL =
  Number(process.env.MEDIA_TTL_SECONDS || 1800) * 1000;

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

  // YouTube intentionally removed for now.

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
// EXTRACT METADATA
// ============================================================

async function extractMetadata(
  url,
  platform
) {
  const ytDlp = getYtDlpPath();

  const args = [
    ...getCommonYtDlpArgs(),
    "--dump-single-json",
    "--skip-download",
    "--format-sort",
    "res:1080",
    "--referer",
    url,
    url,
  ];

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

  if (
    vcodec &&
    vcodec !== "none"
  ) {
    score += 1000;
  }

  if (
    acodec &&
    acodec !== "none"
  ) {
    score += 500;
  }

  if (ext === "mp4") {
    score += 400;
  }

  if (
    protocol.includes("m3u8") ||
    protocol.includes("dash")
  ) {
    score -= 200;
  }

  score += Math.min(
    height,
    2160
  );

  score += Math.min(
    fps * 2,
    120
  );

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

  return candidates[0];
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

    "--format",
    "bv*+ba/b",

    "--merge-output-format",
    "mp4",

    "--output",
    outputTemplate,

    "--no-part",
    "--no-continue",
    "--newline",

    "--referer",
    url,

    url,
  ];

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

    let metadata = null;

    try {
      metadata =
        await extractMetadata(
          url,
          platform
        );

      fs.writeFileSync(
        path.join(
          jobDir,
          "metadata.json"
        ),
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
// INSTAGRAM DP DOWNLOADER - IMPROVED
// ============================================================

function extractInstagramUsername(inputUrl) {
  try {
    const parsed = new URL(inputUrl);
    const hostname = parsed.hostname.toLowerCase();

    if (
      hostname !== "instagram.com" &&
      hostname !== "www.instagram.com" &&
      hostname !== "instagr.am" &&
      hostname !== "www.instagr.am"
    ) {
      return null;
    }

    const parts = parsed.pathname
      .split("/")
      .filter(Boolean);

    if (parts.length !== 1) {
      return null;
    }

    const username = parts[0].trim();

    const blocked = new Set([
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

    if (blocked.has(username.toLowerCase())) {
      return null;
    }

    if (!/^[A-Za-z0-9._]+$/.test(username)) {
      return null;
    }

    return username;
  } catch {
    return null;
  }
}

// ============================================================
// HTML ENTITY DECODER
// ============================================================

function decodeHtmlEntities(value) {
  if (!value) return value;

  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// ============================================================
// EXTRACT IMAGE URL FROM HTML
// ============================================================

function extractImageFromInstagramHtml(html) {
  if (!html) return null;

  let imageUrl = null;

  // ----------------------------------------------------------
  // 1. profile_pic_url_hd
  // ----------------------------------------------------------

  const hdPatterns = [
    /"profile_pic_url_hd"\s*:\s*"([^"]+)"/i,
    /\\"profile_pic_url_hd\\"\s*:\s*\\"([^"]+)\\"/i,
  ];

  for (const pattern of hdPatterns) {
    const match = html.match(pattern);

    if (match && match[1]) {
      imageUrl = match[1];
      break;
    }
  }

  // ----------------------------------------------------------
  // 2. profile_pic_url
  // ----------------------------------------------------------

  if (!imageUrl) {
    const profilePatterns = [
      /"profile_pic_url"\s*:\s*"([^"]+)"/i,
      /\\"profile_pic_url\\"\s*:\s*\\"([^"]+)\\"/i,
    ];

    for (const pattern of profilePatterns) {
      const match = html.match(pattern);

      if (match && match[1]) {
        imageUrl = match[1];
        break;
      }
    }
  }

  // ----------------------------------------------------------
  // 3. og:image
  // ----------------------------------------------------------

  if (!imageUrl) {
    const ogPatterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    ];

    for (const pattern of ogPatterns) {
      const match = html.match(pattern);

      if (match && match[1]) {
        imageUrl = match[1];
        break;
      }
    }
  }

  // ----------------------------------------------------------
  // 4. twitter:image
  // ----------------------------------------------------------

  if (!imageUrl) {
    const twitterPatterns = [
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    ];

    for (const pattern of twitterPatterns) {
      const match = html.match(pattern);

      if (match && match[1]) {
        imageUrl = match[1];
        break;
      }
    }
  }

  if (!imageUrl) {
    return null;
  }

  imageUrl = decodeHtmlEntities(imageUrl);

  // Instagram sometimes escapes URLs
  imageUrl = imageUrl
    .replace(/\\u0026/g, "&")
    .replace(/\\u003D/g, "=")
    .replace(/\\\//g, "/")
    .replace(/\\u002F/g, "/");

  try {
    imageUrl = decodeURIComponent(imageUrl);
  } catch {}

  return isValidHttpUrl(imageUrl)
    ? imageUrl
    : null;
}

// ============================================================
// FETCH INSTAGRAM PROFILE IMAGE
// ============================================================

async function getInstagramProfilePicture(profileUrl) {
  const username = extractInstagramUsername(profileUrl);

  if (!username) {
    throw new Error(
      "Please provide a valid Instagram profile URL."
    );
  }

  const canonicalUrl =
    `https://www.instagram.com/${encodeURIComponent(username)}/`;

  console.log(
    `[INSTAGRAM DP] Fetching profile: @${username}`
  );

  let imageUrl = null;

  // ==========================================================
  // METHOD 1 - INSTAGRAM WEB PROFILE API
  // ==========================================================

  try {
    console.log(
      `[INSTAGRAM DP] Trying web profile API for @${username}`
    );

    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
    }, DP_TIMEOUT);

    try {
      const apiUrl =
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;

      const response = await fetch(apiUrl, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json",
          "Accept-Language": "en-US,en;q=0.9",
          "X-IG-App-ID": "936619743392459",
          "Referer": canonicalUrl,
        },
        signal: controller.signal,
      });

      if (response.ok) {
        const data = await response.json();

        const user =
          data?.data?.user ||
          data?.user ||
          null;

        if (user) {
          imageUrl =
            user.profile_pic_url_hd ||
            user.profile_pic_url ||
            null;

          if (imageUrl) {
            console.log(
              `[INSTAGRAM DP] API found profile picture for @${username}`
            );
          }
        }
      } else {
        console.log(
          `[INSTAGRAM DP] Profile API returned HTTP ${response.status}`
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.log(
      `[INSTAGRAM DP] Profile API failed: ${error.message}`
    );
  }

  // ==========================================================
  // METHOD 2 - PROFILE HTML
  // ==========================================================

  if (!imageUrl) {
    try {
      console.log(
        `[INSTAGRAM DP] Trying Instagram profile HTML`
      );

      const controller = new AbortController();

      const timer = setTimeout(() => {
        controller.abort();
      }, DP_TIMEOUT);

      try {
        const response = await fetch(canonicalUrl, {
          method: "GET",
          redirect: "follow",
          headers: {
            "User-Agent": USER_AGENT,
            "Accept":
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language":
              "en-US,en;q=0.9",
            "Cache-Control":
              "no-cache",
            "Pragma":
              "no-cache",
            "Upgrade-Insecure-Requests":
              "1",
          },
          signal: controller.signal,
        });

        if (response.ok) {
          const html = await response.text();

          imageUrl =
            extractImageFromInstagramHtml(html);

          if (imageUrl) {
            console.log(
              `[INSTAGRAM DP] HTML found profile picture for @${username}`
            );
          } else {
            console.log(
              `[INSTAGRAM DP] No profile image found in HTML`
            );
          }
        } else {
          console.log(
            `[INSTAGRAM DP] Instagram HTML returned HTTP ${response.status}`
          );
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      console.log(
        `[INSTAGRAM DP] HTML request failed: ${error.message}`
      );
    }
  }

  // ==========================================================
  // FINAL CHECK
  // ==========================================================

  if (!imageUrl) {
    throw new Error(
      "Instagram did not return a usable profile picture. The profile may be unavailable or Instagram may be restricting automated requests."
    );
  }

  if (!isValidHttpUrl(imageUrl)) {
    throw new Error(
      "Instagram returned an invalid profile picture URL."
    );
  }

  return {
    username,
    profileUrl: canonicalUrl,
    imageUrl,
  };
}

// ============================================================
// DOWNLOAD IMAGE TO SERVER
// ============================================================

async function downloadInstagramImage(
  imageUrl,
  username
) {
  console.log(
    `[INSTAGRAM DP] Downloading image for @${username}`
  );

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, DP_TIMEOUT);

  try {
    const response = await fetch(imageUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer:
          "https://www.instagram.com/",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Instagram image returned HTTP ${response.status}`
      );
    }

    const contentType =
      response.headers.get("content-type") || "";

    if (!contentType.startsWith("image/")) {
      throw new Error(
        `Instagram returned non-image content: ${contentType}`
      );
    }

    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    if (!buffer.length) {
      throw new Error(
        "Instagram returned an empty profile image."
      );
    }

    const token = createMediaToken();

    const jobDir = path.join(
      MEDIA_DIR,
      token
    );

    fs.mkdirSync(jobDir, {
      recursive: true,
    });

    let extension = ".jpg";

    if (contentType.includes("png")) {
      extension = ".png";
    } else if (contentType.includes("webp")) {
      extension = ".webp";
    } else if (contentType.includes("gif")) {
      extension = ".gif";
    } else if (contentType.includes("jpeg")) {
      extension = ".jpg";
    }

    const filePath = path.join(
      jobDir,
      `profile${extension}`
    );

    fs.writeFileSync(
      filePath,
      buffer
    );

    // Store information about the DP
    fs.writeFileSync(
      path.join(jobDir, "metadata.json"),
      JSON.stringify(
        {
          type: "instagram-profile-picture",
          username,
          contentType,
          extension,
          fileSize: buffer.length,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    console.log(
      `[INSTAGRAM DP] Saved ${buffer.length} bytes`
    );

    return {
      token,
      filePath,
      fileSize: buffer.length,
      extension,
      contentType,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------
// HTML ENTITY DECODING
// ------------------------------------------------------------

function decodeHtmlEntities(value) {
  if (!value) {
    return value;
  }

  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// ------------------------------------------------------------
// INSTAGRAM DP FETCH
// ------------------------------------------------------------

async function getInstagramProfilePicture(
  profileUrl
) {
  const username =
    extractInstagramUsername(
      profileUrl
    );

  if (!username) {
    throw new Error(
      "Please provide a valid Instagram profile URL."
    );
  }

  const url =
    `https://www.instagram.com/${encodeURIComponent(
      username
    )}/`;

  const controller =
    new AbortController();

  const timer =
    setTimeout(() => {
      controller.abort();
    }, DP_TIMEOUT);

  try {
    console.log(
      `[INSTAGRAM DP] Fetching profile: @${username}`
    );

    const response =
      await fetch(url, {
        method: "GET",
        redirect: "follow",

        headers: {
          "User-Agent":
            USER_AGENT,

          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

          "Accept-Language":
            "en-US,en;q=0.9",

          "Cache-Control":
            "no-cache",
        },

        signal:
          controller.signal,
      });

    if (!response.ok) {
      throw new Error(
        `Instagram returned HTTP ${response.status}`
      );
    }

    const html =
      await response.text();

    if (!html) {
      throw new Error(
        "Instagram returned an empty response."
      );
    }

    let imageUrl = null;

    // --------------------------------------------------------
    // og:image
    // --------------------------------------------------------

    const ogImagePatterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    ];

    for (
      const pattern of ogImagePatterns
    ) {
      const match =
        html.match(pattern);

      if (
        match &&
        match[1]
      ) {
        imageUrl =
          decodeHtmlEntities(
            match[1]
          );

        break;
      }
    }

    // --------------------------------------------------------
    // twitter:image fallback
    // --------------------------------------------------------

    if (!imageUrl) {
      const twitterPatterns = [
        /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
      ];

      for (
        const pattern of twitterPatterns
      ) {
        const match =
          html.match(pattern);

        if (
          match &&
          match[1]
        ) {
          imageUrl =
            decodeHtmlEntities(
              match[1]
            );

          break;
        }
      }
    }

    if (!imageUrl) {
      throw new Error(
        "Instagram profile picture could not be found. The profile may be private, unavailable, or Instagram may have restricted the request."
      );
    }

    if (
      !isValidHttpUrl(
        imageUrl
      )
    ) {
      throw new Error(
        "Instagram returned an invalid profile picture URL."
      );
    }

    console.log(
      `[INSTAGRAM DP] Found profile picture for @${username}`
    );

    return {
      username,
      profileUrl: url,
      imageUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// CLEANUP
// ============================================================

function cleanupExpiredMedia() {
  if (
    !fs.existsSync(
      MEDIA_DIR
    )
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

  for (
    const entry of entries
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
        "9.0.0",

      architecture:
        "yt-dlp + FFmpeg + temporary MP4",

      platforms: [
        "instagram",
        "instagram-dp",
        "tiktok",
        "facebook",
        "pinterest",
        "twitter",
      ],

      youtube:
        "temporarily disabled",

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

      status:
        "online",

      service:
        "StreamBox Backend",

      version:
        "9.0.0",

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

      result.ytDlp.error =
        error.message;
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

      result.ffmpeg.error =
        error.message;
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

      result.deno.error =
        error.message;
    }

    res.json(result);
  }
);

// ============================================================
// INSTAGRAM DP API
// ============================================================

app.post(
  "/api/instagram/dp",
  async (req, res) => {
    const started = Date.now();

    try {
      const inputUrl = cleanInputUrl(
        req.body?.url
      );

      if (!inputUrl) {
        return res.status(400).json({
          success: false,
          error:
            "Please provide an Instagram profile URL.",
        });
      }

      if (!isValidHttpUrl(inputUrl)) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid Instagram profile URL.",
        });
      }

      const username =
        extractInstagramUsername(inputUrl);

      if (!username) {
        return res.status(400).json({
          success: false,
          error:
            "Please enter an Instagram profile URL, for example https://www.instagram.com/username/",
        });
      }

      const profile =
        await getInstagramProfilePicture(
          inputUrl
        );

      // IMPORTANT:
      // Download the Instagram image onto OUR server.
      const image =
        await downloadInstagramImage(
          profile.imageUrl,
          profile.username
        );

      const processingTimeMs =
        Date.now() - started;

      const baseUrl =
        `${req.protocol}://${req.get("host")}`;

      const mediaUrl =
        `${baseUrl}/api/instagram/dp/media/${image.token}`;

      console.log(
        `[INSTAGRAM DP] SUCCESS @${profile.username}`
      );

      console.log(
        `[INSTAGRAM DP] ${mediaUrl}`
      );

      return res.status(200).json({
        success: true,
        platform: "instagram",
        type: "profile_picture",

        username:
          profile.username,

        profileUrl:
          profile.profileUrl,

        // Original Instagram URL.
        // Flutter should NOT download this.
        imageUrl:
          profile.imageUrl,

        // StreamBox server URL.
        mediaUrl,

        downloadUrl:
          mediaUrl,

        mimeType:
          image.contentType,

        extension:
          image.extension,

        fileSize:
          image.fileSize,

        processingTimeMs,
      });
    } catch (error) {
      const processingTimeMs =
        Date.now() - started;

      console.error(
        "[INSTAGRAM DP ERROR]",
        error.message
      );

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Unable to retrieve Instagram profile picture.",
        processingTimeMs,
      });
    }
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
          "https://www.instagram.com/reel/example/",
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

      // Instagram DP requests should use the DP endpoint.
      if (
        platform === "instagram"
      ) {
        const username =
          extractInstagramUsername(
            inputUrl
          );

        if (username) {
          return res.status(400).json({
            success: false,
            error:
              "This is an Instagram profile URL. Use POST /api/instagram/dp for profile pictures.",
            endpoint:
              "/api/instagram/dp",
          });
        }
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

      const preparedUrl =
        await prepareUrl(
          platform,
          inputUrl
        );

      console.log(
        `[PREPARED] ${preparedUrl}`
      );

      const job =
        await createMediaJob(
          preparedUrl,
          platform
        );

      const processingTimeMs =
        Date.now() -
        started;

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
          return res
            .status(416)
            .end();
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

      fs.createReadStream(
        filePath
      ).pipe(res);
    } catch (error) {
      console.error(
        "[MEDIA ERROR]",
        error
      );

      if (
        !res.headersSent
      ) {
        res.status(500).json({
          success: false,
          error:
            "Unable to serve media.",
        });
      }
    }
  }
);

// ============================================================
// INSTAGRAM DP MEDIA STREAM
// ============================================================

app.get(
  "/api/instagram/dp/media/:token",
  (req, res) => {
    try {
      const token =
        req.params.token;

      if (
        !/^[a-f0-9]{48}$/i.test(token)
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

      if (
        !fs.existsSync(jobDir)
      ) {
        return res.status(404).json({
          success: false,
          error:
            "Profile picture expired or no longer available.",
        });
      }

      const files =
        fs.readdirSync(jobDir);

      const imageFile =
        files.find((file) =>
          /\.(jpg|jpeg|png|webp|gif)$/i.test(
            file
          )
        );

      if (!imageFile) {
        return res.status(404).json({
          success: false,
          error:
            "Profile picture file not found.",
        });
      }

      const filePath =
        path.join(
          jobDir,
          imageFile
        );

      if (
        !fs.existsSync(filePath)
      ) {
        return res.status(404).json({
          success: false,
          error:
            "Profile picture expired.",
        });
      }

      const stat =
        fs.statSync(filePath);

      const extension =
        path.extname(
          imageFile
        ).toLowerCase();

      const mimeTypes = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
      };

      const contentType =
        mimeTypes[extension] ||
        "application/octet-stream";

      res.setHeader(
        "Content-Type",
        contentType
      );

      res.setHeader(
        "Content-Length",
        stat.size
      );

      res.setHeader(
        "Cache-Control",
        "private, max-age=300"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="StreamBox_${token}${extension}"`
      );

      fs.createReadStream(
        filePath
      ).pipe(res);
    } catch (error) {
      console.error(
        "[INSTAGRAM DP MEDIA ERROR]",
        error
      );

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error:
            "Unable to serve profile picture.",
        });
      }
    }
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
      "             STREAMBOX BACKEND v9.0.0"
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
      "✓ Instagram DP"
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
      "✗ YouTube temporarily disabled"
    );

    console.log("");

    console.log(
      "Architecture:"
    );

    console.log(
      "URL → yt-dlp → FFmpeg → temporary MP4 → Flutter"
    );

    console.log(
      "Instagram DP → Instagram profile → profile image URL → Flutter"
    );

    console.log(
      "============================================================"
    );

    console.log("");
  }
);