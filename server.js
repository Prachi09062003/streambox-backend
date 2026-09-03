const express = require('express');

const {
  tiktok,
  instagram,
  facebook,
  pinterest,
  twitter,
  whatsapp
} = require('btch-downloader');

const app = express();

app.use(express.json({ limit: '1mb' }));

// ======================================================
// BASIC ROUTES
// ======================================================

// Root / server status
app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'StreamBox Backend',
    status: 'online',
    version: '1.0.0'
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'online',
    service: 'StreamBox Backend'
  });
});

// Browser test for the extract endpoint
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

  if (
    value.includes('instagram.com')
  ) {
    return 'instagram';
  }

  if (
    value.includes('tiktok.com')
  ) {
    return 'tiktok';
  }

  if (
    value.includes('facebook.com') ||
    value.includes('fb.watch')
  ) {
    return 'facebook';
  }

  if (
    value.includes('pinterest.com') ||
    value.includes('pin.it')
  ) {
    return 'pinterest';
  }

  if (
    value.includes('twitter.com') ||
    value.includes('x.com')
  ) {
    return 'twitter';
  }

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

  // Result is a direct string
  if (typeof result === 'string') {
    return result;
  }

  // Result has url
  if (result.url) {
    return result.url;
  }

  // Result has video
  if (result.video) {
    return result.video;
  }

  // Result has data.url
  if (result.data?.url) {
    return result.data.url;
  }

  // Result has data.video
  if (result.data?.video) {
    return result.data.video;
  }

  // Result is an array
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0];

    if (typeof first === 'string') {
      return first;
    }

    if (first?.url) {
      return first.url;
    }

    if (first?.video) {
      return first.video;
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
    // 1. Validate request body
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
    // 6. Call downloader
    // --------------------------------------------------

    let result;

    switch (platform) {

      case 'instagram':
        console.log('[EXTRACT] Calling Instagram extractor...');
        result = await instagram(cleanUrl);
        break;

      case 'tiktok':
        console.log('[EXTRACT] Calling TikTok extractor...');
        result = await tiktok(cleanUrl);
        break;

      case 'facebook':
        console.log('[EXTRACT] Calling Facebook extractor...');
        result = await facebook(cleanUrl);
        break;

      case 'pinterest':
        console.log('[EXTRACT] Calling Pinterest extractor...');
        result = await pinterest(cleanUrl);
        break;

      case 'twitter':
        console.log('[EXTRACT] Calling Twitter/X extractor...');
        result = await twitter(cleanUrl);
        break;

      case 'whatsapp':
        console.log('[EXTRACT] Calling WhatsApp extractor...');
        result = await whatsapp(cleanUrl);
        break;

      default:
        return res.status(400).json({
          success: false,
          error: 'Platform is not supported'
        });
    }


    // --------------------------------------------------
    // 7. Log extractor result
    // --------------------------------------------------

    console.log(
      '[EXTRACT] Extractor returned:',
      JSON.stringify(result)
    );


    // --------------------------------------------------
    // 8. Get media URL
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
        error: 'No downloadable media URL found'
      });
    }


    // --------------------------------------------------
    // 10. Validate returned media URL
    // --------------------------------------------------

    try {
      new URL(mediaUrl);
    } catch (error) {

      console.error(
        '[EXTRACT] Invalid media URL:',
        mediaUrl
      );

      return res.status(500).json({
        success: false,
        error: 'Extractor returned an invalid media URL'
      });
    }


    // --------------------------------------------------
    // 11. Successful response
    // --------------------------------------------------

    console.log(
      `[EXTRACT] Success: ${platform}`
    );

    return res.status(200).json({
      success: true,
      platform: platform,
      resolutions: {
        '720p': mediaUrl
      }
    });

  } catch (error) {

    // --------------------------------------------------
    // Error handler
    // --------------------------------------------------

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
  console.error('[SERVER ERROR]', err);

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
