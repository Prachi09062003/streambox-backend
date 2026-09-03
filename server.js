const express = require('express');
const cors = require('cors');

const {
  igdl,
  ttdl,
  fbdown,
  pinterest,
  twitter,
  youtube
} = require('btch-downloader');

const app = express();

// ======================================================
// CONFIG
// ======================================================

const PORT = process.env.PORT || 3000;

const EXTRACTION_TIMEOUT = 90 * 1000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(cors());

app.use(
  express.json({
    limit: '1mb'
  })
);

// ======================================================
// BASIC ROUTES
// ======================================================

app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'StreamBox Backend',
    status: 'online',
    version: '3.0.0',
    node: process.version,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'online',
    service: 'StreamBox Backend',
    version: '3.0.0',
    timestamp: new Date().toISOString()
  });
});

// ======================================================
// EXTRACT API GET TEST
// ======================================================

app.get('/api/extract', (req, res) => {
  res.json({
    success: true,
    message: 'Extract API is working.',
    method: 'POST',
    endpoint: '/api/extract',
    usage: {
      body: {
        url: 'https://www.instagram.com/reel/example/'
      }
    }
  });
});

// ======================================================
// PLATFORM DETECTION
// ======================================================

function getPlatform(url) {
  const value = url.toLowerCase();

  // Instagram
  if (
    value.includes('instagram.com') ||
    value.includes('instagr.am')
  ) {
    return 'instagram';
  }

  // TikTok
  if (
    value.includes('tiktok.com') ||
    value.includes('vm.tiktok.com') ||
    value.includes('vt.tiktok.com')
  ) {
    return 'tiktok';
  }

  // Facebook
  if (
    value.includes('facebook.com') ||
    value.includes('fb.watch')
  ) {
    return 'facebook';
  }

  // Pinterest
  if (
    value.includes('pinterest.com') ||
    value.includes('pin.it')
  ) {
    return 'pinterest';
  }

  // Twitter / X
  if (
    value.includes('twitter.com') ||
    value.includes('x.com')
  ) {
    return 'twitter';
  }

  // YouTube
  if (
    value.includes('youtube.com') ||
    value.includes('youtu.be')
  ) {
    return 'youtube';
  }

  return null;
}

// ======================================================
// URL VALIDATION
// ======================================================

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);

    return (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:'
    );
  } catch {
    return false;
  }
}

// ======================================================
// SAFE URL STRING
// ======================================================

function cleanInputUrl(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .trim()
    .replace(/^<|>$/g, '');
}

// ======================================================
// URL NORMALIZATION
// ======================================================

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);

    // -----------------------------------------------
    // Remove unnecessary tracking parameters
    // -----------------------------------------------

    const removeParams = [
      'si',
      'igsh',
      'igshid',
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_content',
      'utm_term'
    ];

    for (const param of removeParams) {
      parsed.searchParams.delete(param);
    }

    // -----------------------------------------------
    // X -> Twitter
    // -----------------------------------------------

    if (
      parsed.hostname === 'x.com' ||
      parsed.hostname === 'www.x.com'
    ) {
      parsed.hostname = 'twitter.com';
    }

    // -----------------------------------------------
    // Mobile Twitter -> Twitter
    // -----------------------------------------------

    if (
      parsed.hostname === 'mobile.twitter.com'
    ) {
      parsed.hostname = 'twitter.com';
    }

    // -----------------------------------------------
    // Mobile Facebook
    // -----------------------------------------------

    if (
      parsed.hostname === 'm.facebook.com' ||
      parsed.hostname === 'mbasic.facebook.com'
    ) {
      parsed.hostname = 'www.facebook.com';
    }

    return parsed.href;

  } catch {
    return url;
  }
}

// ======================================================
// REDIRECT RESOLVER
// ======================================================

