const axios = require('axios');

class AIHandler {
  constructor(provider = 'mistral', apiKey = null) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.apiUrl = process.env.MISTRAL_API_URL || 'https://api.mistral.ai/v1/chat/completions';
  }

  /**
   * Get AI response
   */
  async getReply(question) {
    if (!this.apiKey) {
      return 'AI is not configured. Please set MISTRAL_API_KEY in environment variables.';
    }

    try {
      const response = await axios.post(
        this.apiUrl,
        {
          model: 'mistral-tiny',
          messages: [{ role: 'user', content: question }],
          max_tokens: 150,
          temperature: 0.7,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          timeout: 15000,
        }
      );

      const reply = response.data?.choices?.[0]?.message?.content;
      return reply || "Sorry, I couldn't generate a response.";

    } catch (error) {
      console.error('[AI] Error:', error.message);
      
      if (error.code === 'ECONNABORTED') {
        return 'Sorry, the AI service took too long to respond.';
      }

      return "Sorry, I couldn't connect to the AI service.";
    }
  }

  /**
   * Check if AI is configured
   */
  isConfigured() {
    return !!this.apiKey;
  }
}

module.exports = AIHandler;
