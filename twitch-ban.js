const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Mutex } = require('async-mutex');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// ============================
// CONFIG
// ============================
const CACHE_TTL = 5 * 60 * 1000;           // 5 minutes
const TOKEN_TTL_BUFFER = 60 * 1000;        // Refresh token 60s early
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

app.use(cors());
app.use(express.json());

// In-memory stores
const userCache = new Map();        // username → { data, timestamp }
const tokenCache = { token: null, expiresAt: 0 };
const mutex = new Mutex();

// ============================
// RATE LIMITER
// ============================
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests – please wait a minute before trying again.'
  }
});
app.use('/api/', limiter);

// ============================
// TWITCH TOKEN (cached & safe)
// ============================
async function getTwitchAccessToken() {
  const now = Date.now();

  if (tokenCache.token && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  const release = await mutex.acquire();
  try {
    if (tokenCache.token && tokenCache.expiresAt > Date.now()) {
      return tokenCache.token;
    }

    console.log('Fetching new Twitch access token...');
    const response = await axios.post(
      'https://id.twitch.tv/oauth2/token',
      null,
      {
        params: {
          client_id: process.env.TWITCH_CLIENT_ID,
          client_secret: process.env.TWITCH_CLIENT_SECRET,
          grant_type: 'client_credentials'
        },
        timeout: 8000
      }
    );

    const { access_token, expires_in } = response.data;
    tokenCache.token = access_token;
    tokenCache.expiresAt = Date.now() + (expires_in - 60) * 1000;

    return access_token;
  } catch (error) {
    console.error('Twitch Token Error:', error.response?.data || error.message);
    throw new Error('Failed to authenticate with Twitch');
  } finally {
    release();
  }
}

// ============================
// MAIN ENDPOINT
// ============================
app.get('/api/twitch/:username', async (req, res) => {
  let { username } = req.params;
  username = username.trim().toLowerCase();

  if (!username || username.length < 3 || username.length > 25) {
    return res.json({
      username,
      nickname: 'Invalid',
      avatar: 'https://via.placeholder.com/50?text=Invalid',
      ban_status: 'Twitch usernames must be 3–25 characters long.',
      profile_link: '#'
    });
  }

  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.json({
      username,
      nickname: 'Invalid',
      avatar: 'https://via.placeholder.com/50?text=Invalid',
      ban_status: 'Only letters, numbers, and underscores are allowed.',
      profile_link: '#'
    });
  }

  // === CACHE CHECK ===
  const cached = userCache.get(username);
  if (cached && cached.timestamp > Date.now() - CACHE_TTL) {
    console.log(`Cache hit for @${username}`);
    return res.json({ ...cached.data, cached: true });
  }

  const release = await mutex.acquire();
  try {
    {
    // Re-check cache after lock
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

    // User exists → NOT banned
    if (user) {
      const result = {
        username: user.login,
        nickname: user.display_name,
        avatar: user.profile_image_url || 'https://via.placeholder.com/300',
        ban_status: 'Account is active and accessible. No sitewide ban detected.',
        profile_link: `https://www.twitch.tv/${user.login}`,
        cached: false
      };

      userCache.set(username, { data: result, timestamp: Date.now() });
      return res.json(result);
    }

    // No user found → likely banned or never existed
    const bannedResult = {
      username,
      nickname: 'Not found / Banned',
      avatar: 'https://via.placeholder.com/300?text=Banned',
      ban_status: 'User is sitewide banned or the account never existed.',
      profile_link: `https://www.twitch.tv/${username} (inaccessible)`,
      cached: false
    };

    userCache.set(username, { data: bannedResult, timestamp: Date.now() });
    return res.json(bannedResult);

  } catch (error) {
    // 400/404 from Twitch = banned or invalid name
    if (error.response && (error.response.status === 400 || error.response.status === 404)) {
      const bannedResult = {
        username,
        nickname: 'Not found / Banned',
        avatar: 'https://via.placeholder.com/300?text=Banned',
        ban_status: 'User is sitewide banned or does not exist.',
        profile_link: `https://www.twitch.tv/${username} (inaccessible)`,
        cached: false
      };
      userCache.set(username, { data: bannedResult, timestamp: Date.now() });
      return res.json(bannedResult);
    }

    // Other errors
    console.error('Twitch API Error (ban checker):', {
      username,
      status: error.response?.status,
      message: error.message
    });

    res.status(500).json({
      error: 'Twitch service temporarily unavailable. Try again in a moment.'
    });
  } finally {
    release();
  }
});

// ============================
// ROOT & HEALTH
// ============================
app.get('/', (req, res) => {
  res.send('Twitch Sitewide Ban Checker API is running');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    cache_entries: userCache.size,
    uptime: process.uptime()
  });
});

app.listen(port, () => {
  console.log(`Twitch Ban Checker API running on port ${port}`);
  console.log(`Rate limit: ${RATE_LIMIT_MAX} requests/min per IP`);
  console.log(`Cache TTL: ${CACHE_TTL / 60000} minutes`);
});