async function resolveRedirectUrl(inputUrl) {

  let currentUrl = inputUrl;

  console.log(
    `[RESOLVE] Starting URL: ${currentUrl}`
  );

  for (let i = 0; i < 5; i++) {

    try {

      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () => controller.abort(),
          15000
        );

      const response =
        await fetch(
          currentUrl,
          {
            method: 'GET',

            redirect: 'manual',

            signal: controller.signal,

            headers: {
              'User-Agent': USER_AGENT,
              'Accept':
                'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language':
                'en-US,en;q=0.9'
            }
          }
        );

      clearTimeout(timeout);

      // ---------------------------------------------
      // Redirect
      // ---------------------------------------------

      if (
        response.status >= 300 &&
        response.status < 400
      ) {

        const location =
          response.headers.get(
            'location'
          );

        if (!location) {
          break;
        }

        currentUrl =
          new URL(
            location,
            currentUrl
          ).href;

        console.log(
          `[RESOLVE] Redirect ${i + 1}: ${currentUrl}`
        );

        continue;
      }

      // ---------------------------------------------
      // Final URL from response
      // ---------------------------------------------

      try {

        if (
          response.url &&
          response.url !== currentUrl
        ) {
          currentUrl = response.url;
        }

      } catch {}

      break;

    } catch (error) {

      console.log(
        `[RESOLVE] Attempt ${i + 1} failed:`,
        error.message
      );

      break;
    }
  }

  return normalizeUrl(currentUrl);
}

// ======================================================
// PLATFORM-SPECIFIC URL PREPARATION
// ======================================================

async function prepareUrl(
  platform,
  inputUrl
) {

  let url = normalizeUrl(
    inputUrl
  );

  // ====================================================
  // PINTEREST
  // ====================================================

  if (
    platform === 'pinterest' &&
    (
      url.includes('pin.it') ||
      url.includes('pinterest.com')
    )
  ) {

    console.log(
      '[PREPARE] Resolving Pinterest URL'
    );

    const resolved =
      await resolveRedirectUrl(url);

    if (resolved) {
      url = resolved;
    }

    console.log(
      `[PREPARE] Pinterest final URL: ${url}`
    );
  }

  // ====================================================
  // FACEBOOK
  // ====================================================

  if (
    platform === 'facebook'
  ) {

    if (
      url.includes('/share/') ||
      url.includes('fb.watch')
    ) {

      console.log(
        '[PREPARE] Resolving Facebook share URL'
      );

      const resolved =
        await resolveRedirectUrl(url);

      if (resolved) {
        url = resolved;
      }

      console.log(
        `[PREPARE] Facebook final URL: ${url}`
      );
    }
  }

  // ====================================================
  // X / TWITTER
  // ====================================================

  if (
    platform === 'twitter'
  ) {

    url = normalizeUrl(url);

    console.log(
      `[PREPARE] Twitter/X URL: ${url}`
    );
  }

  // ====================================================
  // YOUTUBE
  // ====================================================

  if (
    platform === 'youtube'
  ) {

    try {

      const parsed =
        new URL(url);

      // Shorts:
      //
      // /shorts/VIDEO_ID
      //
      // Convert to:
      //
      // /watch?v=VIDEO_ID

      if (
        parsed.pathname.startsWith(
          '/shorts/'
        )
      ) {

        const videoId =
          parsed.pathname
            .split('/')
            .filter(Boolean)[1];

        if (videoId) {

          url =
            `https://www.youtube.com/watch?v=${videoId}`;

          console.log(
            `[PREPARE] YouTube Shorts converted to: ${url}`
          );
        }
      }

      // youtu.be
      if (
        parsed.hostname ===
          'youtu.be' ||
        parsed.hostname ===
          'www.youtu.be'
      ) {

        const videoId =
          parsed.pathname
            .split('/')
            .filter(Boolean)[0];

        if (videoId) {

          url =
            `https://www.youtube.com/watch?v=${videoId}`;

          console.log(
            `[PREPARE] youtu.be converted to: ${url}`
          );
        }
      }

    } catch {}
  }

  return url;
}

// ======================================================
// RECURSIVE MEDIA URL EXTRACTION
// ======================================================

