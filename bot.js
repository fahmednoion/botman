require('dotenv').config();
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Browser = require('./browser');
const AIHandler = require('./ai');

// ══════════════════════════════════════════════════════════════
//  EXPRESS SERVER
// ══════════════════════════════════════════════════════════════
const app = express();
const PORT = process.env.PORT || 10000;
const startTime = Date.now();

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: process.env.MIG66_USERNAME,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    accounts: accounts.size,
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/status', (req, res) => {
  const status = [...accounts.values()].map(a => ({
    username: a.username,
    connected: a.isConnected,
    rooms: [...a.joinedRooms],
  }));
  res.json(status);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web service listening on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    for (const acc of accounts.values()) acc.disconnect();
    process.exit(0);
  });
});

// ══════════════════════════════════════════════════════════════
//  CONFIGURATION
// ══════════════════════════════════════════════════════════════
const API_BASE = process.env.API_BASE || 'https://dashboard.mig66.com';
const USERNAME = process.env.MIG66_USERNAME;
const PASSWORD = process.env.MIG66_PASSWORD;
let TOKEN = process.env.MIG66_TOKEN;
const ROOM_ID = parseInt(process.env.MIG66_ROOM_ID || '50');
const TRIGGER = (process.env.TRIGGER_KEYWORD || `@${USERNAME}`).toLowerCase();

const PARENT_USERS = new Set(
  (process.env.PARENT_USERNAMES || 'faysal')
    .split(',')
    .map(u => u.trim().toLowerCase())
    .filter(Boolean)
);

const SUB_PARENT_USERS = new Set(
  (process.env.SUB_PARENT_USERNAMES || '')
    .split(',')
    .map(u => u.trim().toLowerCase())
    .filter(Boolean)
);

const AW_MESSAGE = process.env.AW_MESSAGE || 'Wc {username}';
const DEBUG = process.env.DEBUG === 'true';

// Initialize Browser and AI
const browser = new Browser(API_BASE);
const ai = new AIHandler('mistral', process.env.MISTRAL_API_KEY);

function isParent(username) {
  return PARENT_USERS.has(username.toLowerCase());
}

function isSubParent(username) {
  return SUB_PARENT_USERS.has(username.toLowerCase());
}

function isAuthorized(username) {
  return isParent(username) || isSubParent(username);
}

const ROOM_LIST = new Map([
  ['Dhaka', 50],
  ['Bangladesh', 1],
  ['India', 2],
  ['Nepal', 3],
  ['Philippine', 4],
  ['Indonesia', 5],
  ['Savages', 46],
]);

// ══════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

function addRoom(name, roomId) {
  ROOM_LIST.set(name.trim(), Number(roomId));
}

function removeRoom(name) {
  ROOM_LIST.delete(name.trim());
}

function listRooms() {
  return [...ROOM_LIST.entries()].map(([name, id]) => `${name}=${id}`).join(', ');
}

function saveTokenToEnv(newToken) {
  try {
    TOKEN = newToken;
    console.log('[Token] ✅ Token updated in memory');
    
    if (process.env.NODE_ENV !== 'production') {
      const envPath = path.join(__dirname, '.env');
      let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      if (content.includes('MIG66_TOKEN=')) {
        content = content.replace(/MIG66_TOKEN=.*/g, `MIG66_TOKEN=${newToken}`);
      } else {
        content += `\nMIG66_TOKEN=${newToken}`;
      }
      fs.writeFileSync(envPath, content, 'utf8');
      console.log('[.env] ✅ Token saved locally');
    }
  } catch (e) {
    console.error('[Token] ❌ Could not save token:', e.message);
  }
}

function loadAutoTexts() {
  const messages = [];
  try {
    const filePath = path.join(__dirname, 'at.txt');
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          messages.push(trimmed);
        }
      }
      console.log(`[AutoText] Loaded ${messages.length} messages from at.txt`);
    } else {
      console.log('[AutoText] at.txt not found, using defaults');
      messages.push('Welcome to our community!');
    }
  } catch (e) {
    console.error('[AutoText] Error:', e.message);
  }
  return messages;
}

