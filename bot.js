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

    if (isAuthorized(senderName) && content.startsWith("|")) {
      await handleParentCommand(content, senderName, this);
      return;
    }

    if (content.toLowerCase().startsWith("/a ") && this.autoReplyOn) {
      const question = content.slice(3).trim();
      this.log(`🤖 AI Query from @${senderName}: "${question}"`);
      const reply = await getAIReply(question);
      this.sendPrivate(senderName, reply);
      return;
    }

    if (this.autoReplyOn && content.toLowerCase().includes(TRIGGER)) {
      const question = content.replace(new RegExp(TRIGGER, "gi"), "").trim() || content;
      const key = `pvt:${senderId}:${question.slice(0, 80)}`;
      if (this.processed.has(key)) return;
      this.processed.add(key);
      if (this.processed.size > 500) this.processed.delete(this.processed.values().next().value);
      const reply = await getAIReply(question);
      this.sendPrivate(senderName, reply);
    }
  }

  async handleRoom(data) {
    const senderId = String(data.sender_id || "");
    const senderName = String(data.username || "");
    const content = String(data.content || "").trim();
    const roomId = data.room_id;

    if (!content) return;
    if (this.userId && senderId === this.userId) return;
    if (senderName.toLowerCase() === this.username.toLowerCase()) return;

    if (content.toLowerCase().startsWith("/a ") && this.autoReplyOn) {
      const question = content.slice(3).trim();
      this.log(`🤖 AI Query from @${senderName} in room ${roomId}: "${question}"`);
      const reply = await getAIReply(question);
      this.sendRoom(roomId, `@${senderName} ${reply}`);
      return;
    }

    if (this.tryPickVoucher(content, roomId)) return;

    if (this.autoReplyOn && content.toLowerCase().includes(TRIGGER)) {
      const question = content.replace(new RegExp(TRIGGER, "gi"), "").trim() || content;
      const key = `room:${senderId}:${question.slice(0, 80)}`;
      if (this.processed.has(key)) return;
      this.processed.add(key);
      if (this.processed.size > 500) this.processed.delete(this.processed.values().next().value);
      this.log(`📢 Room @${senderName}: "${question}"`);
      const reply = await getAIReply(question);
      this.sendRoom(roomId, `@${senderName} ${reply}`);
    }
  }

  connect(defaultRoom) {
    if (this.reconnTimer) {
      clearTimeout(this.reconnTimer);
      this.reconnTimer = null;
    }

    if (this.isTokenExpired()) {
      this.log("⚠️  Token expired — re-logging in...");
      this.token = null;
      this.login().then((ok) => {
        if (!ok) {
          this.log("❌ Re-login failed. Retrying in 30s...");
          this.reconnTimer = setTimeout(() => this.connect(defaultRoom), 30000);
        } else {
          this.connect(defaultRoom);
        }
      });
      return;
    }

    this.log("Connecting...");

    this.socket = io(API_BASE, {
      auth: { token: this.token },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      timeout: 20000,
    });

    this.socket.on("connect", async () => {
      this.isConnected = true;
      this.connectionAttempts = 0;
      this.log(`✓ Connected! SID: ${this.socket.id}`);
      
      await new Promise((r) => setTimeout(r, 500));
      
      const rooms = this.joinedRooms.size > 0 ? [...this.joinedRooms] : [defaultRoom];
      this.joinedRooms.clear();
      
      for (const r of rooms) {
        this.joinRoom(r);
      }

      if (this.autoTextOn) this.startAutoText();
    });

    this.socket.on("room_joined", (d) => {
      this.joinedRooms.add(Number(d?.room_id));
      this.log(`✓ Joined room ${d?.room_id} (${d?.members?.length || 0} members)`);
    });

    this.socket.on("user_joined_room", (d) => this.handleUserJoined(d));
    this.socket.on("balance_update", (d) => (this.balance = d?.balance_cents));
    this.socket.on("private_message", (d) => this.handlePrivate(d).catch(console.error));
    this.socket.on("new_message", (d) => this.handleRoom(d).catch(console.error));

    this.socket.on("disconnect", (reason) => {
      this.isConnected = false;
      this.log(`! Disconnected: ${reason}`);
      this.stopAutoText();
      this.stopFlood();
    });

    this.socket.on("connect_error", (e) => {
      this.isConnected = false;
      this.log(`! Connect error: ${e.message}`);
    });

    if (DEBUG) {
      this.socket.onAny((event, data) => {
        const SKIP = ["room_count_update", "private_user_typing", "ping", "pong"];
        if (!SKIP.includes(event))
          this.log(`[evt] "${event}": ${JSON.stringify(data).slice(0, 150)}`);
      });
    }
  }

  disconnect() {
    if (this.reconnTimer) clearTimeout(this.reconnTimer);
    this.stopAutoText();
    this.stopFlood();
    if (this.socket) this.socket.disconnect();
    this.isConnected = false;
  }
}

