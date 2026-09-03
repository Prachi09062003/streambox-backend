const express = require('express');

const {
  igdl,
  ttdl,
  fbdown,
  pinterest,
  twitter,
  youtube
} = require('btch-downloader');

const app = express();

app.use(express.json({ limit: '1mb' }));

// ======================================================
// CONFIG
// ======================================================

const PORT = process.env.PORT || 3000;

// ======================================================
// BASIC ROUTES
// ======================================================

app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'StreamBox Backend',
    status: 'online',
    version: '2.0.0'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'online',
    service: 'StreamBox Backend',
    version: '2.0.0'
  });
});

// ======================================================
// EXTRACT API BROWSER TEST
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

  // ----------------------------------------------------
  // Instagram
  // ----------------------------------------------------

  if (
    value.includes('instagram.com')
  ) {
    return 'instagram';
  }

  // ----------------------------------------------------
  // TikTok
  // ----------------------------------------------------

  if (
    value.includes('tiktok.com')
  ) {
    return 'tiktok';
  }

  // ----------------------------------------------------
  // Facebook
  // ----------------------------------------------------

  if (
    value.includes('facebook.com') ||
    value.includes('fb.watch')
  ) {
    return 'facebook';
  }

  // ----------------------------------------------------
  // Pinterest
  // ----------------------------------------------------

  if (
    value.includes('pinterest.com') ||
    value.includes('pin.it')
  ) {
    return 'pinterest';
  }

  // ----------------------------------------------------
  // Twitter / X
  // ----------------------------------------------------

  if (
    value.includes('twitter.com') ||
    value.includes('x.com')
  ) {
    return 'twitter';
  }

  // ----------------------------------------------------
  // YouTube
  // ----------------------------------------------------

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
  } catch (error) {
    return false;
  }
}

// ======================================================
// MEDIA URL EXTRACTION
// ======================================================

function extractMediaUrl(result) {
  if (!result) {
    return null;
  }

  // ----------------------------------------------------
  // Direct string
  // ----------------------------------------------------

  if (typeof result === 'string') {
    if (isValidHttpUrl(result)) {
      return result;
    }

    return null;
  }

  // ----------------------------------------------------
  // Direct URL
  // ----------------------------------------------------

  if (
    typeof result.url === 'string' &&
    isValidHttpUrl(result.url)
  ) {
    return result.url;
  }

  // ----------------------------------------------------
  // Direct video
  // ----------------------------------------------------

  if (
    typeof result.video === 'string' &&
    isValidHttpUrl(result.video)
  ) {
    return result.video;
  }

  // ----------------------------------------------------
  // Direct download
  // ----------------------------------------------------

  if (
    typeof result.download === 'string' &&
    isValidHttpUrl(result.download)
  ) {
    return result.download;
  }

  // ----------------------------------------------------
  // Direct media
  // ----------------------------------------------------

  if (
    typeof result.media === 'string' &&
    isValidHttpUrl(result.media)
  ) {
    return result.media;
  }

  // ====================================================
  // IMPORTANT:
  // btch-downloader Instagram response:
  //
  // {
  //   developer: "BOTCAHX",
  //   status: true,
  //   result: [
  //     {
  //       thumbnail: "...",
  //       url: "..."
  //     }
  //   ]
  // }
  // ====================================================

  if (
    Array.isArray(result.result) &&
    result.result.length > 0
  ) {
    for (const item of result.result) {

      // String item
      if (
        typeof item === 'string' &&
        isValidHttpUrl(item)
      ) {
        return item;
      }

      // Object item
      if (item && typeof item === 'object') {

        if (
          typeof item.url === 'string' &&
          isValidHttpUrl(item.url)
        ) {
          return item.url;
        }

        if (
          typeof item.video === 'string' &&
          isValidHttpUrl(item.video)
        ) {
          return item.video;
        }

        if (
          typeof item.download === 'string' &&
          isValidHttpUrl(item.download)
        ) {
          return item.download;
        }

        if (
          typeof item.media === 'string' &&
          isValidHttpUrl(item.media)
        ) {
          return item.media;
        }

        if (
          typeof item.src === 'string' &&
          isValidHttpUrl(item.src)
        ) {
          return item.src;
        }
      }
    }
  }

  // ====================================================
  // DATA OBJECT
  // ====================================================

  if (
    result.data &&
    typeof result.data === 'object'
  ) {
    const dataUrl = extractMediaUrl(result.data);

    if (dataUrl) {
      return dataUrl;
    }
  }

  // ====================================================
  // NESTED RESULT OBJECT
  // ====================================================

  if (
    result.result &&
    !Array.isArray(result.result) &&
    typeof result.result === 'object'
  ) {
    const nestedUrl = extractMediaUrl(result.result);

    if (nestedUrl) {
      return nestedUrl;
    }
  }

  // ====================================================
  // GENERIC ARRAY
  // ====================================================

  if (Array.isArray(result)) {

    for (const item of result) {

      const url = extractMediaUrl(item);

      if (url) {
        return url;
      }
    }
  }

  return null;
}

