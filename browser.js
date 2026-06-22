const axios = require('axios');

class Browser {
  constructor(apiBase = 'https://dashboard.mig66.com') {
    this.apiBase = apiBase;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'Origin': 'https://web.mig66.com',
      'Referer': 'https://web.mig66.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }

  /**
   * Login to MIG66
   */
  async login(username, password, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`[Browser] Logging in ${username}... (attempt ${attempt}/${retries})`);

        const response = await axios.post(
          `${this.apiBase}/api/auth/login`,
          {
            username,
            password,
            remember_me: true,
            login_offline: false,
            device_info: 'Node.js Bot v2.0',
          },
          {
            headers: this.defaultHeaders,
            timeout: 30000,
          }
        );

        const token = response.data?.token || response.data?.data?.token;
        
        if (!token) {
          console.log(`[Browser] No token in response for ${username}`);
          if (attempt < retries) {
            await this.sleep(attempt * 2000);
            continue;
          }
          return { success: false, error: 'No token received' };
        }

        // Decode token to get user info
        const payload = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64').toString()
        );

        console.log(`[Browser] ✓ ${username} logged in — ID: ${payload.id}`);

        return {
          success: true,
          token,
          userId: String(payload.id),
          username: payload.username,
          exp: payload.exp,
        };

      } catch (error) {
        console.error(`[Browser] Login error for ${username} (attempt ${attempt}):`, error.message);
        
        // Don't retry on 401/403
        if (error.response?.status === 401 || error.response?.status === 403) {
          return { success: false, error: 'Invalid credentials' };
        }

        if (attempt < retries) {
          await this.sleep(attempt * 2000);
          continue;
        }

        return { success: false, error: error.message };
      }
    }

    return { success: false, error: 'Max retries exceeded' };
  }

  /**
   * Make authenticated API request
   */
  async apiRequest(method, path, token, body = null, retries = 2) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const config = {
          method,
          url: `${this.apiBase}${path}`,
          headers: {
            ...this.defaultHeaders,
            'Authorization': `Bearer ${token}`,
          },
          timeout: 15000,
        };

        if (body) {
          config.data = body;
        }

        const response = await axios(config);
        return { status: response.status, data: response.data };

      } catch (error) {
        if (attempt < retries) {
          await this.sleep(1000);
          continue;
        }

        return {
          status: error.response?.status || 500,
          data: error.response?.data || error.message,
        };
      }
    }
  }

  /**
   * Check if token is expired
   */
  isTokenExpired(token) {
    if (!token) return true;
    try {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64').toString()
      );
      const exp = payload.exp * 1000;
      return Date.now() > exp - 3600000; // 1 hour buffer
    } catch {
      return false;
    }
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = Browser;