function loadFloodTexts() {
  const messages = [];
  try {
    const filePath = path.join(__dirname, 'flood.txt');
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          messages.push(trimmed);
        }
      }
      console.log(`[Flood] Loaded ${messages.length} messages from flood.txt`);
    } else {
      console.log('[Flood] flood.txt not found, using defaults');
      messages.push('🔥 Message 1');
    }
  } catch (e) {
    console.error('[Flood] Error:', e.message);
  }
  return messages;
}

const accounts = new Map();

// ══════════════════════════════════════════════════════════════
//  BOT ACCOUNT CLASS
// ══════════════════════════════════════════════════════════════
class BotAccount {
  constructor({ username, password, token, isMain = false }) {
    this.username = username;
    this.password = password;
    this.token = token || null;
    this.isMain = isMain;
    this.userId = null;
    this.socket = null;
    this.joinedRooms = new Set();
    this.voucherOn = true;
    this.awOn = true;
    this.autoReplyOn = true;
    this.awTemplate = AW_MESSAGE;
    this.awRooms = new Set();
    this.awMessages = new Map();
    this.autoTextOn = false;
    this.autoTextRooms = new Set();
    this.autoTextMessages = [];
    this.autoTextIndex = new Map();
    this.autoTextInterval = 5;
    this.autoTextTimer = null;
    this.floodActive = false;
    this.floodRoomId = null;
    this.floodMessages = [];
    this.floodIndex = 0;
    this.floodInterval = null;
    this.floodMode = 'custom';
    this.floodCustomText = '';
    this.floodMessageCount = 0;
    this.balance = null;
    this.isConnected = false;
    this.reconnTimer = null;
    this.processed = new Set();
    this.startTime = Date.now();
  }

  log(msg) {
    console.log(`[${this.username}] ${msg}`);
  }

  async login() {
    // Check existing token
    if (this.token && !browser.isTokenExpired(this.token)) {
      try {
        const payload = JSON.parse(
          Buffer.from(this.token.split('.')[1], 'base64').toString()
        );
        this.userId = String(payload.id || '');
        const exp = new Date(payload.exp * 1000).toLocaleString();
        this.log(`✓ Token valid — ID: ${this.userId}, expires: ${exp}`);
        return true;
      } catch (e) {
        this.log(`! Token decode error: ${e.message}`);
      }
    }

    if (!this.password) {
      this.log('❌ No password and token expired');
      return false;
    }

    // Login using Browser
    const result = await browser.login(this.username, this.password);
    
    if (!result.success) {
      this.log(`❌ Login failed: ${result.error}`);
      return false;
    }

    this.token = result.token;
    this.userId = result.userId;
    
    if (this.isMain) {
      saveTokenToEnv(this.token);
    }

    return true;
  }

  async api(method, path, body = null) {
    return await browser.apiRequest(method, path, this.token, body);
  }

  sendRoom(roomId, text) {
    if (!this.socket?.connected) return;
    this.socket.emit('send_message', {
      room_id: Number(roomId),
      content: text,
      msg_type: 'text',
      client_msg_id: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    });
  }

  sendPrivate(toUsername, text) {
    if (!this.socket?.connected) return;
    this.socket.emit('private_message', { to_username: toUsername, content: text });
    this.log(`→ PM @${toUsername}: "${text.slice(0, 80)}"`);
  }

  joinRoom(roomId) {
    roomId = Number(roomId);
    if (this.socket?.connected) {
      this.socket.emit('join_room', { room_id: roomId, is_manual: true });
      this.joinedRooms.add(roomId);
      this.log(`+ Joining room ${roomId}`);
    }
  }

  leaveRoom(roomId) {
    roomId = Number(roomId);
    if (this.socket?.connected) {
      this.socket.emit('leave_room', { room_id: roomId });
      this.joinedRooms.delete(roomId);
      this.log(`- Left room ${roomId}`);
    }
  }

