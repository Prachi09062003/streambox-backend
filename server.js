const express = require('express');
const { tiktok, instagram, facebook, pinterest, twitter, whatsapp } = require('btch-downloader');
const app = express();
app.use(express.json());

app.post('/api/extract', async (req, res) => {
  try {
    const { url } = req.body;
    let result;

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
      // General fallback or direct link handling
      return res.json({ resolutions: { '720p': url } });
    }

    // Extract media URL from result payload
    const mediaUrl = result?.url || result?.[0]?.url || (Array.isArray(result) ? result[0] : null);

    if (!mediaUrl) {
      throw new Error('Could not parse media link from platform response.');
    }

    res.json({ resolutions: { '720p': mediaUrl } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));