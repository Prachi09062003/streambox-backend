const express = require('express');
const { tiktok, instagram, facebook, pinterest, twitter, whatsapp } = require('btch-downloader');
const app = express();
app.use(express.json());

app.post('/api/extract', async (req, res) => {
  try {
    const { url } = req.body;
    let result;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    if (url.includes('instagram.com')) {
      result = await instagram(url);
    } else if (url.includes('tiktok.com')) {
      result = await tiktok(url);
    } else if (url.includes('facebook.com') || url.includes('fb.watch')) {
      result = await facebook(url);
    } else if (url.includes('pinterest.com') || url.includes('pin.it')) {
      result = await pinterest(url);
    } else if (url.includes('twitter.com') || url.includes('x.com')) {
      result = await twitter(url);
    } else if (url.includes('whatsapp.com')) {
      result = await whatsapp(url);
    } else {
      return res.json({ resolutions: { '720p': url } });
    }

    // Comprehensive fallback property parser for npm wrappers
    let mediaUrl = null;
    if (typeof result === 'string') {
      mediaUrl = result;
    } else if (result?.url) {
      mediaUrl = result.url;
    } else if (Array.isArray(result) && result.length > 0) {
      mediaUrl = result[0]?.url || result[0];
    } else if (result?.video) {
      mediaUrl = result.video;
    } else if (result?.download) {
      mediaUrl = result.download;
    }

    if (!mediaUrl) {
      // Fallback: Return original URL if scraper fails so app can attempt direct read
      mediaUrl = url;
    }

    res.json({ resolutions: { '720p': mediaUrl } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