  leaveAll() {
    const count = this.joinedRooms.size;
    for (const r of this.joinedRooms) {
      if (this.socket?.connected) {
        this.socket.emit('leave_room', { room_id: r });
      }
    }
    this.joinedRooms.clear();
    return count;
  }

  async sendFriendRequest(username) {
    const r = await this.api('POST', '/api/friends/request', { username });
    this.log(`Friend request → @${username}: ${r.status}`);
    return r;
  }

  async acceptFriendRequest(requestId) {
    const r = await this.api('POST', '/api/friends/accept', { request_id: Number(requestId) });
    this.log(`Accept friend #${requestId}: ${r.status}`);
    return r;
  }

  async getFriendRequests() {
    return await this.api('GET', '/api/friends/requests');
  }

  tryPickVoucher(content, roomId) {
    if (!this.voucherOn) return false;
    if (!content.toLowerCase().includes('pick') || !content.toLowerCase().includes('code')) return false;
    const match = content.match(/\[code\]\s+(\d{4,10})/i);
    if (match) {
      const code = match[1];
      this.log(`🎁 VOUCHER in room ${roomId}! Code: ${code}`);
      this.sendRoom(roomId, `/pick ${code}`);
      return true;
    }
    return false;
  }

  handleUserJoined(data) {
    if (!this.awOn) return;
    const roomId = Number(data.room_id);
    if (!this.joinedRooms.has(roomId)) return;
    if (this.awRooms.size > 0 && !this.awRooms.has(roomId)) return;
    if ((data.username || '').toLowerCase() === this.username.toLowerCase()) return;

    const welcomeMsg = (this.awMessages.get(roomId) || this.awTemplate).replace(
      '{username}',
      data.username
    );
    this.log(`👋 Welcoming @${data.username} in room ${roomId}`);
    setTimeout(() => this.sendRoom(roomId, welcomeMsg), 800);
  }

  // Auto-text methods
  startAutoText() {
    if (!this.autoTextOn || !this.autoTextMessages.length || !this.autoTextRooms.size) return;

    const sendNextMessage = () => {
      if (!this.autoTextOn) return;

      for (const roomId of this.autoTextRooms) {
        if (!this.joinedRooms.has(roomId)) continue;
        if (!this.autoTextIndex.has(roomId)) this.autoTextIndex.set(roomId, 0);

        let index = this.autoTextIndex.get(roomId);
        if (index >= this.autoTextMessages.length) {
          index = 0;
          this.autoTextIndex.set(roomId, 0);
        }

        const message = this.autoTextMessages[index];
        this.sendRoom(roomId, message);
        this.log(`📝 AutoText [${index + 1}/${this.autoTextMessages.length}] → Room ${roomId}`);
        this.autoTextIndex.set(roomId, index + 1);
      }

      const delay = this.autoTextInterval * 60 * 1000;
      this.autoTextTimer = setTimeout(sendNextMessage, delay);
    };

    sendNextMessage();
  }

  stopAutoText() {
    if (this.autoTextTimer) {
      clearTimeout(this.autoTextTimer);
      this.autoTextTimer = null;
    }
  }

  setAutoTextInterval(minutes) {
    this.autoTextInterval = minutes;
    if (this.autoTextOn && this.autoTextTimer) {
      this.stopAutoText();
      this.startAutoText();
    }
  }

  // Flood methods
  startCustomFlood(roomId, customText) {
    this.stopFlood();
    this.floodActive = true;
    this.floodRoomId = Number(roomId);
    this.floodMode = 'custom';
    this.floodCustomText = customText;
    this.floodMessageCount = 0;
    this.log(`🌊 CUSTOM FLOOD STARTED in room ${roomId}`);

    const sendFloodMessage = () => {
      if (!this.floodActive || !this.socket?.connected) {
        this.stopFlood();
        return;
      }
      this.sendRoom(this.floodRoomId, this.floodCustomText);
      this.floodMessageCount++;
      this.floodInterval = setTimeout(sendFloodMessage, 100);
    };

    sendFloodMessage();
    return true;
  }