// ══════════════════════════════════════════════════════════════
//  PARENT COMMAND HANDLER
// ══════════════════════════════════════════════════════════════
async function handleParentCommand(content, senderName, callerAccount) {
  let cmd = content.trim();
  const isFullParent = isParent(senderName);
  const isSubP = isSubParent(senderName);

  const reply = (text) => callerAccount.sendPrivate(senderName, text);

  console.log(`\n[${isFullParent ? "👑 PARENT" : "👤 SUB-PARENT"}] @${senderName} → "${cmd}"`);

  // Extract multiple target accounts using $ syntax
  const targetAccounts = [];
  const acctMatches = cmd.matchAll(/\$(\w+)/g);
  for (const match of acctMatches) {
    const acctName = match[1].toLowerCase();
    if (accounts.has(acctName)) {
      targetAccounts.push(accounts.get(acctName));
    } else {
      reply(`❌ Unknown account $${acctName}`);
      return;
    }
  }

  // Remove all $ references from command
  cmd = cmd.replace(/\s*\$\w+/g, "").trim();

  // Use first target or caller
  const target = targetAccounts.length > 0 ? targetAccounts[0] : callerAccount;

  // Multi-account login: |lnu user1:pass1;user2:pass2;user3:pass3
  const multiLoginMatch = cmd.match(/^\|lnu\s+(.+)/i);
  if (multiLoginMatch) {
    const credentials = multiLoginMatch[1].split(";");
    let successCount = 0;
    let failCount = 0;

    for (const cred of credentials) {
      const parts = cred.trim().split(":");
      if (parts.length !== 2) {
        reply(`❌ Invalid format: "${cred}". Use username:password`);
        continue;
      }

      const [uname, pwd] = parts;
      if (accounts.has(uname.toLowerCase())) {
        reply(`⚠️ @${uname} already logged in`);
        continue;
      }

      const acc = new BotAccount({ username: uname, password: pwd });
      const ok = await acc.login();
      if (!ok) {
        reply(`❌ Login failed for @${uname}`);
        failCount++;
        continue;
      }

      accounts.set(uname.toLowerCase(), acc);
      acc.connect(ROOM_ID);
      successCount++;
    }

    reply(`✅ Multi-login: ${successCount} success, ${failCount} failed`);
    return;
  }

  // Multi-account room join: |jr 228 (uses all targetAccounts)
  const multiJoinMatch = cmd.match(/^\|jr\s+(\d+)/i);
  if (multiJoinMatch) {
    const roomId = multiJoinMatch[1];
    
    if (targetAccounts.length > 0) {
      for (const acc of targetAccounts) {
        acc.joinRoom(roomId);
      }
      const usernames = targetAccounts.map(a => `@${a.username}`).join(", ");
      reply(`✅ ${usernames} → Joining room ${roomId}`);
    } else {
      target.joinRoom(roomId);
      reply(`✅ @${target.username} → Joining room ${roomId}`);
    }
    return;
  }

  // Custom flood: |flood 228 Hello World!
  const customFloodMatch = cmd.match(/^\|flood\s+(\d+)\s+(.+)/i);
  if (customFloodMatch) {
    const roomId = customFloodMatch[1];
    const floodText = customFloodMatch[2].trim();
    
    if (targetAccounts.length === 0) {
      reply(`❌ Please specify account: |flood ${roomId} $username ${floodText}`);
      return;
    }

    for (const acc of targetAccounts) {
      const started = acc.startCustomFlood(roomId, floodText);
      if (started) {
        reply(`🌊 CUSTOM FLOOD STARTED by @${acc.username}\nRoom: ${roomId}\nText: "${floodText}"\nSpeed: 100ms/msg (continuous)`);
      }
    }
    return;
  }

  // Auto flood from flood.txt: |autoflood 228
  const autoFloodMatch = cmd.match(/^\|autoflood\s+(\d+)/i);
  if (autoFloodMatch) {
    const roomId = autoFloodMatch[1];
    
    if (targetAccounts.length === 0) {
      reply(`❌ Please specify account: |autoflood ${roomId} $username`);
      return;
    }

    for (const acc of targetAccounts) {
      const started = acc.startAutoFlood(roomId);
      if (started) {
        reply(`🌊 AUTO FLOOD STARTED by @${acc.username}\nRoom: ${roomId}\nMessages: ${acc.floodMessages.length} from flood.txt\nSpeed: 100ms/msg (loop enabled)`);
      } else {
        reply(`❌ Failed to start auto flood for @${acc.username} - check flood.txt`);
      }
    }
    return;
  }

  // Stop flood: |flood stop
  if (/^\|flood\s+stop/i.test(cmd)) {
    if (targetAccounts.length > 0) {
      for (const acc of targetAccounts) {
        acc.stopFlood();
      }
      const usernames = targetAccounts.map(a => `@${a.username}`).join(", ");
      reply(`🛑 FLOOD STOPPED for ${usernames}`);
    } else {
      target.stopFlood();
      reply(`🛑 FLOOD STOPPED for @${target.username}`);
    }
    return;
  }

  // Reload flood messages: |flood reload
  if (/^\|flood\s+reload/i.test(cmd)) {
    const messages = loadFloodTexts();
    reply(`✅ Reloaded ${messages.length} messages from flood.txt`);
    return;
  }

  // PARENT-ONLY COMMANDS (Sub-parent cannot use these)
  if (!isFullParent) {
    // Commands that sub-parents CANNOT use
    const restrictedCommands = [/^\|ap\s/, /^\|rp\s/, /^\|asp\s/, /^\|rsp\s/];
    
    for (const pattern of restrictedCommands) {
      if (pattern.test(cmd)) {
        reply(`❌ Permission denied. Only full parents can use this command.`);
        return;
      }
    }
  }

  // Add sub-parent (PARENT ONLY)
  const addSubParentMatch = cmd.match(/^\|asp\s+(\w+)/i);
  if (addSubParentMatch && isFullParent) {
    const username = addSubParentMatch[1].toLowerCase();
    SUB_PARENT_USERS.add(username);
    reply(`✅ @${username} added as sub-parent`);
    return;
  }

  // Remove sub-parent (PARENT ONLY)
  const remSubParentMatch = cmd.match(/^\|rsp\s+(\w+)/i);
  if (remSubParentMatch && isFullParent) {
    const username = remSubParentMatch[1].toLowerCase();
    SUB_PARENT_USERS.delete(username);
    reply(`✅ @${username} removed from sub-parents`);
    return;
  }

  // Add parent (PARENT ONLY)
  const addPMatch = cmd.match(/^\|ap\s+(\w+)/i);
  if (addPMatch && isFullParent) {
    PARENT_USERS.add(addPMatch[1].toLowerCase());
    reply(`✅ @${addPMatch[1]} added as parent`);
    return;
  }

  // Remove parent (PARENT ONLY)
  const remPMatch = cmd.match(/^\|rp\s+(\w+)/i);
  if (remPMatch && isFullParent) {
    PARENT_USERS.delete(remPMatch[1].toLowerCase());
    reply(`✅ @${remPMatch[1]} removed from parents`);
    return;
  }

  // Room management
  const addRoomMatch = cmd.match(/^\|addroom\s+(.+)/i);
  if (addRoomMatch) {
    const roomsToAdd = addRoomMatch[1].split(",");
    for (const room of roomsToAdd) {
      const parts = room.split(/[:=]/);
      if (parts.length !== 2) {
        reply(`❌ Invalid: "${room}". Use Name=ID`);
        continue;
      }
      const [name, id] = parts.map((s) => s.trim());
      addRoom(name, id);
      reply(`✅ Added room: ${name}=${id}`);
    }
    return;
  }

  const removeRoomMatch = cmd.match(/^\|removeroom\s+(.+)/i);
  if (removeRoomMatch) {
    const roomsToRemove = removeRoomMatch[1].split(",");
    for (const room of roomsToRemove) {
      const name = room.split(/[:=]/)[0].trim();
      if (ROOM_LIST.has(name)) {
        removeRoom(name);
        reply(`✅ Removed room: ${name}`);
      } else {
        reply(`❌ Room "${name}" not found`);
      }
    }
    return;
  }

  if (/^\|listroom/i.test(cmd)) {
    reply(`📋 Room List:\n${listRooms()}`);
    return;
  }

  // Account logout
  const logoutMatch = cmd.match(/^\|ltu\s+(\w+)/i);
  if (logoutMatch) {
    const uname = logoutMatch[1].toLowerCase();
    if (uname === USERNAME.toLowerCase()) {
      reply("❌ Cannot logout main account");
      return;
    }
    const acc = accounts.get(uname);
    if (!acc) {
      reply(`❌ @${uname} not logged in`);
      return;
    }
    acc.disconnect();
    accounts.delete(uname);
    reply(`✅ @${uname} logged out`);
    return;
  }

  if (/^\|accounts/i.test(cmd)) {
    const list = [...accounts.values()]
      .map((a) => `  @${a.username} ${a.isConnected ? "🟢" : "🔴"} rooms:[${[...a.joinedRooms].join(",") || "none"}]`)
      .join("\n");
    reply(`👥 Active (${accounts.size}):\n${list}`);
    return;
  }

  // Friends
  const sendFriendMatch = cmd.match(/^\|sf\s+(\w+)/i);
  if (sendFriendMatch) {
    const r = await target.sendFriendRequest(sendFriendMatch[1]);
    reply(`${r.status < 400 ? "✅" : "❌"} @${target.username} → Friend request to @${sendFriendMatch[1]}`);
    return;
  }

  const acceptMatch = cmd.match(/^\|af\s+(\d+)/i);
  if (acceptMatch) {
    const r = await target.acceptFriendRequest(acceptMatch[1]);
    reply(`${r.status < 400 ? "✅" : "❌"} @${target.username} → Accepted #${acceptMatch[1]}`);
    return;
  }

  if (/^\|fr/i.test(cmd)) {
    const r = await target.getFriendRequests();
    const requests = Array.isArray(r.data) ? r.data : r.data?.requests || r.data?.data || [];
    if (!requests.length) {
      reply(`📭 No pending requests on @${target.username}`);
      return;
    }
    const list = requests.slice(0, 10)
      .map((rq) => `  ID:${rq.id || rq.request_id} from @${rq.username || rq.sender?.username || "?"}`)
      .join("\n");
    reply(`📬 Requests on @${target.username} (${requests.length}):\n${list}`);
    return;
  }

  if (/^\|balance/i.test(cmd)) {
    if (target.balance !== null) {
      reply(`💰 @${target.username}: ${target.balance} cents`);
      return;
    }
    const r = await target.api("GET", "/api/profile/me");
    const b = r.data?.balance_cents || r.data?.data?.balance_cents || "unknown";
    reply(`💰 @${target.username}: ${b} cents`);
    return;
  }

  // Leave room
  if (/^\|lr\s+all/i.test(cmd)) {
    const count = target.leaveAll();
    reply(`✅ @${target.username} → Left all rooms (${count})`);
    return;
  }

  const leaveMatch = cmd.match(/^\|lr\s+(\d+)/i);
  if (leaveMatch) {
    target.leaveRoom(leaveMatch[1]);
    reply(`✅ @${target.username} → Left room ${leaveMatch[1]}`);
    return;
  }

  // Text room
  const textRoomMatch = cmd.match(/^\|tr\s+(\d+)\s+(.+)/i);
  if (textRoomMatch) {
    target.sendRoom(textRoomMatch[1], textRoomMatch[2].trim());
    reply(`✅ @${target.username} → Sent to room ${textRoomMatch[1]}`);
    return;
  }

  // Toggles
  if (/^\|vp\s+on/i.test(cmd)) {
    target.voucherOn = true;
    reply(`✅ @${target.username} → Voucher ON 🎁`);
    return;
  }
  if (/^\|vp\s+off/i.test(cmd)) {
    target.voucherOn = false;
    reply(`⛔ @${target.username} → Voucher OFF`);
    return;
  }

  // Auto-welcome
  const awOnMatch = cmd.match(/^\|aw\s+on(?:\s+(\d+))?/i);
  if (awOnMatch) {
    const roomId = awOnMatch[1];
    if (roomId) {
      target.awRooms.add(Number(roomId));
      target.awOn = true;
      reply(`✅ @${target.username} → Auto-welcome ON for room ${roomId}`);
    } else {
      target.awOn = true;
      target.awRooms.clear();
      reply(`✅ @${target.username} → Auto-welcome ON (all rooms)`);
    }
    return;
  }

  const awOffMatch = cmd.match(/^\|aw\s+off(?:\s+(\d+))?/i);
  if (awOffMatch) {
    const roomId = awOffMatch[1];
    if (roomId) {
      target.awRooms.delete(Number(roomId));
      if (target.awRooms.size === 0) target.awOn = false;
      reply(`⛔ @${target.username} → Auto-welcome OFF for room ${roomId}`);
    } else {
      target.awOn = false;
      target.awRooms.clear();
      reply(`⛔ @${target.username} → Auto-welcome OFF`);
    }
    return;
  }

  const awMsgMatch = cmd.match(/^\|aw_msg\s+(?:#(\d+)\s+)?(.+)/i);
  if (awMsgMatch) {
    const roomId = awMsgMatch[1];
    const message = awMsgMatch[2].trim();
    if (roomId) {
      target.awMessages.set(Number(roomId), message);
      reply(`✅ @${target.username} → Welcome message for room ${roomId}:\n"${message}"`);
    } else {
      target.awTemplate = message;
      reply(`✅ @${target.username} → Default welcome:\n"${message}"`);
    }
    return;
  }

  // Auto-reply
  if (/^\|ar\s+on/i.test(cmd)) {
    target.autoReplyOn = true;
    reply(`✅ @${target.username} → Auto-reply ON`);
    return;
  }
  if (/^\|ar\s+off/i.test(cmd)) {
    target.autoReplyOn = false;
    reply(`⛔ @${target.username} → Auto-reply OFF`);
    return;
  }

  // Auto-text
  const atOnMatch = cmd.match(/^\|at\s+on(?:\s+(\d+))?/i);
  if (atOnMatch) {
    const roomId = atOnMatch[1];
    if (!target.autoTextMessages.length) {
      target.autoTextMessages = loadAutoTexts();
    }
    if (!target.autoTextMessages.length) {
      reply(`❌ No messages in at.txt`);
      return;
    }
    if (roomId) {
      target.autoTextRooms.add(Number(roomId));
      target.autoTextOn = true;
      if (target.isConnected) {
        target.stopAutoText();
        target.startAutoText();
      }
      reply(`✅ @${target.username} → Auto-text ON for room ${roomId}\n${target.autoTextMessages.length} messages, interval: ${target.autoTextInterval}m`);
    } else {
      reply(`❌ Specify room: |at on <room_id>`);
    }
    return;
  }

  const atOffMatch = cmd.match(/^\|at\s+off(?:\s+(\d+))?/i);
  if (atOffMatch) {
    const roomId = atOffMatch[1];
    if (roomId) {
      target.autoTextRooms.delete(Number(roomId));
      if (target.autoTextRooms.size === 0) {
        target.autoTextOn = false;
        target.stopAutoText();
      }
      reply(`⛔ @${target.username} → Auto-text OFF for room ${roomId}`);
    } else {
      target.autoTextOn = false;
      target.autoTextRooms.clear();
      target.stopAutoText();
      reply(`⛔ @${target.username} → Auto-text OFF`);
    }
    return;
  }

  const atIntervalMatch = cmd.match(/^\|at\s+interval\s+(\d+)/i);
  if (atIntervalMatch) {
    const minutes = Number(atIntervalMatch[1]);
    if (minutes < 1) {
      reply(`❌ Interval must be ≥1 minute`);
      return;
    }
    target.setAutoTextInterval(minutes);
    reply(`✅ @${target.username} → Auto-text interval: ${minutes}m`);
    return;
  }

  if (/^\|at\s+reload/i.test(cmd)) {
    target.autoTextMessages = loadAutoTexts();
    target.autoTextIndex.clear();
    if (target.autoTextOn && target.isConnected) {
      target.stopAutoText();
      target.startAutoText();
    }
    reply(`✅ Reloaded ${target.autoTextMessages.length} messages`);
    return;
  }

  if (/^\|at\s+status/i.test(cmd)) {
    if (!target.autoTextOn) {
      reply(`📝 Auto-text OFF for @${target.username}`);
      return;
    }
    const statusLines = [`📝 Auto-text @${target.username}:`];
    statusLines.push(`  Messages: ${target.autoTextMessages.length}`);
    statusLines.push(`  Interval: ${target.autoTextInterval}m`);
    statusLines.push(`  Rooms: ${[...target.autoTextRooms].join(", ")}`);
    for (const rid of target.autoTextRooms) {
      const curr = target.autoTextIndex.get(rid) || 0;
      statusLines.push(`  Room ${rid}: ${curr + 1}/${target.autoTextMessages.length}`);
    }
    reply(statusLines.join("\n"));
    return;
  }

  // Status
  if (/^\|status/i.test(cmd)) {
    const parents = [...PARENT_USERS].join(", ");
    const subParents = [...SUB_PARENT_USERS].join(", ") || "none";
    const acctStatus = [...accounts.values()].map((a) => a.statusText()).join("\n\n");
    reply(`📊 Bot Status\nParents: [${parents}]\nSub-Parents: [${subParents}]\n\n${acctStatus}`);
    return;
  }

  // Help
  if (/^\|help/i.test(cmd)) {
    let helpText = `📖 Commands (use $ for account):\n\n`;
    helpText += `👥 Accounts:\n  |lnu user1:pass1;user2:pass2\n  |ltu user\n  |accounts\n\n`;
    helpText += `👫 Friends:\n  |sf <user> $account\n  |af <id> $account\n  |fr $account\n  |balance $account\n\n`;
    helpText += `🏠 Rooms:\n  |jr <id> $account1$account2$account3\n  |lr <id/all> $account\n  |tr <id> <msg> $account\n\n`;
    helpText += `🌊 Flood:\n  |flood <room> <text> $account\n  |autoflood <room> $account\n  |flood stop $account\n  |flood reload\n\n`;
    helpText += `📝 Auto-Text (uses at.txt):\n  |at on <room_id> $account\n  |at off [room_id] $account\n  |at interval <min>\n  |at reload\n  |at status\n\n`;
    helpText += `👋 Auto-welcome:\n  |aw on [room_id] $account\n  |aw off [room_id] $account\n  |aw_msg <text>\n\n`;
    helpText += `💬 Auto-reply:\n  |ar on/off $account\n\n`;
    helpText += `🎁 Voucher:\n  |vp on/off $account\n\n`;
    
    if (isFullParent) {
      helpText += `⚙️ Parent Only:\n  |ap <user>\n  |rp <user>\n  |asp <user>\n  |rsp <user>\n\n`;
    }
    
    helpText += `📊 Info:\n  |status\n  |help\n\n`;
    helpText += `💡 Files:\n  - at.txt: Auto-text\n  - flood.txt: Auto flood\n\n`;
    helpText += `Examples:\n  |flood 228 Hello! $user1\n  |autoflood 228 $user1`;
    
    reply(helpText);
    return;
  }

  reply(`❓ Unknown command. Send "|help"`);
}

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  if (!USERNAME) {
    console.error("❌ MIG66_USERNAME missing");
    process.exit(1);
  }
  if (!TOKEN && !PASSWORD) {
    console.error("❌ MIG66_TOKEN or MIG66_PASSWORD missing");
    process.exit(1);
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  mig66 AI Bot  ✅ Full Edition v2.0");
  console.log(`  Main user   : ${USERNAME}`);
  console.log(`  Room        : ${ROOM_ID}`);
  console.log(`  Trigger     : ${TRIGGER}`);
  console.log(`  AI          : ${AI_PROVIDER}`);
  console.log(`  Parents     : ${[...PARENT_USERS].join(", ")}`);
  console.log(`  Sub-Parents : ${[...SUB_PARENT_USERS].join(", ") || "none"}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const mainAccount = new BotAccount({
    username: USERNAME,
    password: PASSWORD,
    token: TOKEN || null,
    isMain: true,
  });

  const ok = await mainAccount.login();
  if (!ok) process.exit(1);

  accounts.set(USERNAME.toLowerCase(), mainAccount);
  mainAccount.connect(ROOM_ID);

  process.on("SIGINT", () => {
    console.log("\n[*] Shutting down...");
    for (const acc of accounts.values()) acc.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
