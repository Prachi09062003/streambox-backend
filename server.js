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

// Health check
app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'StreamBox Backend',
    status: 'online'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'online'
  });
});

function getPlatform(url) {
  const value = url.toLowerCase();

  if (value.includes('instagram.com')) return 'instagram';
  if (value.includes('tiktok.com')) return 'tiktok';
  if (value.includes('facebook.com') || value.includes('fb.watch')) {
    return 'facebook';
  }
  if (value.includes('pinterest.com') || value.includes('pin.it')) {
    return 'pinterest';
  }
  if (value.includes('twitter.com') || value.includes('x.com')) {
    return 'twitter';
  }
  if (value.includes('whatsapp.com')) return 'whatsapp';

  return null;
}

app.post('/api/extract', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'URL is required'
      });
    }

    let cleanUrl = url.trim();

    let parsedUrl;

    try {
      parsedUrl = new URL(cleanUrl);
    } catch {
      return res.status(400).json({
        success: false,
        error: 'Invalid URL'
      });
    }

    const platform = getPlatform(parsedUrl.href);

    console.log(`Extract request: ${platform || 'unknown'}`);

    if (!platform) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported platform'
      });
    }

    let result;

    switch (platform) {
      case 'instagram':
        result = await instagram(cleanUrl);
        break;

      case 'tiktok':
        result = await tiktok(cleanUrl);
        break;

      case 'facebook':
        result = await facebook(cleanUrl);
        break;

      case 'pinterest':
        result = await pinterest(cleanUrl);
        break;

      case 'twitter':
        result = await twitter(cleanUrl);
        break;

      case 'whatsapp':
        result = await whatsapp(cleanUrl);
        break;
    }

    console.log('Extractor result:', JSON.stringify(result));

    let mediaUrl = null;

    if (typeof result === 'string') {
      mediaUrl = result;
    } else if (result?.url) {
      mediaUrl = result.url;
    } else if (result?.video) {
      mediaUrl = result.video;
    } else if (result?.data?.url) {
      mediaUrl = result.data.url;
    } else if (Array.isArray(result)) {
      const first = result[0];

      if (typeof first === 'string') {
        mediaUrl = first;
      } else if (first?.url) {
        mediaUrl = first.url;
      } else if (first?.video) {
        mediaUrl = first.video;
      }
    }

    if (!mediaUrl) {
      return res.status(404).json({
        success: false,
        error: 'No downloadable media URL found'
      });
    }

    return res.json({
      success: true,
      platform,
      resolutions: {
        '720p': mediaUrl
      }
    });

  } catch (error) {
    console.error('Extraction error:', error);

    return res.status(500).json({
      success: false,
      error: error?.message || 'Extraction failed'
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`StreamBox backend running on port ${PORT}`);
});