  startAutoFlood(roomId) {
    this.stopFlood();
    this.floodMessages = loadFloodTexts();

    if (!this.floodMessages.length) {
      this.log('❌ No messages in flood.txt');
      return false;
    }

    this.floodActive = true;
    this.floodRoomId = Number(roomId);
    this.floodMode = 'auto';
    this.floodIndex = 0;
    this.floodMessageCount = 0;
    this.log(`🌊 AUTO FLOOD STARTED in room ${roomId} - ${this.floodMessages.length} messages`);

    const sendFloodMessage = () => {
      if (!this.floodActive || !this.socket?.connected) {
        this.stopFlood();
        return;
      }
      if (this.floodIndex >= this.floodMessages.length) {
        this.floodIndex = 0;
      }
      const message = this.floodMessages[this.floodIndex];
      this.sendRoom(this.floodRoomId, message);
      this.floodIndex++;
      this.floodMessageCount++;
      this.floodInterval = setTimeout(sendFloodMessage, 100);
    };

    sendFloodMessage();
    return true;
  }

  stopFlood() {
    if (this.floodInterval) {
      clearTimeout(this.floodInterval);
      this.floodInterval = null;
    }
    if (this.floodActive) {
      this.log(`🛑 FLOOD STOPPED (${this.floodMessageCount} messages sent)`);
    }
    this.floodActive = false;
    this.floodRoomId = null;
    this.floodMessages = [];
    this.floodIndex = 0;
    this.floodMode = 'custom';
    this.floodCustomText = '';
    this.floodMessageCount = 0;
  }

  getFloodStatus() {
    if (!this.floodActive) return '🔴 OFF';
    if (this.floodMode === 'custom') {
      return `🌊 CUSTOM (room: ${this.floodRoomId}, sent: ${this.floodMessageCount})`;
    } else {
      return `🌊 AUTO (room: ${this.floodRoomId}, sent: ${this.floodMessageCount}, msg: ${this.floodIndex}/${this.floodMessages.length})`;
    }
  }

  statusText() {
    const rooms = this.joinedRooms.size ? [...this.joinedRooms].join(', ') : 'none';
    const awRoomsStr = this.awRooms.size ? [...this.awRooms].join(', ') : 'all';
    const bal = this.balance !== null ? `${this.balance} cents` : 'unknown';
    const uptime = formatUptime((Date.now() - this.startTime) / 1000);

    let atStatus = '🔴 OFF';
    if (this.autoTextOn) {
      const atRoomsStr = [...this.autoTextRooms].join(', ');
      atStatus = `🟢 ON (rooms: ${atRoomsStr}, interval: ${this.autoTextInterval}m)`;
    }

    const floodStatus = this.getFloodStatus();

    return (
      `👤 @${this.username}\n` +
      `  Connection  : ${this.isConnected ? '🟢 Online' : '🔴 Offline'}\n` +
      `  Active rooms: [${rooms}]\n` +
      `  Voucher pick: ${this.voucherOn ? '🟢 ON' : '🔴 OFF'}\n` +
      `  Auto-welcome: ${this.awOn ? `🟢 ON (${awRoomsStr})` : '🔴 OFF'}\n` +
      `  Auto-reply  : ${this.autoReplyOn ? '🟢 ON' : '🔴 OFF'}\n` +
      `  Auto-text   : ${atStatus}\n` +
      `  Flood       : ${floodStatus}\n` +
      `  Balance     : ${bal}\n` +
      `  Uptime      : ${uptime}`
    );
  }

  async handlePrivate(data) {
    const senderId = String(data.sender_id || '');
    const senderName = String(data.sender_name || '');
    const content = String(data.content || '').trim();

    if (!content) return;
    if (this.userId && senderId === this.userId) return;
    if (senderName.toLowerCase() === this.username.toLowerCase()) return;

    this.log(`📨 PM from @${senderName}: "${content.slice(0, 50)}"`);