// ======================================================
// EXTRACTOR FUNCTION
// ======================================================

async function runExtractor(platform, url) {

  switch (platform) {

    // --------------------------------------------------
    // Instagram
    // --------------------------------------------------

    case 'instagram':

      console.log(
        '[EXTRACT] Running Instagram igdl()'
      );

      return await igdl(url);

    // --------------------------------------------------
    // TikTok
    // --------------------------------------------------

    case 'tiktok':

      console.log(
        '[EXTRACT] Running TikTok ttdl()'
      );

      return await ttdl(url);

    // --------------------------------------------------
    // Facebook
    // --------------------------------------------------

    case 'facebook':

      console.log(
        '[EXTRACT] Running Facebook fbdown()'
      );

      return await fbdown(url);

    // --------------------------------------------------
    // Pinterest
    // --------------------------------------------------

    case 'pinterest':

      console.log(
        '[EXTRACT] Running Pinterest pinterest()'
      );

      return await pinterest(url);

    // --------------------------------------------------
    // Twitter / X
    // --------------------------------------------------

    case 'twitter':

      console.log(
        '[EXTRACT] Running Twitter twitter()'
      );

      return await twitter(url);

    // --------------------------------------------------
    // YouTube
    // --------------------------------------------------

    case 'youtube':

      console.log(
        '[EXTRACT] Running YouTube youtube()'
      );

      return await youtube(url);

    default:

      throw new Error(
        `No extractor configured for platform: ${platform}`
      );
  }
}

// ======================================================
// MAIN EXTRACT API
// ======================================================