function extractAllMediaUrls(
  value,
  found = [],
  depth = 0
) {

  // Prevent huge/deep recursion
  if (
    value === null ||
    value === undefined ||
    depth > 12
  ) {
    return found;
  }

  // Prevent duplicate primitive values
  if (
    typeof value === 'string'
  ) {

    if (
      isValidHttpUrl(value)
    ) {

      const lower =
        value.toLowerCase();

      // Don't treat ordinary webpage URLs
      // as downloadable media unless they
      // look like media URLs.

      const looksLikeMedia =
        lower.includes('.mp4') ||
        lower.includes('.m4v') ||
        lower.includes('.mov') ||
        lower.includes('.webm') ||
        lower.includes('.m3u8') ||
        lower.includes('.mpd') ||
        lower.includes('video') ||
        lower.includes('media') ||
        lower.includes('download') ||
        lower.includes('blob');

      if (
        looksLikeMedia &&
        !found.includes(value)
      ) {
        found.push(value);
      }
    }

    return found;
  }

  // Arrays
  if (
    Array.isArray(value)
  ) {

    for (
      const item of value
    ) {

      extractAllMediaUrls(
        item,
        found,
        depth + 1
      );
    }

    return found;
  }

  // Objects
  if (
    typeof value === 'object'
  ) {

    for (
      const [key, item] of
      Object.entries(value)
    ) {

      // ---------------------------------------------
      // Known media keys
      // ---------------------------------------------

      const lowerKey =
        key.toLowerCase();

      const isMediaKey =
        lowerKey.includes('url') ||
        lowerKey.includes('video') ||
        lowerKey.includes('download') ||
        lowerKey.includes('media') ||
        lowerKey.includes('source') ||
        lowerKey.includes('stream') ||
        lowerKey.includes('play') ||
        lowerKey.includes('file');

      if (
        isMediaKey &&
        typeof item === 'string' &&
        isValidHttpUrl(item)
      ) {

        if (
          !found.includes(item)
        ) {
          found.push(item);
        }
      }

      // Continue recursively
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
// MEDIA URL SCORE
// ======================================================

function scoreMediaUrl(url) {

  if (
    typeof url !== 'string'
  ) {
    return -1;
  }

  const lower =
    url.toLowerCase();

  let score = 0;

  // Direct video files
  if (
    lower.includes('.mp4')
  ) {
    score += 100;
  }

  if (
    lower.includes('.m4v')
  ) {
    score += 90;
  }

  if (
    lower.includes('.mov')
  ) {
    score += 80;
  }

  if (
    lower.includes('.webm')
  ) {
    score += 70;
  }

  // HLS
  if (
    lower.includes('.m3u8')
  ) {
    score += 50;
  }

  // DASH
  if (
    lower.includes('.mpd')
  ) {
    score += 40;
  }

  // Video/download keywords
  if (
    lower.includes('video')
  ) {
    score += 20;
  }

  if (
    lower.includes('download')
  ) {
    score += 15;
  }

  if (
    lower.includes('media')
  ) {
    score += 10;
  }

  return score;
}

// ======================================================
// BEST MEDIA URL
// ======================================================

function extractBestMediaUrl(
  result
) {

  const urls =
    extractAllMediaUrls(
      result
    );

  if (
    urls.length === 0
  ) {
    return null;
  }

  urls.sort(
    (a, b) =>
      scoreMediaUrl(b) -
      scoreMediaUrl(a)
  );

  console.log(
    '[MEDIA] Candidate URLs:',
    urls.length
  );

  urls.slice(
    0,
    5
  ).forEach(
    (url, index) => {

      console.log(
        `[MEDIA] ${index + 1}: score=${scoreMediaUrl(url)}`
      );
    }
  );

  return urls[0];
}

// ======================================================
// EXTRACTOR
// ======================================================

async function runExtractor(
  platform,
  url
) {

  switch (platform) {

    // --------------------------------------------------
    // Instagram
    // --------------------------------------------------

    case 'instagram':

      console.log(
        '[EXTRACTOR] Instagram -> igdl()'
      );

      return await igdl(url);

    // --------------------------------------------------
    // TikTok
    // --------------------------------------------------

    case 'tiktok':

      console.log(
        '[EXTRACTOR] TikTok -> ttdl()'
      );

      return await ttdl(url);

    // --------------------------------------------------
    // Facebook
    // --------------------------------------------------

    case 'facebook':

      console.log(
        '[EXTRACTOR] Facebook -> fbdown()'
      );

      return await fbdown(url);

    // --------------------------------------------------
    // Pinterest
    // --------------------------------------------------

    case 'pinterest':

      console.log(
        '[EXTRACTOR] Pinterest -> pinterest()'
      );

      return await pinterest(url);

    // --------------------------------------------------
    // Twitter/X
    // --------------------------------------------------

    case 'twitter':

      console.log(
        '[EXTRACTOR] Twitter/X -> twitter()'
      );

      return await twitter(url);

    // --------------------------------------------------
    // YouTube
    // --------------------------------------------------

    case 'youtube':

      console.log(
        '[EXTRACTOR] YouTube -> youtube()'
      );

      return await youtube(url);

    default:

      throw new Error(
        `Unsupported platform: ${platform}`
      );
  }
}

// ======================================================
// TIMEOUT WRAPPER
// ======================================================

async function withTimeout(
  promise,
  timeoutMs
) {

  let timer;

  const timeout =
    new Promise(
      (_, reject) => {

        timer =
          setTimeout(
            () => {

              reject(
                new Error(
                  `Extraction timed out after ${Math.round(timeoutMs / 1000)} seconds`
                )
              );

            },
            timeoutMs
          );
      }
    );

  try {

    return await Promise.race([
      promise,
      timeout
    ]);

  } finally {

    clearTimeout(timer);
  }
}

// ======================================================
// SAFE DEBUG RESULT
// ======================================================

function makeSafeDebug(
  result
) {

  if (
    result === null ||
    result === undefined
  ) {
    return null;
  }

  if (
    typeof result === 'string'
  ) {

    return {
      type: 'string',
      length: result.length,
      preview:
        result.substring(0, 200)
    };
  }

  if (
    Array.isArray(result)
  ) {

    return {
      type: 'array',
      length: result.length,
      firstItem:
        result.length > 0
          ? summarizeObject(
              result[0]
            )
          : null
    };
  }

  if (
    typeof result === 'object'
  ) {

    return summarizeObject(
      result
    );
  }

  return {
    type: typeof result
  };
}

// ======================================================
// OBJECT SUMMARY
// ======================================================

function summarizeObject(
  value,
  depth = 0
) {

  if (
    depth > 3
  ) {
    return '[nested object]';
  }

  if (
    value === null ||
    value === undefined
  ) {
    return value;
  }

  if (
    typeof value === 'string'
  ) {

    if (
      isValidHttpUrl(value)
    ) {
      return '[URL]';
    }

    return value.length > 150
      ? value.substring(0, 150) + '...'
      : value;
  }

  if (
    typeof value !== 'object'
  ) {
    return value;
  }

  if (
    Array.isArray(value)
  ) {

    return {
      type: 'array',
      length: value.length,
      first:
        value.length > 0
          ? summarizeObject(
              value[0],
              depth + 1
            )
          : null
    };
  }

  const output = {};

  for (
    const [key, item] of
    Object.entries(value)
  ) {

    const lowerKey =
      key.toLowerCase();

    // Never expose huge signed media URLs
    if (
      typeof item === 'string' &&
      isValidHttpUrl(item)
    ) {

      output[key] =
        '[URL]';

      continue;
    }

    if (
      typeof item === 'string'
    ) {

      output[key] =
        item.length > 200
          ? item.substring(0, 200) + '...'
          : item;

      continue;
    }

    if (
      typeof item === 'object' &&
      item !== null
    ) {

      output[key] =
        summarizeObject(
          item,
          depth + 1
        );

      continue;
    }

    output[key] =
      item;
  }

  return output;
}

// ======================================================
// MAIN EXTRACT API
// ======================================================

app.post(
  '/api/extract',
  async (req, res) => {

    const started =
      Date.now();

    try {

      // ==================================================
      // 1. Validate body
      // ==================================================

      const body =
        req.body || {};

      const rawUrl =
        body.url;

      if (
        !rawUrl
      ) {

        return res.status(400).json({
          success: false,
          error: 'URL is required'
        });
      }

      if (
        typeof rawUrl !== 'string'
      ) {

        return res.status(400).json({
          success: false,
          error: 'URL must be a string'
        });
      }

      // ==================================================
      // 2. Clean
      // ==================================================

      let inputUrl =
        cleanInputUrl(
          rawUrl
        );

      if (
        !inputUrl
      ) {

        return res.status(400).json({
          success: false,
          error: 'URL cannot be empty'
        });
      }

      // ==================================================
      // 3. Validate
      // ==================================================

      if (
        !isValidHttpUrl(
          inputUrl
        )
      ) {

        return res.status(400).json({
          success: false,
          error: 'Invalid HTTP/HTTPS URL'
        });
      }

      // ==================================================
      // 4. Detect platform
      // ==================================================

      const detectedPlatform =
        getPlatform(
          inputUrl
        );

      console.log('');
      console.log(
        '================================================'
      );

      console.log(
        `[REQUEST] ${inputUrl}`
      );

      console.log(
        `[REQUEST] Detected platform: ${
          detectedPlatform || 'unknown'
        }`
      );

      console.log(
        '================================================'
      );

      if (
        !detectedPlatform
      ) {

        return res.status(400).json({
          success: false,
          error: 'Unsupported platform',
          supportedPlatforms: [
            'Instagram',
            'TikTok',
            'Facebook',
            'Pinterest',
            'Twitter/X',
            'YouTube'
          ]
        });
      }

      // ==================================================
      // 5. Prepare URL
      // ==================================================

      const preparedUrl =
        await prepareUrl(
          detectedPlatform,
          inputUrl
        );

      console.log(
        `[REQUEST] Prepared URL: ${preparedUrl}`
      );

      // ==================================================
      // 6. Extract
      // ==================================================

      let result;

      try {

        result =
          await withTimeout(
            runExtractor(
              detectedPlatform,
              preparedUrl
            ),
            EXTRACTION_TIMEOUT
          );

      } catch (error) {

        console.error(
          `[EXTRACTOR ERROR] ${detectedPlatform}:`,
          error.message
        );

        return res.status(502).json({

          success: false,

          platform:
            detectedPlatform,

          error:
            error.message ||
            'Platform extraction failed',

          originalUrl:
            inputUrl,

          preparedUrl:
            preparedUrl
        });
      }

      // ==================================================
      // 7. Result information
      // ==================================================

      console.log(
        `[RESULT] Type: ${
          Array.isArray(result)
            ? 'array'
            : typeof result
        }`
      );

      if (
        result &&
        typeof result === 'object'
      ) {

        console.log(
          '[RESULT] Keys:',
          Object.keys(result)
        );
      }

      // ==================================================
      // 8. Find media URL
      // ==================================================

      const mediaUrl =
        extractBestMediaUrl(
          result
        );

      // ==================================================
      // 9. No media
      // ==================================================

      if (
        !mediaUrl
      ) {

        const debug =
          makeSafeDebug(
            result
          );

        console.error(
          `[RESULT] No downloadable media URL found for ${detectedPlatform}`
        );

        console.error(
          '[RESULT] Safe debug:',
          JSON.stringify(
            debug,
            null,
            2
          )
        );

        return res.status(404).json({

          success: false,

          platform:
            detectedPlatform,

          error:
            'No downloadable media URL found',

          message:
            'The platform extractor responded, but no direct downloadable media URL was returned. The content may be restricted, unsupported, expired, or the extractor may need an update.',

          originalUrl:
            inputUrl,

          preparedUrl:
            preparedUrl,

          debug:
            debug
        });
      }

      // ==================================================
      // 10. Validate media URL
      // ==================================================

      if (
        !isValidHttpUrl(
          mediaUrl
        )
      ) {

        return res.status(500).json({

          success: false,

          platform:
            detectedPlatform,

          error:
            'Extractor returned an invalid media URL'
        });
      }

      // ==================================================
      // 11. Success
      // ==================================================

      const duration =
        Date.now() -
        started;

      console.log(
        `[SUCCESS] ${detectedPlatform} in ${duration}ms`
      );

      console.log(
        '================================================'
      );

      return res.status(200).json({

        success: true,

        platform:
          detectedPlatform,

        resolutions: {
          '720p':
            mediaUrl
        },

        mediaUrl:
          mediaUrl,

        sourceUrl:
          inputUrl,

        processingTimeMs:
          duration
      });

    } catch (error) {

      console.error(
        '[SERVER ERROR]',
        error
      );

      return res.status(500).json({

        success: false,

        error:
          error?.message ||
          'Internal server error'
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

      error:
        'Endpoint not found',

      path:
        req.path,

      method:
        req.method
    });
  }
);

// ======================================================
// GLOBAL ERROR HANDLER
// ======================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      '[GLOBAL ERROR]',
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
        'Internal server error'
    });
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log('');
    console.log(
      '================================================'
    );

    console.log(
      '       STREAMBOX BACKEND v3.0.0'
    );

    console.log(
      '================================================'
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Node: ${process.version}`
    );

    console.log(
      `Environment: ${
        process.env.NODE_ENV ||
        'production'
      }`
    );

    console.log(
      'Supported platforms:'
    );

    console.log(
      '✓ Instagram'
    );

    console.log(
      '✓ TikTok'
    );

    console.log(
      '✓ Facebook'
    );

    console.log(
      '✓ Pinterest'
    );

    console.log(
      '✓ Twitter/X'
    );

    console.log(
      '✓ YouTube'
    );

    console.log(
      '================================================'
    );

    console.log('');
  }
);
