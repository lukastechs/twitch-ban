const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Mutex } = require('async-mutex');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.set('trust proxy', 1); // ← Fixes Render warning

// Simple caches
const userCache = new Map();
const tokenCache = { token: null, expiresAt: 0 };
const mutex = new Mutex();

// Rate limit: 15 requests/min per IP
app.use('/api/', rateLimit({
  windowMs: 60_000,
  max: 15,
  message: { error: "Too many requests — wait 1 minute" }
}));

async function getTwitchAccessToken() {
  if (tokenCache.token && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }

  const release = await mutex.acquire();
  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials'
      },
      timeout: 8000
    });
    tokenCache.token = response.data.access_token;
    tokenCache.expiresAt = Date.now() + (response.data.expires_in - 60) * 1000;
    return tokenCache.token;
  } finally {
    release();
  }
}

app.get('/', (req, res) => {
  res.send('Twitch Sitewide Ban Checker API is running');
});

app.get('/api/twitch/:username', async (req, res) => {
  const { username } = req.params;
  const normalized = username.toLowerCase().trim();

  if (!normalized) {
    return res.status(400).json({ error: 'Username is required' });
  }

  // Your original validation — kept exactly
  if (!/^[a-zA-Z0-9_]{3,25}$/.test(normalized)) {
    return res.json({
      username: normalized,
      nickname: 'N/A (Invalid)',
      avatar: 'https://via.placeholder.com/50?text=Invalid',
      ban_status: 'Invalid username format. Twitch usernames must be 3-25 characters, using only letters, numbers, or underscores.',
      profile_link: `https://www.twitch.tv/${normalized} (Profile unavailable)`
    });
  }

  // Cache check
  if (userCache.has(normalized)) {
    const cached = userCache.get(normalized);
    if (cached.timestamp > Date.now() - 300000) { // 5 min
      return res.json(cached.data);
    }
  }

  try {
    const token = await getTwitchAccessToken();

    const userResponse = await axios.get(`https://api.twitch.tv/helix/users?login=${normalized}`, {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`
      },
      timeout: 8000
    });

    const user = userResponse.data.data[0];

    if (user) {
      // NOT banned — your original message
      const banStatus = 'Everything works perfectly! If you\'re experiencing issues, try <a href="https://www.cloudflare.com/learning/dns/what-is-dns/dns-troubleshooting-flush-dns-cache/" target="_blank">flushing your DNS</a> or <a href="https://www.pcmag.com/how-to/how-to-clear-your-cache-on-any-browser" target="_blank">clearing your app cache</a>.';

      const result = {
        username: user.login,
        nickname: user.display_name,
        avatar: user.profile_image_url || 'https://via.placeholder.com/50',
        ban_status: banStatus,
        profile_link: `https://www.twitch.tv/${user.login}`
      };

      userCache.set(normalized, { data: result, timestamp: Date.now() });
      return res.json(result);
    }

  } catch (error) {
    if (error.response?.status === 404 || error.response?.status === 400) {
      // BANNED — your original message
      const result = {
        username: normalized,
        nickname: 'N/A (Banned or Invalid)',
        avatar: 'https://via.placeholder.com/50?text=Banned',
        ban_status: 'User appears to be sitewide banned on Twitch or does not exist. Account is inaccessible.',
        profile_link: `https://www.twitch.tv/${normalized} (Profile unavailable)`
      };

      userCache.set(normalized, { data: result, timestamp: Date.now() });
      return res.json(result);
    }

    console.error('Twitch API Error:', error.message);
    res.status(500).json({ error: 'Service temporarily unavailable' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`Twitch Sitewide Ban Checker running on port ${port}`);
});