app.post('/api/extract', async (req, res) => {

  const requestStartedAt = Date.now();

  try {

    // ==================================================
    // 1. Validate body
    // ==================================================

    const { url } = req.body || {};

    if (!url) {

      return res.status(400).json({
        success: false,
        error: 'URL is required'
      });
    }

    if (typeof url !== 'string') {

      return res.status(400).json({
        success: false,
        error: 'URL must be a string'
      });
    }

    // ==================================================
    // 2. Clean URL
    // ==================================================

    const cleanUrl = url.trim();

    if (!cleanUrl) {

      return res.status(400).json({
        success: false,
        error: 'URL cannot be empty'
      });
    }

    // ==================================================
    // 3. Validate URL
    // ==================================================

    let parsedUrl;

    try {

      parsedUrl = new URL(cleanUrl);

    } catch (error) {

      return res.status(400).json({
        success: false,
        error: 'Invalid URL'
      });
    }

    if (
      parsedUrl.protocol !== 'http:' &&
      parsedUrl.protocol !== 'https:'
    ) {

      return res.status(400).json({
        success: false,
        error: 'Only HTTP and HTTPS URLs are supported'
      });
    }

    // ==================================================
    // 4. Detect platform
    // ==================================================

    const platform = getPlatform(
      parsedUrl.href
    );

    console.log(
      '================================================'
    );

    console.log(
      `[EXTRACT] Platform: ${platform || 'unknown'}`
    );

    console.log(
      `[EXTRACT] URL: ${cleanUrl}`
    );

    // ==================================================
    // 5. Unsupported platform
    // ==================================================

    if (!platform) {

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
    // 6. Run extractor
    // ==================================================

    let result;

    try {

      result = await runExtractor(
        platform,
        cleanUrl
      );

    } catch (extractorError) {

      console.error(
        `[EXTRACT] ${platform} extractor error:`,
        extractorError
      );

      return res.status(502).json({
        success: false,
        platform: platform,
        error:
          extractorError?.message ||
          `${platform} extraction failed`
      });
    }

    // ==================================================
    // 7. Log raw result safely
    // ==================================================

    console.log(
      `[EXTRACT] ${platform} extractor completed`
    );

    console.log(
      '[EXTRACT] Result type:',
      Array.isArray(result)
        ? 'array'
        : typeof result
    );

    // --------------------------------------------------
    // We intentionally do not dump the entire response
    // because some media URLs can contain very long
    // tokens.
    // --------------------------------------------------

    if (
      result &&
      typeof result === 'object'
    ) {

      console.log(
        '[EXTRACT] Result keys:',
        Object.keys(result)
      );

      if (Array.isArray(result.result)) {

        console.log(
          `[EXTRACT] result.result items: ${result.result.length}`
        );

        if (result.result[0]) {

          console.log(
            '[EXTRACT] First result keys:',
            Object.keys(result.result[0])
          );
        }
      }
    }

    // ==================================================
    // 8. Extract media URL
    // ==================================================

    const mediaUrl = extractMediaUrl(
      result
    );

    // ==================================================
    // 9. No media URL
    // ==================================================

    if (!mediaUrl) {

      console.error(
        `[EXTRACT] No media URL found for ${platform}`
      );

      return res.status(404).json({
        success: false,
        platform: platform,
        error: 'No downloadable media URL found'
      });
    }

    // ==================================================
    // 10. Validate extracted media URL
    // ==================================================

    let parsedMediaUrl;

    try {

      parsedMediaUrl = new URL(
        mediaUrl
      );

    } catch (error) {

      console.error(
        '[EXTRACT] Extracted media URL is invalid'
      );

      return res.status(500).json({
        success: false,
        platform: platform,
        error:
          'Extractor returned an invalid media URL'
      });
    }

    if (
      parsedMediaUrl.protocol !== 'http:' &&
      parsedMediaUrl.protocol !== 'https:'
    ) {

      return res.status(500).json({
        success: false,
        platform: platform,
        error:
          'Extractor returned an unsupported media URL'
      });
    }

    // ==================================================
    // 11. Success
    // ==================================================

    const duration =
      Date.now() - requestStartedAt;

    console.log(
      `[EXTRACT] SUCCESS: ${platform} (${duration}ms)`
    );

    console.log(
      '================================================'
    );

    return res.status(200).json({

      success: true,

      platform: platform,

      resolutions: {
        '720p': parsedMediaUrl.href
      }

    });

  } catch (error) {

    console.error(
      '[EXTRACT] UNEXPECTED ERROR:',
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        'Extraction failed'
    });
  }
});

// ======================================================
// 404 HANDLER
// ======================================================

app.use((req, res) => {

  res.status(404).json({

    success: false,

    error: 'Endpoint not found',

    path: req.path,

    method: req.method

  });
});

// ======================================================
// GLOBAL ERROR HANDLER
// ======================================================

app.use((err, req, res, next) => {

  console.error(
    '[SERVER ERROR]',
    err
  );

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({

    success: false,

    error: 'Internal server error'

  });
});

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      '================================================'
    );

    console.log(
      'StreamBox Backend Started'
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Environment: ${process.env.NODE_ENV || 'production'}`
    );

    console.log(
      'Supported platforms:'
    );

    console.log(
      '- Instagram'
    );

    console.log(
      '- TikTok'
    );

    console.log(
      '- Facebook'
    );

    console.log(
      '- Pinterest'
    );

    console.log(
      '- Twitter/X'
    );

    console.log(
      '- YouTube'
    );

    console.log(
      '================================================'
    );
  }
);
