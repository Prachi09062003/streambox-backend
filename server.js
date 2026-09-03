const express = require('express');

const {
  igdl,
  ttdl,
  fbdown,
  pinterest,
  twitter,
  whatsapp
} = require('btch-downloader');

const app = express();

app.use(express.json({ limit: '1mb' }));

// ======================================================
// BASIC ROUTES
// ======================================================

app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'StreamBox Backend',
    status: 'online',
    version: '1.1.0'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'online',
    service: 'StreamBox Backend'
  });
});

app.get('/api/extract', (req, res) => {
  res.json({
    success: true,
    message: 'Extract API is working.',
    method: 'POST',
    endpoint: '/api/extract',
    usage: {
      url: 'POST JSON body: { "url": "https://example.com/video" }'
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
    value.includes('instagram.com')
  ) {
    return 'instagram';
  }

  // TikTok
  if (
    value.includes('tiktok.com')
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

  // WhatsApp
  if (
    value.includes('whatsapp.com')
  ) {
    return 'whatsapp';
  }

  return null;
}

// ======================================================
// MEDIA URL EXTRACTION
// ======================================================

function extractMediaUrl(result) {
  if (!result) {
    return null;
  }

  // Direct string
  if (typeof result === 'string') {
    return result;
  }

  // Direct URL
  if (result.url) {
    return result.url;
  }

  // Video
  if (result.video) {
    return result.video;
  }

  // Download URL
  if (result.download) {
    return result.download;
  }

  // Media URL
  if (result.media) {
    return result.media;
  }

  // Data URL
  if (result.data?.url) {
    return result.data.url;
  }

  // Data video
  if (result.data?.video) {
    return result.data.video;
  }

  // Data download
  if (result.data?.download) {
    return result.data.download;
  }

  // Data media
  if (result.data?.media) {
    return result.data.media;
  }

  // Array response
  if (Array.isArray(result) && result.length > 0) {
    for (const item of result) {

      if (typeof item === 'string') {
        return item;
      }

      if (item?.url) {
        return item.url;
      }

      if (item?.video) {
        return item.video;
      }

      if (item?.download) {
        return item.download;
      }

      if (item?.media) {
        return item.media;
      }
    }
  }

  return null;
}

// ======================================================
// MAIN EXTRACT API
// ======================================================

app.post('/api/extract', async (req, res) => {
  try {

    // --------------------------------------------------
    // 1. Validate request
    // --------------------------------------------------

    const { url } = req.body;

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

    // --------------------------------------------------
    // 2. Clean URL
    // --------------------------------------------------

    const cleanUrl = url.trim();

    if (!cleanUrl) {
      return res.status(400).json({
        success: false,
        error: 'URL cannot be empty'
      });
    }

    // --------------------------------------------------
    // 3. Validate URL
    // --------------------------------------------------

    let parsedUrl;

    try {
      parsedUrl = new URL(cleanUrl);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid URL'
      });
    }

    // --------------------------------------------------
    // 4. Detect platform
    // --------------------------------------------------

    const platform = getPlatform(parsedUrl.href);

    console.log(
      `[EXTRACT] Platform: ${platform || 'unknown'}`
    );

    console.log(
      `[EXTRACT] URL: ${cleanUrl}`
    );

    // --------------------------------------------------
    // 5. Unsupported platform
    // --------------------------------------------------

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
          'WhatsApp'
        ]
      });
    }

    // --------------------------------------------------
    // 6. Call correct downloader function
    // --------------------------------------------------

    let result;

    switch (platform) {

      // ----------------------------------------------
      // INSTAGRAM
      // ----------------------------------------------

      case 'instagram':
  console.log('[EXTRACT] Calling Instagram igdl()...');

  result = await igdl(cleanUrl);

  console.log('======================================');
  console.log('INSTAGRAM RAW RESULT');
  console.log(JSON.stringify(result, null, 2));
  console.log('======================================');

  break;

      // ----------------------------------------------
      // TIKTOK
      // ----------------------------------------------

      case 'tiktok':

        console.log(
          '[EXTRACT] Calling TikTok ttdl()...'
        );

        result = await ttdl(cleanUrl);

        break;

      // ----------------------------------------------
      // FACEBOOK
      // ----------------------------------------------

      case 'facebook':

        console.log(
          '[EXTRACT] Calling Facebook fbdown()...'
        );

        result = await fbdown(cleanUrl);

        break;

      // ----------------------------------------------
      // PINTEREST
      // ----------------------------------------------

      case 'pinterest':

        console.log(
          '[EXTRACT] Calling Pinterest pinterest()...'
        );

        result = await pinterest(cleanUrl);

        break;

      // ----------------------------------------------
      // TWITTER / X
      // ----------------------------------------------

      case 'twitter':

        console.log(
          '[EXTRACT] Calling Twitter/X twitter()...'
        );

        result = await twitter(cleanUrl);

        break;

      // ----------------------------------------------
      // WHATSAPP
      // ----------------------------------------------

      case 'whatsapp':

        console.log(
          '[EXTRACT] Calling WhatsApp whatsapp()...'
        );

        result = await whatsapp(cleanUrl);

        break;

      default:

        return res.status(400).json({
          success: false,
          error: 'Platform is not supported'
        });
    }

    // --------------------------------------------------
    // 7. Log result
    // --------------------------------------------------

    console.log(
      '[EXTRACT] Extractor result received.'
    );

    console.log(
      JSON.stringify(result, null, 2)
    );

    // --------------------------------------------------
    // 8. Extract media URL
    // --------------------------------------------------

    const mediaUrl = extractMediaUrl(result);

    // --------------------------------------------------
    // 9. Check media URL
    // --------------------------------------------------

    if (!mediaUrl) {

      console.error(
        '[EXTRACT] No media URL found.'
      );

      return res.status(404).json({
        success: false,
        platform: platform,
        error: 'No downloadable media URL found',
        extractorResponse: result
      });
    }

    // --------------------------------------------------
    // 10. Validate media URL
    // --------------------------------------------------

    let parsedMediaUrl;

    try {
      parsedMediaUrl = new URL(mediaUrl);
    } catch (error) {

      console.error(
        '[EXTRACT] Invalid media URL:',
        mediaUrl
      );

      return res.status(500).json({
        success: false,
        platform: platform,
        error: 'Extractor returned an invalid media URL'
      });
    }

    // --------------------------------------------------
    // 11. Successful response
    // --------------------------------------------------

    console.log(
      `[EXTRACT] Successfully extracted ${platform}`
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
      '[EXTRACT] ERROR:',
      error
    );

    return res.status(500).json({
      success: false,
      error: error?.message || 'Extraction failed'
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

  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// ======================================================
// START SERVER
// ======================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {

  console.log(
    `StreamBox Backend running on port ${PORT}`
  );

  console.log(
    `Port: ${PORT}`
  );
});
