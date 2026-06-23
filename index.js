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
  ["Savages", 46],
  ["Bangladeshi", 20],
  ["Kolkata", 238],
  ["Faysal", 228],
  ["Buy Sell", 288],
  ["Coin Bazar", 305],
  ["Coins Sell group", 306],
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
        this.log(`❌ Login failed (${resp.status}): ${JSON.stringify(data).slice(0, 100)}`);
        return false;
      }

      const p = JSON.parse(Buffer.from(this.token.split(".")[1], "base64").toString());
      this.userId = String(p.id || "");
      this.log(`✓ Logged in — ID: ${this.userId}`);

      if (this.isMain) {
        saveTokenToEnv(this.token);
        TOKEN = this.token;
      }

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
  let cmd = content.trim();
  const isFullParent = isParent(senderName);
  const isSubP = isSubParent(senderName);

  // Sub-parents can only use PM
  if (isSubP && !isFullParent && source === "room") return;

  console.log(`\n[${isFullParent ? "👑 PARENT" : "👤 SUB-PARENT"}][${source.toUpperCase()}] @${senderName} → "${cmd}"`);

  // ── Reply helper: PM back the sender always ───────────────
  const reply = (text) => callerAccount.sendPrivate(senderName, text);

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
        // $aa = all sub-accounts
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

  // ── PARENT-ONLY command guard ─────────────────────────────
  const parentOnlyPattern = /^\|(ap|rp|asp|rsp|lnu|ltu)\b/i;
  if (parentOnlyPattern.test(cmd) && !isFullParent) {
    reply(`❌ Permission denied. Only full parents can use this command.`);
    return;
  }

  // ── $aa guard for sensitive commands ─────────────────────
  //  sub-parents cannot use $aa for flood/room join/leave
  const aaRestrictedPattern = /^\|(jr|lr|flood|autoflood)\b/i;
  if (isAllAccounts && aaRestrictedPattern.test(cmd) && !isFullParent) {
    reply(`❌ Sub-parents cannot use $aa with this command. Only full parents can.`);
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  ACCOUNT MANAGEMENT  (parent only)
  // ══════════════════════════════════════════════════════════

  const multiLoginMatch = cmd.match(/^\|lnu\s+(.+)/i);
  if (multiLoginMatch) {
    const rawInput = multiLoginMatch[1].trim();
    const credentials = rawInput.split(";").map((s) => s.trim()).filter(Boolean);
    let successCount = 0, failCount = 0;

    for (const cred of credentials) {
      // Split only on the FIRST colon — passwords may contain colons
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
  //  |jr <id> $aa  →  all sub-accounts join (not mother)
  //  |jr <id> $acc →  specific account joins
  //  |lr <id> $aa  →  all sub-accounts that are in that room leave
  // ══════════════════════════════════════════════════════════

  const joinMatch = cmd.match(/^\|jr\s+(\d+)/i);
  if (joinMatch) {
    const roomId = joinMatch[1];
    if (isAllAccounts) {
      // $aa: all sub-accounts join, skip mother
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
      // $aa: only accounts that are actually in that room leave
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
  //  |flood <room> <text> $aa  → all sub-accounts flood
  //  |autoflood <room> $aa     → all sub-accounts auto-flood
  //  |flood stop $aa           → stop all sub-account floods
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

  const sendFriendMatch = cmd.match(/^\|sf\s+(\w+)/i);
  if (sendFriendMatch) {
    const r = await target.sendFriendRequest(sendFriendMatch[1]);
    reply(`${r.status < 400 ? "✅" : "❌"} Friend request to @${sendFriendMatch[1]} from @${target.username}: ${JSON.stringify(r.data).slice(0, 80)}`);
    return;
  }

  const acceptMatch = cmd.match(/^\|af\s+(\d+)/i);
  if (acceptMatch) {
    const r = await target.acceptFriendRequest(acceptMatch[1]);
    reply(`${r.status < 400 ? "✅" : "❌"} Accepted #${acceptMatch[1]} on @${target.username}: ${JSON.stringify(r.data).slice(0, 80)}`);
    return;
  }

  if (/^\|fr/i.test(cmd)) {
    const r = await target.getFriendRequests();
    const requests = Array.isArray(r.data) ? r.data : (r.data?.requests || r.data?.data || []);
    if (!requests.length) { reply(`📭 No pending requests on @${target.username}`); return; }
    const list = requests.slice(0, 10)
      .map((rq) => `  ID:${rq.id || rq.request_id} from @${rq.username || rq.sender?.username || "?"}`)
      .join("\n");
    reply(`📬 Requests on @${target.username} (${requests.length}):\n${list}`);
    return;
  }

  if (/^\|balance/i.test(cmd)) {
    if (target.balance !== null) { reply(`💰 @${target.username}: ${target.balance} cents`); return; }
    const r = await target.api("GET", "/api/profile/me");
    const b = r.data?.balance_cents || r.data?.data?.balance_cents || "unknown";
    reply(`💰 @${target.username}: ${b} cents`);
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
  //  PARENT MANAGEMENT (full parents only)
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
    helpText += `  |lnu user:pass  or  |lnu u1:p1;u2:p2\n`;
    helpText += `  |ltu user\n`;
    helpText += `  |accounts\n\n`;

    helpText += `🏠 Rooms:\n`;
    helpText += `  |jr <id> $aa         → all sub-accs join\n`;
    helpText += `  |jr <id> $acc        → specific acc joins\n`;
    helpText += `  |lr <id> $aa         → all sub-accs in that room leave\n`;
    helpText += `  |lr all $acc\n`;
    helpText += `  |tr <id> <msg> $acc\n`;
    helpText += `  |addroom Name=ID\n`;
    helpText += `  |removeroom Name\n`;
    helpText += `  |listroom\n\n`;

    helpText += `🌊 Flood:\n`;
    helpText += `  |flood <room> <text> $aa     → all sub-accs\n`;
    helpText += `  |flood <room> <text> $acc    → specific acc\n`;
    helpText += `  |autoflood <room> $aa        → all sub-accs\n`;
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
    helpText += `  |sf <user> $acc  |af <id> $acc\n`;
    helpText += `  |fr $acc  |balance $acc\n\n`;

    if (isFullParent) {
      helpText += `⚙️ Parent Only:\n`;
      helpText += `  |ap <user>  |rp <user>\n`;
      helpText += `  |asp <user>  |rsp <user>\n\n`;
    }

    helpText += `📊 Info:\n`;
    helpText += `  |status  |help\n\n`;

    helpText += `🔒 Access:\n`;
    helpText += `  Parents   → PM + Room commands\n`;
    helpText += `  Sub-parents → PM only\n`;
    helpText += `  $aa       → parents only, skips mother\n\n`;

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
  if (AI_PROVIDER === "mistral" && !process.env.MISTRAL_API_KEY) {
    console.error("❌ MISTRAL_API_KEY missing"); process.exit(1);
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  mig66 AI Bot  ✅ Full Edition v4.0");
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
