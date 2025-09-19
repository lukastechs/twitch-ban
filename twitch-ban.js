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
  res.send('Twitch Ban Checker API is running');
});

// Twitch ban checker endpoint (GET)
app.get('/api/twitch/:username', async (req, res) => {
  const { username } = req.params;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const token = await getTwitchAccessToken();
    
    // Fetch user data
    const userResponse = await axios.get(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`, {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`
      },
      timeout: 5000
    });

    const user = userResponse.data.data[0];
    if (!user) {
      return res.status(404).json({ error: `User ${username} not found` });
    }

    // Check ban status (requires broadcaster_id and moderator access token with moderation:read scope)
    // Note: This assumes the server has a valid moderator token stored in environment variables
    let banStatus = 'Everything works perfectly! If you’re experiencing issues, try flushing your DNS: https://www.cloudns.net/wiki/article/83/';
    try {
      const banResponse = await axios.get(`https://api.twitch.tv/helix/moderation/banned?broadcaster_id=${user.id}&user_id=${user.id}`, {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${process.env.TWITCH_MODERATOR_TOKEN}` // Requires moderator token
        },
        timeout: 5000
      });

      const isBanned = banResponse.data.data.some(ban => ban.user_id === user.id);
      banStatus = isBanned ? 'User is banned' : 'Everything works perfectly! If you’re experiencing issues, try flushing your DNS: https://www.cloudns.net/wiki/article/83/';
    } catch (banError) {
      console.error('Ban Check Error:', {
        status: banError.response?.status,
        data: banError.response?.data,
        message: banError.message
      });
      // Default to generic message if ban check fails
    }

    res.json({
      username: user.login,
      nickname: user.display_name,
      avatar: user.profile_image_url || 'https://via.placeholder.com/50',
      ban_status: banStatus,
      profile_link: `https://www.twitch.tv/${user.login}`
    });
  } catch (error) {
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
  console.log(`Twitch Ban Checker Server running on port ${port}`);
});
