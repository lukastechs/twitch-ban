const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Generate Twitch App Access Token
async function getTwitchAccessToken() {
  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', {
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials'
    }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 5000
    });

    const { access_token } = response.data;
    console.log('Fetched new access token');
    return access_token;
  } catch (error) {
    console.error('Twitch Token Error:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    throw new Error('Failed to generate Twitch access token');
  }
}

// Root endpoint
app.get('/', (req, res) => {
  res.send('Twitch Sitewide Ban Checker API is running');
});

// Twitch sitewide ban checker endpoint (GET)
app.get('/api/twitch/:username', async (req, res) => {
  const { username } = req.params;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  // Validate username format (basic check for Twitch username rules: 3-25 chars, letters/numbers/underscores)
  if (!/^[a-zA-Z0-9_]{3,25}$/.test(username)) {
    return res.json({
      username: username,
      nickname: 'N/A (Invalid)',
      avatar: 'https://via.placeholder.com/50?text=Invalid',
      ban_status: 'Invalid username format. Twitch usernames must be 3-25 characters, using only letters, numbers, or underscores.',
      profile_link: `https://www.twitch.tv/${username} (Profile unavailable)`
    });
  }

  try {
    const token = await getTwitchAccessToken();
    
    // Fetch user data - this detects sitewide bans via 404
    const userResponse = await axios.get(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`, {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`
      },
      timeout: 5000
    });

    const user = userResponse.data.data[0];
    if (!user) {
      // This shouldn't happen for a successful response, but handle gracefully
      return res.status(404).json({ error: `User ${username} not found or sitewide banned` });
    }

    // User exists and is active - everything is fine
    const banStatus = 'Everything works perfectly! If you\'re experiencing issues, try <a href="https://www.cloudflare.com/learning/dns/what-is-dns/dns-troubleshooting-flush-dns-cache/" target="_blank">flushing your DNS</a> or <a href="https://www.pcmag.com/how-to/how-to-clear-your-cache-on-any-browser" target="_blank">clearing your app cache</a>.';

    res.json({
      username: user.login,
      nickname: user.display_name,
      avatar: user.profile_image_url || 'https://via.placeholder.com/50',
      ban_status: banStatus,
      profile_link: `https://www.twitch.tv/${user.login}`
    });
  } catch (error) {
    if (error.response?.status === 404 || error.response?.status === 400) {
      // Sitewide ban (or non-existent user) detected, or invalid username
      return res.json({
        username: req.params.username,
        nickname: 'N/A (Banned or Invalid)',
        avatar: 'https://via.placeholder.com/50?text=Banned',
        ban_status: 'User appears to be sitewide banned on Twitch or does not exist. Account is inaccessible.',
        profile_link: `https://www.twitch.tv/${req.params.username} (Profile unavailable)`
      });
    }

    console.error('Twitch API Error:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    res.status(error.response?.status || 500).json({
      error: error.message || 'Failed to fetch Twitch data',
      details: error.response?.data || 'No additional details'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`Twitch Sitewide Ban Checker Server running on port ${port}`);
});
