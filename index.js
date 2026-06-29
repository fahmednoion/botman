require("dotenv").config();
const { io } = require("socket.io-client");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const startTime = Date.now();

app.get("/", (req, res) => {
  res.json({
    status: "online",
    bot: process.env.MIG66_USERNAME,
    uptime: process.uptime(),
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Web service listening on port ${PORT}`);
});

// ══════════════════════════════════════════════════════════════
//  CONFIGURATION
// ══════════════════════════════════════════════════════════════
const API_BASE = process.env.API_BASE || "https://dashboard.mig66.com";
const USERNAME = process.env.MIG66_USERNAME;           // Mother account username
const PASSWORD = process.env.MIG66_PASSWORD;
let TOKEN = process.env.MIG66_TOKEN;
const ROOM_ID = parseInt(process.env.MIG66_ROOM_ID || "50");
const TRIGGER = (process.env.TRIGGER_KEYWORD || `@${USERNAME}`).toLowerCase();
const AW_MESSAGE = process.env.AW_MESSAGE || "Wc {username} 🎉 Welcome!";
const AI_PROVIDER = process.env.AI_PROVIDER || "mistral";
const DEBUG = process.env.DEBUG === "true";

// ── Parent / Sub-parent management ───────────────────────────
const PARENT_USERS = new Set(
  (process.env.PARENT_USERNAMES || process.env.PARENT_USERNAME || "faysal")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean)
);

const SUB_PARENT_USERS = new Set(
  (process.env.SUB_PARENT_USERNAMES || "")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean)
);

function isParent(username) {
  // Mother account is always treated as a full parent
  if (isMother(username)) return true;
  return PARENT_USERS.has((username || "").toLowerCase());
}
function isSubParent(username) {
  return SUB_PARENT_USERS.has((username || "").toLowerCase());
}
function isAuthorized(username) {
  return isParent(username) || isSubParent(username);
}
function isMother(username) {
  return (username || "").toLowerCase() === (USERNAME || "").toLowerCase();
}

// ── Room List ─────────────────────────────────────────────────
const ROOM_LIST = new Map([
  ["Dhaka", 50],
  ["Bangladesh", 1],
  ["India", 2],
  ["Nepal", 3],
  ["Philippine", 4],
  ["Indonesia", 5],
  ["Savages", 21],
  ["Bangladeshi", 20],
  ["Kolkata", 238],
  ["Faysal", 228],
  ["Buy Sell", 288],
  ["Coin Bazar", 305],
  ["Coins Sell group", 306],
  ["BOT PARK", 334],
  ["Chatgpt", 335],
]);

function addRoom(name, roomId) {
  ROOM_LIST.set(name.trim(), Number(roomId));
}
function removeRoom(name) {
  ROOM_LIST.delete(name.trim());
}
function listRooms() {
  return [...ROOM_LIST.entries()].map(([name, id]) => `${name}=${id}`).join(", ");
}

// ══════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

function saveTokenToEnv(newToken) {
  try {
    const envPath = path.join(__dirname, ".env");
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    if (content.includes("MIG66_TOKEN=")) {
      content = content.replace(/MIG66_TOKEN=.*/g, `MIG66_TOKEN=${newToken}`);
    } else {
      content += `\nMIG66_TOKEN=${newToken}`;
    }
    fs.writeFileSync(envPath, content, "utf8");
    console.log(`[.env] ✅ Token saved (${newToken.slice(0, 20)}...)`);
  } catch (e) {
    console.error(`[.env] ❌ Could not save token: ${e.message}`);
  }
}

function loadAutoTexts() {
  const messages = [];
  try {
    const filePath = path.join(__dirname, "at.txt");
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) messages.push(trimmed);
      }
    }
    console.log(`[AutoText] Loaded ${messages.length} messages from at.txt`);
  } catch (e) {
    console.error(`[AutoText] Error loading at.txt: ${e.message}`);
  }
  return messages;
}

function loadFloodTexts() {
  const messages = [];
  try {
    const filePath = path.join(__dirname, "flood.txt");
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) messages.push(trimmed);
      }
    }
    console.log(`[Flood] Loaded ${messages.length} messages from flood.txt`);
  } catch (e) {
    console.error(`[Flood] Error loading flood.txt: ${e.message}`);
  }
  return messages;
}

// ── AI Reply (Mistral) ────────────────────────────────────────
async function getAIReply(question) {
  const API_KEY = process.env.MISTRAL_API_KEY;
  const API_URL = process.env.MISTRAL_API_URL || "https://api.mistral.ai/v1/chat/completions";

  if (!API_KEY) return "AI is not configured. Please set MISTRAL_API_KEY in .env";

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "mistral-tiny",
        messages: [{ role: "user", content: question }],
        max_tokens: 150,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Mistral API error: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Sorry, I couldn't generate a response.";
  } catch (error) {
    console.error("[Mistral AI Error]:", error.message);
    return "Sorry, I couldn't connect to the AI service.";
  }
}

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

    // Feature toggles
    this.voucherOn = true;
    this.awOn = false;
    this.autoReplyOn = false;
    this.awTemplate = AW_MESSAGE;
    this.awRooms = new Set();
    this.awMessages = new Map();

    // Auto-text system
    this.autoTextOn = false;
    this.autoTextRooms = new Set();
    this.autoTextMessages = [];
    this.autoTextIndex = new Map();
    this.autoTextInterval = 5;
    this.autoTextTimer = null;

    // Flood system
    this.floodActive = false;
    this.floodRoomId = null;
    this.floodMessages = [];
    this.floodIndex = 0;
    this.floodInterval = null;
    this.floodMode = "custom";
    this.floodCustomText = "";
    this.floodMessageCount = 0;

    this.balance = null;
    this.isConnected = false;
    this.reconnTimer = null;
    this.tokenRefreshTimer = null;  // proactive token refresh
    this.processed = new Set();
    this.startTime = Date.now();
  }

  log(msg) {
    console.log(`[${this.username}] ${msg}`);
  }

  // ── Login ─────────────────────────────────────────────────
  async login() {
    if (this.token && !this.isTokenExpired()) {
      try {
        const p = JSON.parse(Buffer.from(this.token.split(".")[1], "base64").toString());
        this.userId = String(p.id || "");
        const exp = new Date(p.exp * 1000).toLocaleString();
        this.log(`✓ Token valid — user: ${p.username}, ID: ${this.userId}, expires: ${exp}`);
        this.scheduleTokenRefresh();
        return true;
      } catch (e) {
        this.log(`! Token decode error: ${e.message}`);
      }
    }

    if (!this.password) {
      this.log("❌ No password set and token is missing/expired. Add MIG66_PASSWORD to .env");
      return false;
    }

    this.log("Logging in with password...");
    try {
      const resp = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://web.mig66.com",
          Referer: "https://web.mig66.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
        },
        body: JSON.stringify({
          username: this.username,
          password: this.password,
          remember_me: true,
          login_offline: false,
          device_info: "Flutter Web",
        }),
      });

      const data = await resp.json();
      this.token = data?.token || data?.data?.token;

      if (!this.token) {
        this.log(`❌ Login failed (${resp.status}): ${JSON.stringify(data).slice(0, 200)}`);
        return false;
      }

      const p = JSON.parse(Buffer.from(this.token.split(".")[1], "base64").toString());
      this.userId = String(p.id || "");
      this.log(`✓ Logged in — ID: ${this.userId}`);

      if (this.isMain) {
        saveTokenToEnv(this.token);
        TOKEN = this.token;
      }

      // For sub-accounts: also save token so it survives restarts
      if (!this.isMain && this.token) {
        this.log(`💾 Token saved in memory for auto-refresh`);
      }

      this.scheduleTokenRefresh();
      return true;
    } catch (e) {
      this.log(`❌ Login error: ${e.message}`);
      return false;
    }
  }

  isTokenExpired() {
    if (!this.token) return true;
    try {
      const p = JSON.parse(Buffer.from(this.token.split(".")[1], "base64").toString());
      return Date.now() > p.exp * 1000 - 3600000;
    } catch {
      return false;
    }
  }

  // Returns ms until token expires (negative = already expired)
  getTokenExpiry() {
    if (!this.token) return -1;
    try {
      const p = JSON.parse(Buffer.from(this.token.split(".")[1], "base64").toString());
      return p.exp * 1000 - Date.now();
    } catch { return -1; }
  }

  // ── Proactive token refresh ───────────────────────────────
  // Called after every successful login/connect.
  // Schedules a re-login 60 minutes before the token expires.
  // On success: saves new token to .env and re-authenticates socket.
  scheduleTokenRefresh() {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }

    const msUntilExpiry = this.getTokenExpiry();
    if (msUntilExpiry < 0) {
      // Already expired — refresh immediately
      this.log("⚠️  Token already expired, refreshing now...");
      this.refreshToken();
      return;
    }

    // Refresh 60 minutes before expiry (but at least 30 seconds from now)
    const refreshIn = Math.max(msUntilExpiry - 60 * 60 * 1000, 30000);
    const refreshInMin = Math.round(refreshIn / 60000);
    const expiryDate = new Date(Date.now() + msUntilExpiry).toLocaleString();

    this.log(`🔑 Token expires: ${expiryDate} — auto-refresh in ${refreshInMin}m`);

    this.tokenRefreshTimer = setTimeout(() => this.refreshToken(), refreshIn);
  }

  async refreshToken() {
    if (!this.password) {
      this.log("⚠️  Cannot auto-refresh: no password stored. Use |setpass to set one.");
      return;
    }

    this.log("🔄 Auto-refreshing token...");
    const oldToken = this.token;

    // Force re-login by clearing token
    this.token = null;
    const ok = await this.login();

    if (!ok) {
      this.log("❌ Token refresh failed — restoring old token and retrying in 10m");
      this.token = oldToken;
      this.tokenRefreshTimer = setTimeout(() => this.refreshToken(), 10 * 60 * 1000);
      return;
    }

    this.log(`✅ Token refreshed successfully`);

    // Re-authenticate the live socket with the new token without full reconnect
    if (this.socket?.connected) {
      this.log("🔌 Re-authenticating live socket with new token...");
      // Send auth update event — socket.io supports this natively
      this.socket.auth = { token: this.token };
      // The socket stays connected; new API calls will use the new token automatically
    } else if (this.isConnected === false) {
      // Socket was already down — let reconnect logic handle it
      this.log("ℹ️  Socket offline; new token ready for next reconnect");
    }

    // Schedule the next refresh for the new token
    this.scheduleTokenRefresh();
  }

  async api(method, apiPath, body) {
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
    };
    if (body) opts.body = JSON.stringify(body);
    try {
      const resp = await fetch(`${API_BASE}${apiPath}`, opts);
      const text = await resp.text();
      try {
        return { status: resp.status, data: JSON.parse(text) };
      } catch {
        return { status: resp.status, data: text };
      }
    } catch (e) {
      return { status: 500, data: e.message };
    }
  }

  // ── Messaging ─────────────────────────────────────────────
  sendRoom(roomId, text) {
    if (!this.socket?.connected) return;
    this.socket.emit("send_message", {
      room_id: Number(roomId),
      content: text,
      msg_type: "text",
      client_msg_id: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    });
    this.log(`→ Room ${roomId}: "${text.slice(0, 80)}"`);
  }

  sendPrivate(toUsername, text) {
    if (!this.socket?.connected) return;
    this.socket.emit("private_message", { to_username: toUsername, content: text });
    this.log(`→ PM @${toUsername}: "${text.slice(0, 80)}"`);
  }

  // ── Room control ──────────────────────────────────────────
  joinRoom(roomId) {
    roomId = Number(roomId);
    if (this.socket?.connected) {
      this.socket.emit("join_room", { room_id: roomId, is_manual: true });
      this.joinedRooms.add(roomId);
      this.log(`+ Joining room ${roomId}`);
    }
  }

  leaveRoom(roomId) {
    roomId = Number(roomId);
    if (this.socket?.connected) {
      this.socket.emit("leave_room", { room_id: roomId });
      this.joinedRooms.delete(roomId);
      this.log(`- Left room ${roomId}`);
    }
  }

  leaveAll() {
    for (const r of this.joinedRooms) {
      if (this.socket?.connected) this.socket.emit("leave_room", { room_id: r });
    }
    const count = this.joinedRooms.size;
    this.joinedRooms.clear();
    return count;
  }

  // ── Friend actions ────────────────────────────────────────
  async sendFriendRequest(username) {
    const r = await this.api("POST", "/api/friends/request", { username });
    this.log(`Friend request → @${username}: ${r.status}`);
    return r;
  }

  async acceptFriendRequest(requestId) {
    const r = await this.api("POST", "/api/friends/accept", { request_id: Number(requestId) });
    this.log(`Accept friend #${requestId}: ${r.status}`);
    return r;
  }

  async getFriendRequests() {
    return await this.api("GET", "/api/friends/requests");
  }

  async getFriendsList() {
    return await this.api("GET", "/api/friends");
  }

  async getAccount() {
    return await this.api("GET", "/api/account");
  }

  async getPinStatus() {
    return await this.api("GET", "/api/account/pin/status");
  }

  async transferCoins(toUsername, amount, pin, sendTag = false) {
    const r = await this.api("POST", "/api/account/transfer", {
      to_username: toUsername,
      amount: Number(amount),
      pin: String(pin),
      send_tag: sendTag,
    });
    this.log(`💸 Transfer ${amount} coins → @${toUsername}: ${r.status}`);
    return r;
  }

  // ── Vote ──────────────────────────────────────────────────
  async voteUser(username) {
    const r = await this.api("POST", `/api/profile/${encodeURIComponent(username)}/vote`, {});
    this.log(`🗳️ Vote → @${username}: ${r.status}`);
    return r;
  }

  // ── Email ─────────────────────────────────────────────────
  async sendEmail(toUsername, subject, body) {
    const r = await this.api("POST", "/api/emails/send", {
      to_username: toUsername,
      subject,
      body,
    });
    this.log(`📧 Email → @${toUsername} [${subject}]: ${r.status}`);
    return r;
  }

  async getInbox(filter = "all", page = 1) {
    return await this.api("GET", `/api/emails/inbox?filter=${filter}&page=${page}`);
  }

  // ── Daily XP login bonus ──────────────────────────────────
  async claimDailyLogin() {
    const r = await this.api("POST", "/api/xp/daily-login", {});
    this.log(`🎯 Daily login XP claim: ${r.status}`);
    return r;
  }

  // ── Register new account (no auth needed) ────────────────
  async registerAccount(username, email, password, gender = "male", country = "Bangladesh") {
    try {
      const resp = await fetch(`${API_BASE}/api/auth/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://web.mig66.com",
          Referer: "https://web.mig66.com/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
        },
        body: JSON.stringify({ username, email, password, confirm_password: password, gender, country }),
      });
      const text = await resp.text();
      try { return { status: resp.status, data: JSON.parse(text) }; }
      catch { return { status: resp.status, data: text }; }
    } catch (e) { return { status: 500, data: e.message }; }
  }

  // ── Activate account (no auth needed) ────────────────────
  async activateAccount(activationToken) {
    try {
      const resp = await fetch(`${API_BASE}/api/auth/activate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://web.mig66.com",
          Referer: "https://web.mig66.com/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
        },
        body: JSON.stringify({ token: String(activationToken) }),
      });
      const text = await resp.text();
      try { return { status: resp.status, data: JSON.parse(text) }; }
      catch { return { status: resp.status, data: text }; }
    } catch (e) { return { status: 500, data: e.message }; }
  }


  // ── Voucher auto-pick ─────────────────────────────────────
  tryPickVoucher(content, roomId) {
    if (!this.voucherOn) return false;
    if (!content.toLowerCase().includes("pick") || !content.toLowerCase().includes("code")) return false;
    const match = content.match(/\[code\]\s+(\d{4,10})/i);
    if (match) {
      const code = match[1];
      this.log(`🎁 VOUCHER in room ${roomId}! Code: ${code}`);
      this.sendRoom(roomId, `/pick ${code}`);
      return true;
    }
    return false;
  }

  // ── Auto-welcome ──────────────────────────────────────────
  handleUserJoined(data) {
    if (!this.awOn) return;
    const roomId = Number(data.room_id);
    if (!this.joinedRooms.has(roomId)) return;
    if (this.awRooms.size > 0 && !this.awRooms.has(roomId)) return;
    if ((data.username || "").toLowerCase() === this.username.toLowerCase()) return;

    const welcomeMsg = (this.awMessages.get(roomId) || this.awTemplate).replace("{username}", data.username);
    this.log(`👋 Welcoming @${data.username} in room ${roomId}`);
    setTimeout(() => this.sendRoom(roomId, welcomeMsg), 800);
  }

  // ── Auto-Text System ──────────────────────────────────────
  startAutoText() {
    if (!this.autoTextOn || this.autoTextMessages.length === 0 || this.autoTextRooms.size === 0) return;

    const sendNextMessage = () => {
      if (!this.autoTextOn) return;
      for (const roomId of this.autoTextRooms) {
        if (!this.joinedRooms.has(roomId)) continue;
        if (!this.autoTextIndex.has(roomId)) this.autoTextIndex.set(roomId, 0);
        let index = this.autoTextIndex.get(roomId);
        if (index >= this.autoTextMessages.length) { index = 0; this.autoTextIndex.set(roomId, 0); }
        const message = this.autoTextMessages[index];
        this.sendRoom(roomId, message);
        this.log(`📝 AutoText [${index + 1}/${this.autoTextMessages.length}] → Room ${roomId}`);
        this.autoTextIndex.set(roomId, index + 1);
      }
      this.autoTextTimer = setTimeout(sendNextMessage, this.autoTextInterval * 60 * 1000);
    };

    sendNextMessage();
  }

  stopAutoText() {
    if (this.autoTextTimer) { clearTimeout(this.autoTextTimer); this.autoTextTimer = null; }
  }

  setAutoTextInterval(minutes) {
    this.autoTextInterval = minutes;
    if (this.autoTextOn && this.autoTextTimer) { this.stopAutoText(); this.startAutoText(); }
  }

  // ── Flood System ──────────────────────────────────────────
  startCustomFlood(roomId, customText) {
    this.stopFlood();
    this.floodActive = true;
    this.floodRoomId = Number(roomId);
    this.floodMode = "custom";
    this.floodCustomText = customText;
    this.floodMessageCount = 0;
    this.log(`🌊 CUSTOM FLOOD STARTED in room ${roomId} | text: "${customText}"`);

    const sendFloodMessage = () => {
      if (!this.floodActive || !this.socket?.connected) { this.stopFlood(); return; }
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
    if (this.floodMessages.length === 0) { this.log("❌ No messages in flood.txt"); return false; }

    this.floodActive = true;
    this.floodRoomId = Number(roomId);
    this.floodMode = "auto";
    this.floodIndex = 0;
    this.floodMessageCount = 0;
    this.log(`🌊 AUTO FLOOD STARTED in room ${roomId} — ${this.floodMessages.length} messages`);

    const sendFloodMessage = () => {
      if (!this.floodActive || !this.socket?.connected) { this.stopFlood(); return; }
      if (this.floodIndex >= this.floodMessages.length) this.floodIndex = 0;
      this.sendRoom(this.floodRoomId, this.floodMessages[this.floodIndex]);
      this.floodIndex++;
      this.floodMessageCount++;
      this.floodInterval = setTimeout(sendFloodMessage, 100);
    };
    sendFloodMessage();
    return true;
  }

  stopFlood() {
    if (this.floodInterval) { clearTimeout(this.floodInterval); this.floodInterval = null; }
    if (this.floodActive) {
      this.log(`🛑 FLOOD STOPPED in room ${this.floodRoomId} (${this.floodMessageCount} msgs sent)`);
    }
    this.floodActive = false;
    this.floodRoomId = null;
    this.floodMessages = [];
    this.floodIndex = 0;
    this.floodMode = "custom";
    this.floodCustomText = "";
    this.floodMessageCount = 0;
  }

  getFloodStatus() {
    if (!this.floodActive) return "🔴 OFF";
    if (this.floodMode === "custom") {
      return `🌊 CUSTOM (room: ${this.floodRoomId}, sent: ${this.floodMessageCount}, text: "${this.floodCustomText.slice(0, 30)}...")`;
    }
    return `🌊 AUTO (room: ${this.floodRoomId}, sent: ${this.floodMessageCount}, msg: ${this.floodIndex}/${this.floodMessages.length})`;
  }

  // ── Status text ───────────────────────────────────────────
  statusText() {
    const rooms = this.joinedRooms.size > 0 ? [...this.joinedRooms].join(", ") : "none";
    const awRoomsStr = this.awRooms.size > 0 ? [...this.awRooms].join(", ") : "all";
    const bal = this.balance !== null ? `${this.balance} cents` : "unknown";
    const uptime = formatUptime((Date.now() - this.startTime) / 1000);
    const motherTag = isMother(this.username) ? " 👑MOTHER" : "";

    let atStatus = "🔴 OFF";
    if (this.autoTextOn) {
      const atRoomsStr = [...this.autoTextRooms].join(", ");
      const atProgress = [...this.autoTextRooms]
        .map((rid) => { const cur = this.autoTextIndex.get(rid) || 0; return `R${rid}:${cur}/${this.autoTextMessages.length}`; })
        .join(", ");
      atStatus = `🟢 ON (rooms: ${atRoomsStr}, ${atProgress}, interval: ${this.autoTextInterval}m)`;
    }

    return (
      `👤 @${this.username}${motherTag}\n` +
      `  Connection  : ${this.isConnected ? "🟢 Online" : "🔴 Offline"}\n` +
      `  Active rooms: [${rooms}]\n` +
      `  Voucher pick: ${this.voucherOn ? "🟢 ON" : "🔴 OFF"}\n` +
      `  Auto-welcome: ${this.awOn ? `🟢 ON (rooms: ${awRoomsStr})` : "🔴 OFF"}\n` +
      `  Auto-reply  : ${this.autoReplyOn ? "🟢 ON" : "🔴 OFF"}\n` +
      `  Auto-text   : ${atStatus}\n` +
      `  Flood       : ${this.getFloodStatus()}\n` +
      `  Balance     : ${bal}\n` +
      `  Uptime      : ${uptime}`
    );
  }

  // ── Handle private message ────────────────────────────────
  async handlePrivate(data) {
    const senderId = String(data.sender_id || "");
    const senderName = String(data.sender_name || "");
    const content = String(data.content || "").trim();

    if (!content) return;
    if (this.userId && senderId === this.userId) return;
    if (senderName.toLowerCase() === this.username.toLowerCase()) return;

    this.log(`📨 PM from @${senderName}: "${content}"`);

    // Commands via PM — both parents and sub-parents allowed
    if (isAuthorized(senderName) && content.startsWith("|")) {
      await handleCommand(content, senderName, this, "private");
      return;
    }

    // AI direct trigger /a
    if (content.toLowerCase().startsWith("/a ") && this.autoReplyOn) {
      const question = content.slice(3).trim();
      this.log(`🤖 AI Query from @${senderName}: "${question}"`);
      let reply;
      try { reply = await getAIReply(question); }
      catch (e) { reply = "Sorry, couldn't answer right now!"; }
      this.sendPrivate(senderName, reply);
      return;
    }

    if (this.autoReplyOn) {
      const question = content.replace(new RegExp(TRIGGER, "gi"), "").trim() || content;
      const key = `pvt:${senderId}:${question.slice(0, 80)}`;
      if (this.processed.has(key)) return;
      this.processed.add(key);
      if (this.processed.size > 500) this.processed.delete(this.processed.values().next().value);
      this.log(`💬 PM from @${senderName}: "${question}"`);
      let reply;
      try { reply = await getAIReply(question); }
      catch (e) { reply = "Sorry, couldn't answer right now!"; }
      this.sendPrivate(senderName, reply);
    }
  }

  // ── Handle room message ───────────────────────────────────
  async handleRoom(data) {
    const senderId = String(data.sender_id || "");
    const senderName = String(data.username || "");
    const content = String(data.content || "").trim();
    const roomId = data.room_id;

    if (!content) return;
    if (this.userId && senderId === this.userId) return;
    if (senderName.toLowerCase() === this.username.toLowerCase()) return;

    // Room commands — PARENTS ONLY (sub-parents must use PM)
    if (isParent(senderName) && content.startsWith("|")) {
      await handleCommand(content, senderName, this, "room", roomId);
      return;
    }

    // AI direct trigger /a
    if (content.toLowerCase().startsWith("/a ") && this.autoReplyOn) {
      const question = content.slice(3).trim();
      this.log(`🤖 AI Query from @${senderName} in room ${roomId}: "${question}"`);
      let reply;
      try { reply = await getAIReply(question); }
      catch (e) { reply = "Sorry, couldn't answer right now!"; }
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
      let reply;
      try { reply = await getAIReply(question); }
      catch (e) { reply = "Sorry, couldn't answer right now!"; }
      this.sendRoom(roomId, `@${senderName} ${reply}`);
    }
  }

  // ── Connect socket ─────────────────────────────────────────
  connect(defaultRoom) {
    if (this.reconnTimer) { clearTimeout(this.reconnTimer); this.reconnTimer = null; }

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
      reconnection: false,
    });

    this.socket.on("connect", async () => {
      this.isConnected = true;
      this.log(`✓ Connected! SID: ${this.socket.id}`);
      await new Promise((r) => setTimeout(r, 400));
      const rooms = this.joinedRooms.size > 0 ? [...this.joinedRooms] : [defaultRoom];
      this.joinedRooms.clear();
      for (const r of rooms) this.joinRoom(r);
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
    this.socket.on("private_message_sent", (d) =>
      this.log(`✓ PM delivered: "${String(d?.content || "").slice(0, 60)}"`)
    );

    this.socket.on("disconnect", (reason) => {
      this.isConnected = false;
      this.log(`! Disconnected: ${reason}`);
      this.stopAutoText();
      this.stopFlood();
      if (reason === "io client disconnect") return;
      const delay = 5000;
      this.log(`Reconnecting in ${delay / 1000}s...`);
      this.reconnTimer = setTimeout(async () => {
        if (this.isTokenExpired()) {
          this.log("⚠️  Token expired — re-logging in...");
          this.token = null;
          const ok = await this.login();
          if (!ok) {
            this.log("❌ Re-login failed. Retrying in 30s...");
            this.reconnTimer = setTimeout(() => this.connect(defaultRoom), 30000);
            return;
          }
        }
        this.connect(defaultRoom);
      }, delay);
    });

    this.socket.on("connect_error", (e) => {
      this.isConnected = false;
      this.log(`! Connect error: ${e.message} — retry in 8s`);
      this.reconnTimer = setTimeout(() => this.connect(defaultRoom), 8000);
    });

    if (DEBUG) {
      this.socket.onAny((event, data) => {
        const SKIP = [
          "room_count_update", "private_user_typing", "user_joined", "user_left",
          "user_left_room", "user_joined_room", "room_joined", "new_message",
          "private_message", "private_message_sent", "system_message",
          "uno_state", "balance_update", "connect", "disconnect",
        ];
        if (!SKIP.includes(event))
          this.log(`[evt] "${event}": ${JSON.stringify(data).slice(0, 150)}`);
      });
    }
  }

  disconnect() {
    if (this.reconnTimer) clearTimeout(this.reconnTimer);
    if (this.tokenRefreshTimer) { clearTimeout(this.tokenRefreshTimer); this.tokenRefreshTimer = null; }
    this.stopAutoText();
    this.stopFlood();
    if (this.socket) this.socket.disconnect();
    this.isConnected = false;
  }
}

// ══════════════════════════════════════════════════════════════
//  MULTI-ACCOUNT MANAGER
// ══════════════════════════════════════════════════════════════
const accounts = new Map();

// ── Helper: get all sub-accounts (excludes mother, parents, sub-parents) ─
function getAllSubAccounts() {
  return [...accounts.values()].filter(
    (a) => !isMother(a.username) && !isParent(a.username) && !isSubParent(a.username)
  );
}

// ══════════════════════════════════════════════════════════════
//  UNIFIED COMMAND HANDLER
//  source: "private" | "room"
//  sourceRoomId: room the command came from (when source=room)
// ══════════════════════════════════════════════════════════════
async function handleCommand(content, senderName, callerAccount, source, sourceRoomId = null) {
  // ── BUG FIX: Work on a copy so we can strip $ tokens later
  //    but check permissions on the ORIGINAL cmd first
  const originalCmd = content.trim();
  let cmd = originalCmd;

  const isFullParent = isParent(senderName);
  const isSubP = isSubParent(senderName) && !isFullParent;

  // Sub-parents can only use PM
  if (isSubP && source === "room") return;

  console.log(`\n[${isFullParent ? "👑 PARENT" : "👤 SUB-PARENT"}][${source.toUpperCase()}] @${senderName} → "${cmd}"`);

  // ── Reply helper: PM back the sender always ───────────────
  const reply = (text) => callerAccount.sendPrivate(senderName, text);

  // ── PARENT-ONLY command guard (check BEFORE stripping $) ──
  // BUG FIX: must check on original cmd before $ tokens are removed
  const parentOnlyPattern = /^\|(ap|rp|asp|rsp|lnu|ltu)\b/i;
  if (parentOnlyPattern.test(cmd) && !isFullParent) {
    reply(`❌ Permission denied. Only full parents can use this command.`);
    return;
  }

  // ── Resolve target accounts ───────────────────────────────
  //   $aa  = all sub-accounts (not mother)
  //   $username = specific account
  //   (none) = caller account itself
  let targetAccounts = [];
  let isAllAccounts = false;

  const dollarMatches = [...cmd.matchAll(/\$(\w+)/g)];
  if (dollarMatches.length > 0) {
    for (const match of dollarMatches) {
      const token = match[1].toLowerCase();
      if (token === "aa") {
        isAllAccounts = true;
        targetAccounts = getAllSubAccounts();
        if (targetAccounts.length === 0) {
          reply(`❌ No sub-accounts are currently logged in. Use |lnu to add accounts first.`);
          return;
        }
        break;
      } else if (accounts.has(token)) {
        targetAccounts.push(accounts.get(token));
      } else {
        reply(`❌ Unknown account $${token}. Use |accounts to see active accounts.`);
        return;
      }
    }
    // Strip $ tokens from cmd AFTER permission checks
    cmd = cmd.replace(/\s*\$\w+/g, "").trim();
  } else {
    // Legacy @username targeting
    const atMatch = cmd.match(/^\|\w+\s+@(\w+)/);
    if (atMatch) {
      const acctName = atMatch[1].toLowerCase();
      if (accounts.has(acctName)) {
        targetAccounts.push(accounts.get(acctName));
      } else {
        reply(`❌ Unknown account @${acctName}`);
        return;
      }
    }
  }

  const target = targetAccounts.length > 0 ? targetAccounts[0] : callerAccount;

  // ── $aa guard for sensitive commands ─────────────────────
  const aaRestrictedPattern = /^\|(jr|lr|flood|autoflood)\b/i;
  if (isAllAccounts && aaRestrictedPattern.test(cmd) && !isFullParent) {
    reply(`❌ Sub-parents cannot use $aa with this command. Only full parents can.`);
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  ACCOUNT MANAGEMENT  (parent only — already guarded above)
  // ══════════════════════════════════════════════════════════

  // BUG FIX: |lnu parsing — split only on first colon per credential
  // This correctly handles passwords that contain colons or special chars
  const multiLoginMatch = cmd.match(/^\|lnu\s+(.+)/i);
  if (multiLoginMatch) {
    const rawInput = multiLoginMatch[1].trim();
    // Multiple accounts separated by semicolons: user1:pass1;user2:pass2
    const credentials = rawInput.split(";").map((s) => s.trim()).filter(Boolean);
    let successCount = 0, failCount = 0;

    for (const cred of credentials) {
      // Split only on the FIRST colon — passwords may contain colons or special chars (#@! etc)
      const colonIdx = cred.indexOf(":");
      if (colonIdx === -1) {
        reply(`❌ Invalid format: "${cred}"\nUse: |lnu username:password`);
        continue;
      }
      const uname = cred.slice(0, colonIdx).trim();
      const pwd   = cred.slice(colonIdx + 1).trim();

      if (!uname || !pwd) {
        reply(`❌ Empty username or password in: "${cred}"`);
        continue;
      }
      if (accounts.has(uname.toLowerCase())) {
        reply(`⚠️ @${uname} is already logged in`);
        continue;
      }

      reply(`⏳ Logging in @${uname}...`);
      const acc = new BotAccount({ username: uname, password: pwd });
      const ok = await acc.login();

      if (!ok) {
        reply(`❌ Login failed for @${uname} — check username/password`);
        failCount++;
        continue;
      }

      accounts.set(uname.toLowerCase(), acc);
      acc.connect(ROOM_ID);
      reply(`✅ @${uname} logged in and connected to room ${ROOM_ID}`);
      successCount++;
    }

    if (credentials.length > 1) {
      reply(`📊 Multi-login done: ${successCount} success, ${failCount} failed`);
    }
    return;
  }

  const logoutMatch = cmd.match(/^\|ltu\s+(\w+)/i);
  if (logoutMatch) {
    const uname = logoutMatch[1].toLowerCase();
    if (isMother(uname)) { reply("❌ Cannot logout mother account"); return; }
    const acc = accounts.get(uname);
    if (!acc) { reply(`❌ @${uname} not logged in`); return; }
    acc.disconnect();
    accounts.delete(uname);
    reply(`✅ @${uname} logged out`);
    return;
  }

  // Set/update password for an account (needed for auto-refresh)
  // |setpass <password> [$acc]
  const setPassMatch = cmd.match(/^\|setpass\s+(\S+)/i);
  if (setPassMatch) {
    if (!isFullParent) { reply(`❌ Only full parents can use |setpass`); return; }
    const newPass = setPassMatch[1];
    target.password = newPass;
    reply(`✅ Password updated for @${target.username}\n  Auto-refresh will use this password next cycle.`);
    return;
  }

  // Show token info: |tokeninfo [$acc]
  if (/^\|tokeninfo/i.test(cmd)) {
    const msLeft = target.getTokenExpiry();
    if (msLeft < 0) {
      reply(`🔑 @${target.username}: Token EXPIRED`);
      return;
    }
    const hoursLeft = Math.floor(msLeft / 3600000);
    const minutesLeft = Math.floor((msLeft % 3600000) / 60000);
    const expiryDate = new Date(Date.now() + msLeft).toLocaleString();
    const hasPass = target.password ? "✅ stored" : "❌ not stored (use |setpass)";
    const refreshIn = Math.max(msLeft - 60 * 60 * 1000, 0);
    const refreshMin = Math.round(refreshIn / 60000);
    reply(
      `🔑 Token info — @${target.username}\n` +
      `  Expires in : ${hoursLeft}h ${minutesLeft}m\n` +
      `  Expires at : ${expiryDate}\n` +
      `  Auto-refresh in: ${refreshMin}m\n` +
      `  Password   : ${hasPass}`
    );
    return;
  }

  // Manually trigger token refresh now: |refresh [$acc]
  if (/^\|refresh/i.test(cmd)) {
    if (!isFullParent) { reply(`❌ Only full parents can force a token refresh`); return; }
    if (!target.password) {
      reply(`❌ @${target.username} has no password stored. Use |setpass <password> first.`);
      return;
    }
    reply(`⏳ Forcing token refresh for @${target.username}...`);
    await target.refreshToken();
    const msLeft = target.getTokenExpiry();
    const hoursLeft = Math.floor(msLeft / 3600000);
    const minutesLeft = Math.floor((msLeft % 3600000) / 60000);
    reply(`✅ @${target.username} token refreshed — expires in ${hoursLeft}h ${minutesLeft}m`);
    return;
  }

  if (/^\|accounts/i.test(cmd)) {
    const list = [...accounts.values()]
      .map((a) => {
        const tag = isMother(a.username) ? " 👑" : "";
        return `  @${a.username}${tag} ${a.isConnected ? "🟢" : "🔴"} rooms:[${[...a.joinedRooms].join(",") || "none"}]`;
      })
      .join("\n");
    reply(`👥 Active (${accounts.size}):\n${list}`);
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  ROOM MANAGEMENT
  // ══════════════════════════════════════════════════════════

  const joinMatch = cmd.match(/^\|jr\s+(\d+)/i);
  if (joinMatch) {
    const roomId = joinMatch[1];
    if (isAllAccounts) {
      const subAccs = getAllSubAccounts();
      if (subAccs.length === 0) { reply(`❌ No sub-accounts logged in`); return; }
      for (const acc of subAccs) acc.joinRoom(roomId);
      const names = subAccs.map((a) => `@${a.username}`).join(", ");
      reply(`✅ All sub-accounts joining room ${roomId}:\n${names}`);
    } else if (targetAccounts.length > 0) {
      for (const acc of targetAccounts) acc.joinRoom(roomId);
      const names = targetAccounts.map((a) => `@${a.username}`).join(", ");
      reply(`✅ ${names} → Joining room ${roomId}`);
    } else {
      target.joinRoom(roomId);
      reply(`✅ @${target.username} joining room ${roomId}`);
    }
    return;
  }

  if (/^\|lr\s+all/i.test(cmd)) {
    if (isAllAccounts) {
      let total = 0;
      for (const acc of getAllSubAccounts()) total += acc.leaveAll();
      reply(`✅ All sub-accounts left all their rooms (${total} total)`);
    } else {
      const count = target.leaveAll();
      reply(`✅ @${target.username} left all rooms (${count})`);
    }
    return;
  }

  const leaveMatch = cmd.match(/^\|lr\s+(\d+)/i);
  if (leaveMatch) {
    const roomId = leaveMatch[1];
    if (isAllAccounts) {
      const subAccs = getAllSubAccounts().filter((a) => a.joinedRooms.has(Number(roomId)));
      if (subAccs.length === 0) { reply(`⚠️ No sub-accounts are in room ${roomId}`); return; }
      for (const acc of subAccs) acc.leaveRoom(roomId);
      const names = subAccs.map((a) => `@${a.username}`).join(", ");
      reply(`✅ Left room ${roomId}:\n${names}`);
    } else if (targetAccounts.length > 0) {
      for (const acc of targetAccounts) acc.leaveRoom(roomId);
      reply(`✅ ${targetAccounts.map((a) => `@${a.username}`).join(", ")} left room ${roomId}`);
    } else {
      target.leaveRoom(roomId);
      reply(`✅ @${target.username} left room ${roomId}`);
    }
    return;
  }

  const textRoomMatch = cmd.match(/^\|tr\s+(\d+)\s+(.+)/i);
  if (textRoomMatch) {
    target.sendRoom(textRoomMatch[1], textRoomMatch[2].trim());
    reply(`✅ Sent to room ${textRoomMatch[1]} as @${target.username}`);
    return;
  }

  const addRoomMatch = cmd.match(/^\|addroom\s+(.+)/i);
  if (addRoomMatch) {
    const roomsToAdd = addRoomMatch[1].split(",");
    for (const room of roomsToAdd) {
      const parts = room.split(/[:=]/).map((s) => s.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1]) { reply(`❌ Invalid: "${room}". Use Name=ID`); continue; }
      addRoom(parts[0], parts[1]);
      reply(`✅ Added room: ${parts[0]}=${parts[1]}`);
    }
    return;
  }

  const removeRoomMatch = cmd.match(/^\|removeroom\s+(.+)/i);
  if (removeRoomMatch) {
    const roomsToRemove = removeRoomMatch[1].split(",");
    for (const room of roomsToRemove) {
      const name = room.split(/[:=]/)[0].trim();
      if (ROOM_LIST.has(name)) { removeRoom(name); reply(`✅ Removed room: ${name}`); }
      else { reply(`❌ Room "${name}" not found`); }
    }
    return;
  }

  if (/^\|listroom/i.test(cmd)) {
    reply(`📋 Room List:\n${listRooms()}`);
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  FLOOD SYSTEM
  // ══════════════════════════════════════════════════════════

  const customFloodMatch = cmd.match(/^\|flood\s+(\d+)\s+(.+)/i);
  if (customFloodMatch) {
    const roomId = customFloodMatch[1];
    const floodText = customFloodMatch[2].trim();

    const floodTargets = isAllAccounts
      ? getAllSubAccounts()
      : targetAccounts.length > 0 ? targetAccounts : null;

    if (!floodTargets) {
      reply(`❌ Specify account: |flood ${roomId} <text> $username  or  $aa for all`);
      return;
    }
    if (floodTargets.length === 0) { reply(`❌ No sub-accounts logged in`); return; }

    for (const acc of floodTargets) {
      if (acc.startCustomFlood(roomId, floodText)) {
        reply(`🌊 CUSTOM FLOOD by @${acc.username}\nRoom: ${roomId} | Text: "${floodText}"`);
      }
    }
    if (isAllAccounts) reply(`🌊 Custom flood started on ${floodTargets.length} accounts`);
    return;
  }

  const autoFloodMatch = cmd.match(/^\|autoflood\s+(\d+)/i);
  if (autoFloodMatch) {
    const roomId = autoFloodMatch[1];

    const floodTargets = isAllAccounts
      ? getAllSubAccounts()
      : targetAccounts.length > 0 ? targetAccounts : null;

    if (!floodTargets) {
      reply(`❌ Specify account: |autoflood ${roomId} $username  or  $aa for all`);
      return;
    }
    if (floodTargets.length === 0) { reply(`❌ No sub-accounts logged in`); return; }

    let started = 0;
    for (const acc of floodTargets) {
      if (acc.startAutoFlood(roomId)) {
        reply(`🌊 AUTO FLOOD by @${acc.username}\nRoom: ${roomId} | ${acc.floodMessages.length} msgs from flood.txt`);
        started++;
      } else {
        reply(`❌ @${acc.username}: failed — check flood.txt`);
      }
    }
    if (isAllAccounts && started > 0) reply(`🌊 Auto flood started on ${started} accounts`);
    return;
  }

  if (/^\|flood\s+stop/i.test(cmd)) {
    const stopTargets = isAllAccounts
      ? getAllSubAccounts()
      : targetAccounts.length > 0 ? targetAccounts : [target];

    for (const acc of stopTargets) acc.stopFlood();
    const names = stopTargets.map((a) => `@${a.username}`).join(", ");
    reply(`🛑 FLOOD STOPPED: ${names}`);
    return;
  }

  if (/^\|flood\s+reload/i.test(cmd)) {
    const messages = loadFloodTexts();
    reply(`✅ Reloaded ${messages.length} messages from flood.txt`);
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  FRIENDS
  // ══════════════════════════════════════════════════════════

  // Send friend request: |sf <username> [$acc]
  const sendFriendMatch = cmd.match(/^\|sf\s+(\w+)/i);
  if (sendFriendMatch) {
    const r = await target.sendFriendRequest(sendFriendMatch[1]);
    const ok = r.status < 400;
    const msg = r.data?.message || r.data?.data?.message || JSON.stringify(r.data).slice(0, 80);
    reply(`${ok ? "✅" : "❌"} Friend request → @${sendFriendMatch[1]} from @${target.username}: ${msg}`);
    return;
  }

  // Accept friend request by ID: |af <request_id> [$acc]
  const acceptMatch = cmd.match(/^\|af\s+(\d+)/i);
  if (acceptMatch) {
    const r = await target.acceptFriendRequest(acceptMatch[1]);
    const ok = r.status < 400;
    const msg = r.data?.message || r.data?.data?.message || JSON.stringify(r.data).slice(0, 80);
    reply(`${ok ? "✅" : "❌"} Accepted request #${acceptMatch[1]} on @${target.username}: ${msg}`);
    return;
  }

  // Accept ALL pending friend requests: |aaf [$acc]
  if (/^\|aaf/i.test(cmd)) {
    const r = await target.getFriendRequests();
    const requests = Array.isArray(r.data) ? r.data : (r.data?.requests || r.data?.data || []);
    if (!requests.length) { reply(`📭 No pending requests on @${target.username}`); return; }
    reply(`⏳ Accepting ${requests.length} request(s) on @${target.username}...`);
    let accepted = 0, failed = 0;
    for (const rq of requests) {
      const rid = rq.id || rq.request_id;
      if (!rid) { failed++; continue; }
      const ar = await target.acceptFriendRequest(rid);
      if (ar.status < 400) { accepted++; }
      else { failed++; }
      // Small delay to avoid rate limiting
      await new Promise((res) => setTimeout(res, 300));
    }
    reply(`✅ @${target.username} — Accepted: ${accepted}, Failed: ${failed}`);
    return;
  }

  // List pending friend requests: |fr [$acc]
  if (/^\|fr\b/i.test(cmd)) {
    const r = await target.getFriendRequests();
    const requests = Array.isArray(r.data) ? r.data : (r.data?.requests || r.data?.data || []);
    if (!requests.length) { reply(`📭 No pending requests on @${target.username}`); return; }
    const list = requests.slice(0, 15)
      .map((rq) => `  ID:${rq.id || rq.request_id} from @${rq.username || rq.sender?.username || "?"}`)
      .join("\n");
    reply(`📬 Pending requests on @${target.username} (${requests.length}):\n${list}`);
    return;
  }

  // List friends: |fl [$acc]
  if (/^\|fl\b/i.test(cmd)) {
    const r = await target.getFriendsList();
    const friends = Array.isArray(r.data) ? r.data : (r.data?.friends || r.data?.data || []);
    if (!friends.length) { reply(`📭 @${target.username} has no friends listed`); return; }
    const list = friends.slice(0, 20)
      .map((f) => `  @${f.username || f.friend?.username || "?"}`)
      .join("\n");
    reply(`👥 Friends of @${target.username} (${friends.length}):\n${list}`);
    return;
  }

  // Balance: |balance [$acc]
  if (/^\|balance\b/i.test(cmd)) {
    const r = await target.getAccount();
    const b = r.data?.balance_cents ?? r.data?.data?.balance_cents ?? target.balance ?? "unknown";
    if (typeof b === "number") target.balance = b;
    reply(`💰 @${target.username}: ${b} coins`);
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  COIN TRANSFER
  //  |send <to_username> <amount> <pin> [$acc]
  //  |send faysal 100 333666 $firefox
  //
  //  |sendall <to_username> <amount> <pin>
  //    → sends from ALL sub-accounts (useful for collecting coins)
  //
  //  |pincheck [$acc]   → check if PIN is set on account
  // ══════════════════════════════════════════════════════════

  // PIN status check: |pincheck [$acc]
  if (/^\|pincheck\b/i.test(cmd)) {
    const r = await target.getPinStatus();
    const hasPin = r.data?.has_pin ?? r.data?.data?.has_pin ?? r.data?.pin_set ?? "unknown";
    reply(`🔐 @${target.username} PIN status: ${hasPin === true ? "✅ PIN is set" : hasPin === false ? "❌ No PIN set" : JSON.stringify(r.data).slice(0, 80)}`);
    return;
  }

  // Transfer coins: |send <to> <amount> <pin> [$acc]
  const sendCoinsMatch = cmd.match(/^\|send\s+(\w+)\s+(\d+)\s+(\S+)/i);
  if (sendCoinsMatch) {
    const [, toUser, amount, pin] = sendCoinsMatch;

    if (isAllAccounts) {
      // |send faysal 100 333666 $aa  → all sub-accounts each send
      const subAccs = getAllSubAccounts();
      if (subAccs.length === 0) { reply(`❌ No sub-accounts logged in`); return; }
      reply(`⏳ Sending ${amount} coins → @${toUser} from ${subAccs.length} accounts...`);
      let ok = 0, fail = 0;
      for (const acc of subAccs) {
        const r = await acc.transferCoins(toUser, amount, pin);
        if (r.status < 400) {
          ok++;
          const msg = r.data?.message || r.data?.data?.message || "OK";
          reply(`  ✅ @${acc.username} → @${toUser} (${amount} coins): ${msg}`);
        } else {
          fail++;
          const msg = r.data?.message || r.data?.data?.message || r.data?.error || JSON.stringify(r.data).slice(0, 80);
          reply(`  ❌ @${acc.username} failed: ${msg}`);
        }
        await new Promise((res) => setTimeout(res, 400));
      }
      reply(`📊 Transfer done: ${ok} success, ${fail} failed`);
    } else {
      // Single account transfer
      reply(`⏳ Sending ${amount} coins from @${target.username} → @${toUser}...`);
      const r = await target.transferCoins(toUser, amount, pin);
      if (r.status < 400) {
        const msg = r.data?.message || r.data?.data?.message || "Transfer successful";
        const newBal = r.data?.balance_cents ?? r.data?.data?.balance_cents;
        let replyMsg = `✅ @${target.username} → @${toUser}: ${amount} coins sent!\n  ${msg}`;
        if (newBal !== undefined) replyMsg += `\n  New balance: ${newBal} coins`;
        reply(replyMsg);
      } else {
        const msg = r.data?.message || r.data?.data?.message || r.data?.error || JSON.stringify(r.data).slice(0, 120);
        reply(`❌ Transfer failed from @${target.username}: ${msg}`);
      }
    }
    return;
  }

  // Collect all coins to one account: |collect <to_username> <amount_each> <pin>
  // Shorthand for sending from all sub-accounts to a single destination
  const collectMatch = cmd.match(/^\|collect\s+(\w+)\s+(\d+)\s+(\S+)/i);
  if (collectMatch) {
    if (!isFullParent) { reply(`❌ Only full parents can use |collect`); return; }
    const [, toUser, amount, pin] = collectMatch;
    const subAccs = getAllSubAccounts();
    if (subAccs.length === 0) { reply(`❌ No sub-accounts logged in`); return; }
    reply(`⏳ Collecting ${amount} coins each from ${subAccs.length} sub-accounts → @${toUser}...`);
    let ok = 0, fail = 0, totalSent = 0;
    for (const acc of subAccs) {
      const r = await acc.transferCoins(toUser, amount, pin);
      if (r.status < 400) {
        ok++;
        totalSent += Number(amount);
        const msg = r.data?.message || r.data?.data?.message || "OK";
        reply(`  ✅ @${acc.username} → ${amount} coins: ${msg}`);
      } else {
        fail++;
        const msg = r.data?.message || r.data?.data?.message || r.data?.error || JSON.stringify(r.data).slice(0, 80);
        reply(`  ❌ @${acc.username}: ${msg}`);
      }
      await new Promise((res) => setTimeout(res, 400));
    }
    reply(`📊 Collect done: ${ok} success, ${fail} failed\n  Total sent: ${totalSent} coins → @${toUser}`);
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  VOTE
  //  |vote <username> [$acc]       → vote for a user
  //  |vote <username> $aa          → all sub-accounts vote
  // ══════════════════════════════════════════════════════════

  const voteMatch = cmd.match(/^\|vote\s+(\w+)/i);
  if (voteMatch) {
    const voteTarget = voteMatch[1];

    const voters = isAllAccounts
      ? getAllSubAccounts()
      : targetAccounts.length > 0 ? targetAccounts : [target];

    if (voters.length === 0) { reply(`❌ No accounts available`); return; }

    if (voters.length === 1) {
      const r = await voters[0].voteUser(voteTarget);
      const ok = r.status < 400;
      const msg = r.data?.message || r.data?.data?.message || JSON.stringify(r.data).slice(0, 80);
      reply(`${ok ? "✅" : "❌"} @${voters[0].username} voted for @${voteTarget}: ${msg}`);
    } else {
      reply(`⏳ Voting for @${voteTarget} from ${voters.length} accounts...`);
      let ok = 0, fail = 0;
      for (const acc of voters) {
        const r = await acc.voteUser(voteTarget);
        if (r.status < 400) {
          ok++;
          const msg = r.data?.message || r.data?.data?.message || "OK";
          reply(`  ✅ @${acc.username}: ${msg}`);
        } else {
          fail++;
          const msg = r.data?.message || r.data?.data?.message || r.data?.error || JSON.stringify(r.data).slice(0, 60);
          reply(`  ❌ @${acc.username}: ${msg}`);
        }
        await new Promise((res) => setTimeout(res, 300));
      }
      reply(`📊 Vote done: ${ok} success, ${fail} failed`);
    }
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  EMAIL
  //  |email @<to> #<subject> *<body> [$acc]
  //  Example: |email @faysal #Hello *How are you? $firefox
  //
  //  |inbox [$acc]         → show inbox (page 1)
  //  |inbox 2 [$acc]       → show inbox page 2
  // ══════════════════════════════════════════════════════════

  // Send email: |email @username #subject *body
  const emailMatch = cmd.match(/^\|email\s+@(\w+)\s+#([^*]+)\s*\*(.+)/i);
  if (emailMatch) {
    const [, toUser, subject, body] = emailMatch;
    const emailBody = body.trim();
    const emailSubject = subject.trim();

    const senders = isAllAccounts
      ? getAllSubAccounts()
      : targetAccounts.length > 0 ? targetAccounts : [target];

    if (senders.length === 1) {
      const r = await senders[0].sendEmail(toUser, emailSubject, emailBody);
      const ok = r.status < 400;
      const msg = r.data?.message || r.data?.data?.message || JSON.stringify(r.data).slice(0, 80);
      reply(`${ok ? "✅" : "❌"} Email from @${senders[0].username} → @${toUser}: ${msg}`);
    } else {
      reply(`⏳ Sending email to @${toUser} from ${senders.length} accounts...`);
      let ok = 0, fail = 0;
      for (const acc of senders) {
        const r = await acc.sendEmail(toUser, emailSubject, emailBody);
        if (r.status < 400) { ok++; reply(`  ✅ @${acc.username}: sent`); }
        else {
          fail++;
          const msg = r.data?.message || r.data?.data?.message || JSON.stringify(r.data).slice(0, 60);
          reply(`  ❌ @${acc.username}: ${msg}`);
        }
        await new Promise((res) => setTimeout(res, 300));
      }
      reply(`📊 Email sent: ${ok} success, ${fail} failed`);
    }
    return;
  }

  // Read inbox: |inbox [page] [$acc]
  const inboxMatch = cmd.match(/^\|inbox(?:\s+(\d+))?/i);
  if (inboxMatch) {
    const page = Number(inboxMatch[1] || 1);
    const r = await target.getInbox("all", page);
    const emails = r.data?.emails || r.data?.data?.emails || r.data?.data || r.data || [];
    const list = Array.isArray(emails) ? emails : [];
    if (!list.length) { reply(`📭 Inbox empty (page ${page}) for @${target.username}`); return; }
    const lines = list.slice(0, 10).map((e, i) => {
      const from = e.from_username || e.sender?.username || e.from || "?";
      const subj = e.subject || "(no subject)";
      const date = e.created_at ? new Date(e.created_at).toLocaleDateString() : "";
      return `  ${i + 1}. From:@${from} | ${subj} ${date ? `| ${date}` : ""}`;
    }).join("\n");
    reply(`📬 Inbox @${target.username} (page ${page}):\n${lines}`);
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  REGISTRATION & ACTIVATION
  //  Register:  |reg <username> <email> <password> [gender] [country]
  //  Syntax:    |reg myuser myuser@email.com mypass123
  //             |reg myuser myuser@email.com mypass123 female Bangladesh
  //
  //  Activate:  |act <activation_code>
  //  Syntax:    |act 0ADF82
  //
  //  After activation, use |lnu username:password to login the new account
  //
  //  Daily XP:  |daily [$acc]     → claim daily login XP bonus
  //             |daily $aa        → all sub-accounts claim
  // ══════════════════════════════════════════════════════════

  // Register: |reg <username> <email> <password> [gender] [country]
  const regMatch = cmd.match(/^\|reg\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(male|female))?(?:\s+(.+))?/i);
  if (regMatch) {
    if (!isFullParent) { reply(`❌ Only full parents can register accounts`); return; }
    const [, regUser, regEmail, regPass, regGender = "male", regCountry = "Bangladesh"] = regMatch;

    reply(`⏳ Registering @${regUser} (${regEmail})...`);
    const r = await callerAccount.registerAccount(
      regUser, regEmail, regPass,
      regGender.toLowerCase(),
      regCountry.trim()
    );

    const ok = r.status < 400;
    const msg = r.data?.message || r.data?.data?.message || r.data?.error || JSON.stringify(r.data).slice(0, 120);

    if (ok) {
      reply(
        `✅ Registered @${regUser}!\n` +
        `  Email: ${regEmail}\n` +
        `  Password: ${regPass}\n` +
        `  ${msg}\n\n` +
        `📧 Check email for activation code, then use:\n` +
        `  |act <code>\n` +
        `Then login with:\n` +
        `  |lnu ${regUser}:${regPass}`
      );
    } else {
      reply(`❌ Registration failed for @${regUser}: ${msg}`);
    }
    return;
  }

  // Activate account: |act <code>
  const actMatch = cmd.match(/^\|act\s+(\S+)/i);
  if (actMatch) {
    if (!isFullParent) { reply(`❌ Only full parents can activate accounts`); return; }
    const activationCode = actMatch[1].trim();

    reply(`⏳ Activating with code: ${activationCode}...`);
    const r = await callerAccount.activateAccount(activationCode);

    const ok = r.status < 400;
    const msg = r.data?.message || r.data?.data?.message || r.data?.error || JSON.stringify(r.data).slice(0, 120);
    reply(`${ok ? "✅" : "❌"} Activation [${activationCode}]: ${msg}`);
    return;
  }

  // Daily XP claim: |daily [$acc or $aa]
  if (/^\|daily/i.test(cmd)) {
    const dailyTargets = isAllAccounts
      ? getAllSubAccounts()
      : targetAccounts.length > 0 ? targetAccounts : [target];

    if (dailyTargets.length === 1) {
      const r = await dailyTargets[0].claimDailyLogin();
      const ok = r.status < 400;
      const msg = r.data?.message || r.data?.data?.message || r.data?.xp || JSON.stringify(r.data).slice(0, 80);
      reply(`${ok ? "✅" : "❌"} Daily XP @${dailyTargets[0].username}: ${msg}`);
    } else {
      reply(`⏳ Claiming daily XP for ${dailyTargets.length} accounts...`);
      let ok = 0, fail = 0;
      for (const acc of dailyTargets) {
        const r = await acc.claimDailyLogin();
        if (r.status < 400) {
          ok++;
          const msg = r.data?.message || r.data?.data?.message || "OK";
          reply(`  ✅ @${acc.username}: ${msg}`);
        } else {
          fail++;
          const msg = r.data?.message || r.data?.data?.message || JSON.stringify(r.data).slice(0, 60);
          reply(`  ❌ @${acc.username}: ${msg}`);
        }
        await new Promise((res) => setTimeout(res, 300));
      }
      reply(`📊 Daily XP: ${ok} claimed, ${fail} failed`);
    }
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  FEATURE TOGGLES
  // ══════════════════════════════════════════════════════════

  if (/^\|vp\s+on/i.test(cmd)) { target.voucherOn = true; reply(`✅ Voucher ON for @${target.username} 🎁`); return; }
  if (/^\|vp\s+off/i.test(cmd)) { target.voucherOn = false; reply(`⛔ Voucher OFF for @${target.username}`); return; }

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
      reply(`✅ @${target.username} → Auto-welcome ON (all rooms) 👋`);
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

  if (/^\|ar\s+on/i.test(cmd)) { target.autoReplyOn = true; reply(`✅ Auto-reply ON for @${target.username} 💬`); return; }
  if (/^\|ar\s+off/i.test(cmd)) { target.autoReplyOn = false; reply(`⛔ Auto-reply OFF for @${target.username}`); return; }

  // ══════════════════════════════════════════════════════════
  //  AUTO-TEXT SYSTEM
  // ══════════════════════════════════════════════════════════

  const atOnMatch = cmd.match(/^\|at\s+on(?:\s+(\d+))?/i);
  if (atOnMatch) {
    const roomId = atOnMatch[1];
    if (!target.autoTextMessages.length) target.autoTextMessages = loadAutoTexts();
    if (!target.autoTextMessages.length) { reply(`❌ No messages in at.txt`); return; }
    if (!roomId) { reply(`❌ Specify room: |at on <room_id>`); return; }
    target.autoTextRooms.add(Number(roomId));
    target.autoTextOn = true;
    if (target.isConnected) { target.stopAutoText(); target.startAutoText(); }
    reply(`✅ @${target.username} → Auto-text ON for room ${roomId}\n${target.autoTextMessages.length} messages, interval: ${target.autoTextInterval}m`);
    return;
  }

  const atOffMatch = cmd.match(/^\|at\s+off(?:\s+(\d+))?/i);
  if (atOffMatch) {
    const roomId = atOffMatch[1];
    if (roomId) {
      target.autoTextRooms.delete(Number(roomId));
      if (target.autoTextRooms.size === 0) { target.autoTextOn = false; target.stopAutoText(); }
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
    if (minutes < 1) { reply(`❌ Interval must be ≥1 minute`); return; }
    target.setAutoTextInterval(minutes);
    reply(`✅ @${target.username} → Auto-text interval: ${minutes}m`);
    return;
  }

  if (/^\|at\s+reload/i.test(cmd)) {
    target.autoTextMessages = loadAutoTexts();
    target.autoTextIndex.clear();
    if (target.autoTextOn && target.isConnected) { target.stopAutoText(); target.startAutoText(); }
    reply(`✅ Reloaded ${target.autoTextMessages.length} messages from at.txt`);
    return;
  }

  if (/^\|at\s+status/i.test(cmd)) {
    if (!target.autoTextOn) { reply(`📝 Auto-text OFF for @${target.username}`); return; }
    const lines = [
      `📝 Auto-text @${target.username}:`,
      `  Messages: ${target.autoTextMessages.length}`,
      `  Interval: ${target.autoTextInterval}m`,
      `  Rooms: ${[...target.autoTextRooms].join(", ")}`,
    ];
    for (const rid of target.autoTextRooms) {
      const curr = target.autoTextIndex.get(rid) || 0;
      lines.push(`  Room ${rid}: ${curr + 1}/${target.autoTextMessages.length}`);
    }
    reply(lines.join("\n"));
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  PARENT MANAGEMENT (full parents only — already guarded above)
  // ══════════════════════════════════════════════════════════

  const addSubParentMatch = cmd.match(/^\|asp\s+(\w+)/i);
  if (addSubParentMatch && isFullParent) {
    SUB_PARENT_USERS.add(addSubParentMatch[1].toLowerCase());
    reply(`✅ @${addSubParentMatch[1]} added as sub-parent`);
    return;
  }

  const remSubParentMatch = cmd.match(/^\|rsp\s+(\w+)/i);
  if (remSubParentMatch && isFullParent) {
    SUB_PARENT_USERS.delete(remSubParentMatch[1].toLowerCase());
    reply(`✅ @${remSubParentMatch[1]} removed from sub-parents`);
    return;
  }

  const addPMatch = cmd.match(/^\|ap\s+(\w+)/i);
  if (addPMatch && isFullParent) {
    PARENT_USERS.add(addPMatch[1].toLowerCase());
    reply(`✅ @${addPMatch[1]} added as parent`);
    return;
  }

  const remPMatch = cmd.match(/^\|rp\s+(\w+)/i);
  if (remPMatch && isFullParent) {
    PARENT_USERS.delete(remPMatch[1].toLowerCase());
    reply(`✅ @${remPMatch[1]} removed from parents`);
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  STATUS & HELP
  // ══════════════════════════════════════════════════════════

  if (/^\|status/i.test(cmd)) {
    const motherAcc = accounts.get((USERNAME || "").toLowerCase());
    const parents = [...PARENT_USERS].join(", ");
    const subParents = [...SUB_PARENT_USERS].join(", ") || "none";
    const motherStatus = motherAcc ? motherAcc.statusText() : `👑 @${USERNAME} (not found)`;
    const subStatus = [...accounts.values()]
      .filter((a) => !isMother(a.username))
      .map((a) => a.statusText())
      .join("\n\n");

    let statusMsg = `📊 Bot Status\n`;
    statusMsg += `Mother : @${USERNAME}\n`;
    statusMsg += `Parents: [${parents}]\n`;
    statusMsg += `Sub-Parents: [${subParents}]\n\n`;
    statusMsg += `${motherStatus}`;
    if (subStatus) statusMsg += `\n\n${subStatus}`;
    reply(statusMsg);
    return;
  }

  if (/^\|help/i.test(cmd)) {
    let helpText = `📖 Commands\n`;
    helpText += `  $aa = all sub-accounts (not mother)\n`;
    helpText += `  $name = specific account\n\n`;

    helpText += `👥 Accounts (parent only):\n`;
    helpText += `  |lnu user:pass\n`;
    helpText += `  |lnu u1:p1;u2:p2  (multi)\n`;
    helpText += `  |ltu user\n`;
    helpText += `  |accounts\n\n`;

    helpText += `🔑 Token / Session:\n`;
    helpText += `  |tokeninfo [$acc]    → expiry time + refresh schedule\n`;
    helpText += `  |refresh [$acc]      → force token refresh now\n`;
    helpText += `  |setpass <pwd> [$acc]→ store password for auto-refresh\n`;
    helpText += `  (tokens auto-refresh 1h before expiry if password stored)\n\n`;

    helpText += `🏠 Rooms:\n`;
    helpText += `  |jr <id> $aa         → all sub-accs join\n`;
    helpText += `  |jr <id> $acc        → specific acc joins\n`;
    helpText += `  |lr <id> $aa         → all sub-accs leave\n`;
    helpText += `  |lr all $acc\n`;
    helpText += `  |tr <id> <msg> $acc\n`;
    helpText += `  |addroom Name=ID\n`;
    helpText += `  |removeroom Name\n`;
    helpText += `  |listroom\n\n`;

    helpText += `🌊 Flood:\n`;
    helpText += `  |flood <room> <text> $aa\n`;
    helpText += `  |flood <room> <text> $acc\n`;
    helpText += `  |autoflood <room> $aa\n`;
    helpText += `  |autoflood <room> $acc\n`;
    helpText += `  |flood stop $aa\n`;
    helpText += `  |flood stop $acc\n`;
    helpText += `  |flood reload\n\n`;

    helpText += `📝 Auto-Text (at.txt):\n`;
    helpText += `  |at on <room_id> $acc\n`;
    helpText += `  |at off [room_id] $acc\n`;
    helpText += `  |at interval <min> $acc\n`;
    helpText += `  |at reload $acc\n`;
    helpText += `  |at status $acc\n\n`;

    helpText += `👋 Auto-welcome:\n`;
    helpText += `  |aw on [room_id] $acc\n`;
    helpText += `  |aw off [room_id] $acc\n`;
    helpText += `  |aw_msg <text>  (use {username})\n`;
    helpText += `  |aw_msg #<room_id> <text>\n\n`;

    helpText += `💬 Auto-reply:\n`;
    helpText += `  |ar on/off $acc\n\n`;

    helpText += `🎁 Voucher:\n`;
    helpText += `  |vp on/off $acc\n\n`;

    helpText += `👫 Friends:\n`;
    helpText += `  |sf <user> [$acc]     → send friend request\n`;
    helpText += `  |af <id> [$acc]       → accept by request ID\n`;
    helpText += `  |aaf [$acc]           → accept ALL pending\n`;
    helpText += `  |fr [$acc]            → list pending requests\n`;
    helpText += `  |fl [$acc]            → list friends\n`;
    helpText += `  |balance [$acc]       → show balance\n`;
    helpText += `  |pincheck [$acc]      → check if PIN is set\n\n`;

    helpText += `💸 Coin Transfer:\n`;
    helpText += `  |send <to> <amt> <pin> [$acc]   → single acc send\n`;
    helpText += `  |send <to> <amt> <pin> $aa      → all sub-accs send\n`;
    helpText += `  |collect <to> <amt> <pin>        → all sub-accs → one dest\n\n`;

    helpText += `🗳️ Vote:\n`;
    helpText += `  |vote <username> [$acc]          → vote for a user\n`;
    helpText += `  |vote <username> $aa             → all sub-accs vote\n\n`;

    helpText += `📧 Email:\n`;
    helpText += `  |email @<to> #<subject> *<body> [$acc]\n`;
    helpText += `  Example: |email @faysal #Hi *Hello there $firefox\n`;
    helpText += `  |inbox [page] [$acc]             → read inbox\n\n`;

    if (isFullParent) {
      helpText += `📝 Registration (parent only):\n`;
      helpText += `  |reg <user> <email> <pass> [gender] [country]\n`;
      helpText += `  Example: |reg myuser me@email.com pass123\n`;
      helpText += `  Example: |reg myuser me@email.com pass123 female India\n`;
      helpText += `  |act <code>                    → activate with email code\n\n`;

      helpText += `⚙️ Parent Only:\n`;
      helpText += `  |ap <user>  |rp <user>\n`;
      helpText += `  |asp <user>  |rsp <user>\n\n`;
    }

    helpText += `🎯 Daily XP:\n`;
    helpText += `  |daily [$acc or $aa]             → claim daily login bonus\n\n`;

    helpText += `📊 Info:\n`;
    helpText += `  |status  |help\n\n`;

    helpText += `🔒 Access:\n`;
    helpText += `  Parents     → PM + Room commands\n`;
    helpText += `  Sub-parents → PM only\n`;
    helpText += `  $aa         → parents only, skips mother\n\n`;

    helpText += `🤖 AI: /a <question>  (PM or room)`;
    reply(helpText);
    return;
  }

  reply(`❓ Unknown command. Send "|help" for the full list.`);
}

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  if (!USERNAME) { console.error("❌ MIG66_USERNAME missing"); process.exit(1); }
  if (!TOKEN && !PASSWORD) { console.error("❌ MIG66_TOKEN or MIG66_PASSWORD missing"); process.exit(1); }

  // BUG FIX: MISTRAL_API_KEY missing is now a WARNING only, not a fatal error.
  // The bot can still run without AI — commands still work.
  if (AI_PROVIDER === "mistral" && !process.env.MISTRAL_API_KEY) {
    console.warn("⚠️  MISTRAL_API_KEY not set — AI replies will be disabled. Bot will still run.");
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  mig66 AI Bot  ✅ Full Edition v4.4");
  console.log(`  Mother      : ${USERNAME}`);
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
