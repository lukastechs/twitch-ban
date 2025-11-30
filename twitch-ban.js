const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Mutex } = require('async-mutex');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Config
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

app.use(cors());
app.use(express.json());

// In-memory stores
const userCache = new Map();
const tokenCache = { token: null, expiresAt: 0 };
const mutex = new Mutex();

// Rate limiter
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests – please wait a minute.' }
});
app.use('/api/', limiter);

// Get Twitch token (cached)
async function getTwitchAccessToken() {
  if (tokenCache.token && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }

  const release = await mutex.acquire();
  try {
    if (tokenCache.token && tokenCache.expiresAt > Date.now()) return tokenCache.token;

    console.log('Fetching new Twitch token...');
    const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials'
      },
      timeout: 8000
    });

    tokenCache.token = res.data.access_token;
    tokenCache.expiresAt = Date.now() + (res.data.expires_in - 60) * 1000;
    return tokenCache.token;
  } catch (err) {
    console.error('Token error:', err.message);
    throw err;
  } finally {
    release();
  }
}

// Main endpoint
app.get('/api/twitch/:username', async (req, res) => {
  let { username } = req.params;
  username = username.trim().toLowerCase();

  // Basic validation
  if (!username || username.length < 3 || username.length > 25 || !/^[a-z0-9_]+$/i.test(username)) {
    return res.json({
      username,
      nickname: 'Invalid',
      avatar: 'https://via.placeholder.com/50?text=Invalid',
      ban_status: 'Invalid Twitch username format.',
      profile_link: '#'
    });
  }

  // Cache hit?
  const cached = userCache.get(username);
  if (cached && cached.timestamp > Date.now() - CACHE_TTL) {
    return res.json({ ...cached.data, cached: true });
  }

  const release = await mutex.acquire();
  try {
    // Double-check cache
    const again = userCache.get(username);
    if (again && again.timestamp > Date.now() - CACHE_TTL) {
      return res.json({ ...again.data, cached: true });
    }

    const token = await getTwitchAccessToken();

    const response = await axios.get('https://api.twitch.tv/helix/users', {
      params: { login: username },
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`
      },
      timeout: 8000
    });

    const user = response.data.data[0];

    if (user) {
      // User exists → NOT banned
      const result = {
        username: user.login,
        nickname: user.display_name,
        avatar: user.profile_image_url || 'https://via.placeholder.com/300',
        ban_status: 'Account is active – no sitewide ban detected.',
        profile_link: `https://twitch.tv/${user.login}`,
        cached: false
      };
      userCache.set(username, { data: result, timestamp: Date.now() });
      return res.json(result);
    }

    // No user → banned or never existed
    const banned = {
      username,
      nickname: 'Not found',
      avatar: 'https://via.placeholder.com/300?text=Banned',
      ban_status: 'User is sitewide banned or does not exist.',
      profile_link: `https://twitch.tv/${username} (inaccessible)`,
      cached: false
    };
    userCache.set(username, { data: banned, timestamp: Date.now() });
    return res.json(banned);

  } catch (error) {
    if (error.response?.status === 400 || error.response?.status === 404) {
      const banned = {
        username,
        nickname: 'Not found',
        avatar: 'https://via.placeholder.com/300?text=Banned',
        ban_status: 'User is sitewide banned or does not exist.',
        profile_link: `https://twitch.tv/${username} (inaccessible)`,
        cached: false
      };
      userCache.set(username, { data: banned, timestamp: Date.now() });
      return res.json(banned);
    }

    console.error('API Error:', error.message);
    res.status(500).json({ error: 'Twitch service unavailable – try again soon.' });
  } finally {
    release();
  }
});

// Root & health
app.get('/', (req, res) => res.send('Twitch Ban Checker API Running'));
app.get('/health', (req, res) => res.json({ status: 'ok', cache: userCache.size }));

app.listen(port, () => {
  console.log(`Twitch Ban Checker live on port ${port}`);
  console.log(`Rate limit: ${RATE_LIMIT_MAX}/min | Cache: 5 min`);
});
