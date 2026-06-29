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
  res.json({ status: "online", bot: process.env.MIG66_USERNAME, uptime: process.uptime() });
});
app.get("/health", (req, res) => res.status(200).send("OK"));
app.listen(PORT, "0.0.0.0", () => console.log(`🌐 Web service listening on port ${PORT}`));

// ══════════════════════════════════════════════════════════════
//  CONFIGURATION
// ══════════════════════════════════════════════════════════════
const API_BASE  = process.env.API_BASE || "https://dashboard.mig66.com";
const USERNAME  = process.env.MIG66_USERNAME;   // Mother account
const PASSWORD  = process.env.MIG66_PASSWORD;
let   TOKEN     = process.env.MIG66_TOKEN;
const ROOM_ID   = parseInt(process.env.MIG66_ROOM_ID || "50");
const TRIGGER   = (process.env.TRIGGER_KEYWORD || `@${USERNAME}`).toLowerCase();
const AW_MESSAGE = process.env.AW_MESSAGE || "Wc {username} 🎉 Welcome!";
const AI_PROVIDER = process.env.AI_PROVIDER || "mistral";
const DEBUG     = process.env.DEBUG === "true";

// ── Parent / Sub-parent sets ──────────────────────────────────
const PARENT_USERS = new Set(
  (process.env.PARENT_USERNAMES || process.env.PARENT_USERNAME || "faysal")
    .split(",").map(u => u.trim().toLowerCase()).filter(Boolean)
);
const SUB_PARENT_USERS = new Set(
  (process.env.SUB_PARENT_USERNAMES || "")
    .split(",").map(u => u.trim().toLowerCase()).filter(Boolean)
);

function isMother(u)    { return (u||"").toLowerCase() === (USERNAME||"").toLowerCase(); }
function isParent(u)    { return PARENT_USERS.has((u||"").toLowerCase()); }
function isSubParent(u) { return SUB_PARENT_USERS.has((u||"").toLowerCase()); }
function isAuthorized(u){ return isParent(u) || isSubParent(u); }

// ── Room list ─────────────────────────────────────────────────
const ROOM_LIST = new Map([
  ["Dhaka",50],["Bangladesh",1],["India",2],["Nepal",3],
  ["Philippine",4],["Indonesia",5],["Savages",46],["Bangladeshi",20],
  ["Kolkata",238],["Faysal",228],["Buy Sell",288],
  ["Coin Bazar",305],["Coins Sell group",306],
]);
const addRoom    = (n,id) => ROOM_LIST.set(n.trim(), Number(id));
const removeRoom = (n)    => ROOM_LIST.delete(n.trim());
const listRooms  = ()     => [...ROOM_LIST.entries()].map(([n,id])=>`${n}=${id}`).join(", ");

// ══════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════
function formatUptime(sec) {
  return `${Math.floor(sec/3600)}h ${Math.floor((sec%3600)/60)}m ${Math.floor(sec%60)}s`;
}

function saveTokenToEnv(tok) {
  try {
    const p = path.join(__dirname, ".env");
    let c = fs.existsSync(p) ? fs.readFileSync(p,"utf8") : "";
    c = c.includes("MIG66_TOKEN=")
      ? c.replace(/MIG66_TOKEN=.*/g, `MIG66_TOKEN=${tok}`)
      : c + `\nMIG66_TOKEN=${tok}`;
    fs.writeFileSync(p, c, "utf8");
    console.log(`[.env] ✅ Token saved`);
  } catch(e) { console.error(`[.env] ❌ ${e.message}`); }
}

function loadLines(file) {
  try {
    const p = path.join(__dirname, file);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p,"utf8").split("\n")
      .map(l=>l.trim()).filter(l=>l && !l.startsWith("#"));
  } catch(e) { console.error(`[${file}] load error: ${e.message}`); return []; }
}

// ── AI (Mistral) ──────────────────────────────────────────────
async function getAIReply(question) {
  const KEY = process.env.MISTRAL_API_KEY;
  const URL = process.env.MISTRAL_API_URL || "https://api.mistral.ai/v1/chat/completions";
  if (!KEY) return "AI not configured. Set MISTRAL_API_KEY in .env";
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type":"application/json", Authorization:`Bearer ${KEY}` },
      body: JSON.stringify({
        model: "mistral-tiny",
        messages: [{ role:"user", content:question }],
        max_tokens: 150, temperature: 0.7,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    return d.choices?.[0]?.message?.content || "No response.";
  } catch(e) {
    console.error("[AI]", e.message);
    return "Sorry, AI unavailable right now.";
  }
}

// ══════════════════════════════════════════════════════════════
//  BOT ACCOUNT CLASS
// ══════════════════════════════════════════════════════════════
class BotAccount {
  constructor({ username, password, token, isMain=false }) {
    this.username = username;
    this.password = password;
    this.token    = token || null;
    this.isMain   = isMain;
    this.userId   = null;
    this.socket   = null;
    this.joinedRooms = new Set();

    // Toggles
    this.voucherOn   = true;
    this.awOn        = false;
    this.autoReplyOn = false;
    this.awTemplate  = AW_MESSAGE;
    this.awRooms     = new Set();
    this.awMessages  = new Map();

    // Auto-text
    this.autoTextOn       = false;
    this.autoTextRooms    = new Set();
    this.autoTextMessages = [];
    this.autoTextIndex    = new Map();
    this.autoTextInterval = 5;
    this.autoTextTimer    = null;

    // Flood
    this.floodActive      = false;
    this.floodRoomId      = null;
    this.floodMessages    = [];
    this.floodIndex       = 0;
    this.floodInterval    = null;
    this.floodMode        = "custom";
    this.floodCustomText  = "";
    this.floodMessageCount= 0;

    this.balance     = null;
    this.isConnected = false;
    this.reconnTimer = null;
    this.processed   = new Set();
    this.startTime   = Date.now();

    // LowCard Bot auto-play system
    // lcbRooms: Set of room IDs where LCB auto-play is enabled
    this.lcbRooms      = new Set();
    // lcbState: per-room game state  { phase, round, players, entryCost, joinedGame, drawnThisRound }
    this.lcbState      = new Map();
    // lcbJoinTimer: per-room setTimeout handle for delayed !j send
    this.lcbJoinTimer  = new Map();
  }

  log(msg) { console.log(`[${this.username}] ${msg}`); }

  // ── Login ─────────────────────────────────────────────────
  async login() {
    // Try existing token first
    if (this.token && !this.isTokenExpired()) {
      try {
        const p = JSON.parse(Buffer.from(this.token.split(".")[1], "base64").toString());
        this.userId = String(p.id || "");
        this.log(`✓ Token OK — user:${p.username} id:${this.userId} exp:${new Date(p.exp*1000).toLocaleString()}`);
        return true;
      } catch(e) { this.log(`! Token decode: ${e.message}`); }
    }

    if (!this.password) {
      this.log("❌ No password and no valid token");
      return false;
    }

    this.log(`Logging in as ${this.username}...`);
    try {
      const resp = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type":    "application/json",
          "Origin":          "https://web.mig66.com",
          "Referer":         "https://web.mig66.com/",
          "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept":          "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "sec-fetch-dest":  "empty",
          "sec-fetch-mode":  "cors",
          "sec-fetch-site":  "same-site",
        },
        body: JSON.stringify({
          username:     this.username,
          password:     this.password,
          remember_me:  true,
          login_offline:false,
          device_info:  "Flutter Web",
        }),
      });

      // Read raw text first so we can log it on failure
      const raw = await resp.text();
      let data;
      try { data = JSON.parse(raw); }
      catch { data = {}; }

      // Token can live at multiple paths depending on API version
      const tok = data?.token
               || data?.data?.token
               || data?.access_token
               || data?.data?.access_token
               || null;

      if (!tok) {
        this.log(`❌ Login failed (HTTP ${resp.status}) — ${raw.slice(0,200)}`);
        return false;
      }

      this.token = tok;
      const p = JSON.parse(Buffer.from(tok.split(".")[1], "base64").toString());
      this.userId = String(p.id || "");
      this.log(`✓ Logged in — id:${this.userId}`);

      if (this.isMain) { saveTokenToEnv(tok); TOKEN = tok; }
      return true;

    } catch(e) {
      this.log(`❌ Login error: ${e.message}`);
      return false;
    }
  }

  isTokenExpired() {
    if (!this.token) return true;
    try {
      const p = JSON.parse(Buffer.from(this.token.split(".")[1], "base64").toString());
      return Date.now() > p.exp * 1000 - 3_600_000;
    } catch { return false; }
  }

  // ── HTTP helper ───────────────────────────────────────────
  async api(method, apiPath, body) {
    const opts = {
      method,
      headers: { "Content-Type":"application/json", Authorization:`Bearer ${this.token}` },
    };
    if (body) opts.body = JSON.stringify(body);
    try {
      const r = await fetch(`${API_BASE}${apiPath}`, opts);
      const t = await r.text();
      try { return { status:r.status, data:JSON.parse(t) }; }
      catch { return { status:r.status, data:t }; }
    } catch(e) { return { status:500, data:e.message }; }
  }

  // ── Messaging ─────────────────────────────────────────────
  sendRoom(roomId, text) {
    if (!this.socket?.connected) return;
    this.socket.emit("send_message", {
      room_id: Number(roomId), content: text, msg_type: "text",
      client_msg_id: `bot_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    });
    this.log(`→ Room ${roomId}: "${text.slice(0,80)}"`);
  }

  sendPrivate(toUser, text) {
    if (!this.socket?.connected) return;
    this.socket.emit("private_message", { to_username:toUser, content:text });
    this.log(`→ PM @${toUser}: "${text.slice(0,80)}"`);
  }

  // ── Room control ──────────────────────────────────────────
  joinRoom(roomId) {
    roomId = Number(roomId);
    if (this.socket?.connected) {
      this.socket.emit("join_room", { room_id:roomId, is_manual:true });
      this.joinedRooms.add(roomId);
      this.log(`+ Joining room ${roomId}`);
    }
  }

  leaveRoom(roomId) {
    roomId = Number(roomId);
    if (this.socket?.connected) {
      this.socket.emit("leave_room", { room_id:roomId });
      this.joinedRooms.delete(roomId);
      this.log(`- Left room ${roomId}`);
    }
  }

  leaveAll() {
    for (const r of this.joinedRooms)
      if (this.socket?.connected) this.socket.emit("leave_room", { room_id:r });
    const n = this.joinedRooms.size;
    this.joinedRooms.clear();
    return n;
  }

  // ── Friends ───────────────────────────────────────────────
  async sendFriendRequest(u)  { return this.api("POST","/api/friends/request",{username:u}); }

  async acceptFriendRequest(id) {
    return this.api("POST","/api/friends/accept",{ request_id: Number(id) });
  }

  // Accept ALL pending friend requests at once
  async acceptAllFriendRequests() {
    const r = await this.getFriendRequests();
    const reqs = Array.isArray(r.data) ? r.data : (r.data?.requests || r.data?.data || []);
    if (!reqs.length) return { accepted:0, failed:0, list:[] };
    let accepted=0, failed=0, list=[];
    for (const req of reqs) {
      const reqId = req.id || req.request_id;
      if (!reqId) continue;
      const res = await this.acceptFriendRequest(reqId);
      const name = req.username || req.sender?.username || `#${reqId}`;
      if (res.status < 400) { accepted++; list.push(`✅ @${name}`); }
      else                  { failed++;   list.push(`❌ @${name} (${res.status})`); }
      await new Promise(r=>setTimeout(r,300)); // small delay between accepts
    }
    return { accepted, failed, list };
  }

  async getFriendRequests()    { return this.api("GET","/api/friends/requests"); }
  async getFriends()           { return this.api("GET","/api/friends"); }

  // Check if PIN is set on this account
  async getPinStatus() { return this.api("GET","/api/account/pin/status"); }

  // Get full account info including balance
  async getAccount()   { return this.api("GET","/api/account"); }

  // Transfer coins to another user
  // pin: account PIN (set in mig66 app)
  // sendTag: whether to announce transfer in room (false = silent)
  async transferCoins(toUsername, amount, pin, sendTag=false) {
    if (!pin) return { status:400, data:"PIN required" };
    return this.api("POST","/api/account/transfer",{
      to_username: toUsername,
      amount:      Number(amount),
      pin:         String(pin),
      send_tag:    Boolean(sendTag),
    });
  }

  // ── Voucher ───────────────────────────────────────────────
  // Tries every known voucher message format used by mig66.
  // Returns true if a code was found and pick command sent.
  tryPickVoucher(content, roomId) {
    if (!this.voucherOn) return false;

    const lower = content.toLowerCase();

    // Must contain "code" somewhere — broad gate so we don't miss formats
    if (!lower.includes("code")) return false;

    let code = null;

    // Format 1: [code] 12345   or   [code]: 12345
    const f1 = content.match(/\[code\][:\s]+\s*(\d{4,10})/i);
    if (f1) code = f1[1];

    // Format 2: code: 12345   or   code = 12345   or   code 12345
    if (!code) {
      const f2 = content.match(/\bcode[:\s=]+\s*(\d{4,10})/i);
      if (f2) code = f2[1];
    }

    // Format 3: pick code 12345  or  pick: 12345
    if (!code) {
      const f3 = content.match(/\bpick[\s:]+(?:code[\s:]+)?(\d{4,10})/i);
      if (f3) code = f3[1];
    }

    // Format 4: standalone 4-10 digit number near "code" keyword
    // (catches anything like "your code is 123456 hurry!")
    if (!code) {
      const f4 = content.match(/\b(\d{4,10})\b/);
      if (f4 && lower.includes("code")) code = f4[1];
    }

    if (!code) return false;

    this.log(`🎁 VOUCHER DETECTED! Code: ${code} in room ${roomId}`);
    this.log(`   Raw message: "${content.slice(0, 120)}"`);

    // Send immediately
    this.sendRoom(roomId, `/pick ${code}`);

    // Also retry once after 300ms in case first send was dropped
    setTimeout(() => {
      if (this.socket?.connected) {
        this.sendRoom(roomId, `/pick ${code}`);
        this.log(`🎁 Voucher retry sent: ${code}`);
      }
    }, 300);

    return true;
  }

  // ── Auto-welcome ──────────────────────────────────────────
  handleUserJoined(data) {
    if (!this.awOn) return;
    const rid = Number(data.room_id);
    if (!this.joinedRooms.has(rid)) return;
    if (this.awRooms.size > 0 && !this.awRooms.has(rid)) return;
    if ((data.username||"").toLowerCase() === this.username.toLowerCase()) return;
    const msg = (this.awMessages.get(rid) || this.awTemplate).replace("{username}", data.username);
    setTimeout(() => this.sendRoom(rid, msg), 800);
  }

  // ── Auto-text ─────────────────────────────────────────────
  startAutoText() {
    if (!this.autoTextOn || !this.autoTextMessages.length || !this.autoTextRooms.size) return;
    const tick = () => {
      if (!this.autoTextOn) return;
      for (const rid of this.autoTextRooms) {
        if (!this.joinedRooms.has(rid)) continue;
        let i = this.autoTextIndex.get(rid) || 0;
        if (i >= this.autoTextMessages.length) { i = 0; }
        this.sendRoom(rid, this.autoTextMessages[i]);
        this.log(`📝 AutoText [${i+1}/${this.autoTextMessages.length}] → Room ${rid}`);
        this.autoTextIndex.set(rid, i+1);
      }
      this.autoTextTimer = setTimeout(tick, this.autoTextInterval * 60_000);
    };
    tick();
  }

  stopAutoText() {
    if (this.autoTextTimer) { clearTimeout(this.autoTextTimer); this.autoTextTimer = null; }
  }

  setAutoTextInterval(min) {
    this.autoTextInterval = min;
    if (this.autoTextOn) { this.stopAutoText(); this.startAutoText(); }
  }

  // ── Flood ─────────────────────────────────────────────────
  startCustomFlood(roomId, text) {
    this.stopFlood();
    this.floodActive = true; this.floodRoomId = Number(roomId);
    this.floodMode = "custom"; this.floodCustomText = text; this.floodMessageCount = 0;
    this.log(`🌊 CUSTOM FLOOD room ${roomId} | "${text}"`);
    const tick = () => {
      if (!this.floodActive || !this.socket?.connected) { this.stopFlood(); return; }
      this.sendRoom(this.floodRoomId, this.floodCustomText);
      this.floodMessageCount++;
      this.floodInterval = setTimeout(tick, 100);
    };
    tick(); return true;
  }

  startAutoFlood(roomId) {
    this.stopFlood();
    this.floodMessages = loadLines("flood.txt");
    if (!this.floodMessages.length) { this.log("❌ flood.txt empty"); return false; }
    this.floodActive = true; this.floodRoomId = Number(roomId);
    this.floodMode = "auto"; this.floodIndex = 0; this.floodMessageCount = 0;
    this.log(`🌊 AUTO FLOOD room ${roomId} | ${this.floodMessages.length} msgs`);
    const tick = () => {
      if (!this.floodActive || !this.socket?.connected) { this.stopFlood(); return; }
      if (this.floodIndex >= this.floodMessages.length) this.floodIndex = 0;
      this.sendRoom(this.floodRoomId, this.floodMessages[this.floodIndex++]);
      this.floodMessageCount++;
      this.floodInterval = setTimeout(tick, 100);
    };
    tick(); return true;
  }

  stopFlood() {
    if (this.floodInterval) { clearTimeout(this.floodInterval); this.floodInterval = null; }
    if (this.floodActive)
      this.log(`🛑 FLOOD STOPPED room ${this.floodRoomId} (${this.floodMessageCount} sent)`);
    this.floodActive=false; this.floodRoomId=null; this.floodMessages=[];
    this.floodIndex=0; this.floodMode="custom"; this.floodCustomText=""; this.floodMessageCount=0;
  }

  floodStatus() {
    if (!this.floodActive) return "🔴 OFF";
    return this.floodMode==="custom"
      ? `🌊 CUSTOM (room:${this.floodRoomId} sent:${this.floodMessageCount} "${this.floodCustomText.slice(0,30)}")`
      : `🌊 AUTO (room:${this.floodRoomId} sent:${this.floodMessageCount} ${this.floodIndex}/${this.floodMessages.length})`;
  }

  // ══════════════════════════════════════════════════════════
  //  LOW CARD BOT AUTO-PLAY SYSTEM
  //  Commands: |lcb on <roomId> $acc  /  |lcb off <roomId> $acc
  //
  //  Flow (mirrors intercept data exactly):
  //   1. Bot joins room → room_joined fires
  //   2. LowCard Bot sends idle announcement → bot sends !start
  //   3. "LowCard started. !j to join" → bot sends !j (with 1s delay)
  //   4. game_state phase=playing + round≥1 → bot sends !d immediately
  //   5. game_state phase=over → reset state, wait for next idle message
  // ══════════════════════════════════════════════════════════

  lcbStart(roomId) {
    roomId = Number(roomId);
    this.lcbRooms.add(roomId);
    this.lcbState.set(roomId, {
      phase: "idle",        // idle | joining | playing | over
      round: 0,
      joinedGame: false,    // did we send !j already?
      drawnRounds: new Set(), // which rounds did we send !d?
    });
    this.log(`🃏 LCB AUTO-PLAY ON → room ${roomId}`);
  }

  lcbStop(roomId) {
    roomId = Number(roomId);
    this.lcbRooms.delete(roomId);
    this.lcbState.delete(roomId);
    // Cancel any pending join timer
    if (this.lcbJoinTimer.has(roomId)) {
      clearTimeout(this.lcbJoinTimer.get(roomId));
      this.lcbJoinTimer.delete(roomId);
    }
    this.log(`🃏 LCB AUTO-PLAY OFF → room ${roomId}`);
  }

  lcbStopAll() {
    for (const rid of [...this.lcbRooms]) this.lcbStop(rid);
  }

  // Called from handleRoom for every new_message in an LCB room
  handleLcbMessage(content, roomId, msgType) {
    if (!this.lcbRooms.has(roomId)) return;

    const lower   = content.toLowerCase();
    const state   = this.lcbState.get(roomId) || { phase:"idle", round:0, joinedGame:false, drawnRounds:new Set() };
    const isLcbBot = msgType === "lowcard_bot" || lower.includes("lowcard");

    if (!isLcbBot) return;

    // ── PHASE 1: Idle announcement → send !start ─────────────
    // "Play LowCard. Type !start to start a game."
    if (
      lower.includes("play lowcard") &&
      lower.includes("!start") &&
      state.phase === "idle"
    ) {
      this.log(`🃏 [LCB] Room ${roomId}: Idle detected → sending !start`);
      state.phase = "starting";
      this.lcbState.set(roomId, state);
      // Small delay so we don't race with other bots
      setTimeout(() => {
        if (this.lcbRooms.has(roomId) && this.socket?.connected) {
          this.sendRoom(roomId, "!start");
          this.log(`🃏 [LCB] Room ${roomId}: !start sent`);
        }
      }, 500);
      return;
    }

    // ── PHASE 2: Game started → send !j ──────────────────────
    // "LowCard started. !j to join, cost cents 200 [40 sec]"
    if (
      lower.includes("lowcard started") &&
      lower.includes("!j") &&
      !state.joinedGame
    ) {
      this.log(`🃏 [LCB] Room ${roomId}: Game started → sending !j`);
      state.phase      = "joining";
      state.joinedGame = true;
      this.lcbState.set(roomId, state);

      // 1 second delay — gives the game time to register properly
      const t = setTimeout(() => {
        if (this.lcbRooms.has(roomId) && this.socket?.connected) {
          this.sendRoom(roomId, "!j");
          this.log(`🃏 [LCB] Room ${roomId}: !j sent`);
        }
        this.lcbJoinTimer.delete(roomId);
      }, 1000);
      this.lcbJoinTimer.set(roomId, t);
      return;
    }

    // ── PHASE 3: Round started → send !d ─────────────────────
    // "Round #1. Players !d to draw [20 seconds]"
    // "Round #2. Players !d to draw [20 seconds]"  etc.
    const roundMatch = content.match(/round\s*#?(\d+)[.\s].*!d/i);
    if (roundMatch && state.joinedGame) {
      const roundNum = Number(roundMatch[1]);
      if (!state.drawnRounds) state.drawnRounds = new Set();

      if (!state.drawnRounds.has(roundNum)) {
        state.drawnRounds.add(roundNum);
        state.phase = "playing";
        state.round = roundNum;
        this.lcbState.set(roomId, state);

        this.log(`🃏 [LCB] Room ${roomId}: Round #${roundNum} → sending !d`);
        // Send immediately + one retry at 2s in case of lag
        setTimeout(() => {
          if (this.lcbRooms.has(roomId) && this.socket?.connected) {
            this.sendRoom(roomId, "!d");
            this.log(`🃏 [LCB] Room ${roomId}: !d sent (round ${roundNum})`);
          }
        }, 300);
        setTimeout(() => {
          if (this.lcbRooms.has(roomId) && this.socket?.connected && state.drawnRounds.has(roundNum)) {
            this.sendRoom(roomId, "!d");
            this.log(`🃏 [LCB] Room ${roomId}: !d retry (round ${roundNum})`);
          }
        }, 2500);
      }
      return;
    }

    // ── PHASE 4: Game over — reset for next game ──────────────
    // "LowCard game is over! ... wins"  or  "Not enough players! Refunding"
    if (
      (lower.includes("game is over") || lower.includes("not enough players") || lower.includes("refunding")) &&
      state.phase !== "idle"
    ) {
      this.log(`🃏 [LCB] Room ${roomId}: Game over → reset to idle`);
      this.lcbState.set(roomId, {
        phase: "idle",
        round: 0,
        joinedGame: false,
        drawnRounds: new Set(),
      });
      return;
    }

    // ── PHASE 5: New game invite after over ───────────────────
    // "Play LowCard. Type !start to start a new game"
    if (
      lower.includes("play lowcard") &&
      lower.includes("!start") &&
      (state.phase === "over" || state.phase === "idle")
    ) {
      this.log(`🃏 [LCB] Room ${roomId}: New game available → sending !start`);
      state.phase      = "starting";
      state.joinedGame = false;
      state.drawnRounds = new Set();
      this.lcbState.set(roomId, state);
      setTimeout(() => {
        if (this.lcbRooms.has(roomId) && this.socket?.connected) {
          this.sendRoom(roomId, "!start");
          this.log(`🃏 [LCB] Room ${roomId}: !start sent (new game)`);
        }
      }, 500);
      return;
    }
  }

  // Called from socket "game_state" event — handles phase transitions
  // from the server-pushed game state (more reliable than message parsing)
  handleLcbGameState(data) {
    const roomId = Number(data.room_id);
    if (!this.lcbRooms.has(roomId)) return;
    if (data.game !== "lowcard") return;

    const state = this.lcbState.get(roomId) || { phase:"idle", round:0, joinedGame:false, drawnRounds:new Set() };
    const gPhase = data.phase;   // "idle" | "joining" | "playing" | "over"
    const round  = data.round || 0;

    // ── joining phase: if we haven't joined yet, send !j ─────
    if (gPhase === "joining" && !state.joinedGame) {
      const alreadyIn = (data.players || []).some(
        p => p.username?.toLowerCase() === this.username.toLowerCase()
      );
      if (!alreadyIn) {
        this.log(`🃏 [LCB][game_state] Room ${roomId}: joining phase, sending !j`);
        state.joinedGame = true;
        this.lcbState.set(roomId, state);
        const t = setTimeout(() => {
          if (this.lcbRooms.has(roomId) && this.socket?.connected) {
            this.sendRoom(roomId, "!j");
          }
          this.lcbJoinTimer.delete(roomId);
        }, 800);
        this.lcbJoinTimer.set(roomId, t);
      } else {
        // We're already listed as a player
        state.joinedGame = true;
        this.lcbState.set(roomId, state);
      }
    }

    // ── playing phase: if new round and we haven't drawn ─────
    if (gPhase === "playing" && round > 0 && state.joinedGame) {
      if (!state.drawnRounds) state.drawnRounds = new Set();
      if (!state.drawnRounds.has(round)) {
        const isActive = (data.players || []).some(
          p => p.username?.toLowerCase() === this.username.toLowerCase() && p.active
        );
        if (isActive) {
          state.drawnRounds.add(round);
          state.round = round;
          this.lcbState.set(roomId, state);
          this.log(`🃏 [LCB][game_state] Room ${roomId}: round ${round} → !d`);
          setTimeout(() => {
            if (this.lcbRooms.has(roomId) && this.socket?.connected) {
              this.sendRoom(roomId, "!d");
            }
          }, 400);
        }
      }
    }

    // ── over phase: reset ─────────────────────────────────────
    if (gPhase === "over" && state.phase !== "idle") {
      const won = data.winner_username?.toLowerCase() === this.username.toLowerCase();
      this.log(`🃏 [LCB][game_state] Room ${roomId}: Game over. ${won ? "🏆 WE WON!" : "Game ended."} → reset`);
      this.lcbState.set(roomId, {
        phase: "idle", round: 0, joinedGame: false, drawnRounds: new Set(),
      });
    }
  }

  lcbStatusText(roomId) {
    if (!this.lcbRooms.has(roomId)) return "🔴 OFF";
    const s = this.lcbState.get(roomId);
    if (!s) return "🟡 ON (no state)";
    return `🟢 ON | phase:${s.phase} round:${s.round} joined:${s.joinedGame}`;
  }

  // ── Status ────────────────────────────────────────────────
  statusText() {
    const rooms  = this.joinedRooms.size ? [...this.joinedRooms].join(", ") : "none";
    const awR    = this.awRooms.size ? [...this.awRooms].join(", ") : "all";
    const bal    = this.balance !== null ? `${this.balance} cents` : "unknown";
    const up     = formatUptime((Date.now()-this.startTime)/1000);
    const motherTag = isMother(this.username) ? " 👑MOTHER" : "";
    let atStatus = "🔴 OFF";
    if (this.autoTextOn) {
      const prog = [...this.autoTextRooms].map(r=>`R${r}:${this.autoTextIndex.get(r)||0}/${this.autoTextMessages.length}`).join(", ");
      atStatus = `🟢 ON (rooms:${[...this.autoTextRooms].join(",")} ${prog} int:${this.autoTextInterval}m)`;
    }
    const lcbStatus = this.lcbRooms.size > 0
      ? `🟢 ON (rooms: ${[...this.lcbRooms].map(r=>`${r}[${this.lcbState.get(r)?.phase||"?"}]`).join(", ")})`
      : "🔴 OFF";

    return (
      `👤 @${this.username}${motherTag}\n`+
      `  Connection  : ${this.isConnected?"🟢 Online":"🔴 Offline"}\n`+
      `  Active rooms: [${rooms}]\n`+
      `  Voucher pick: ${this.voucherOn?"🟢 ON":"🔴 OFF"}\n`+
      `  Auto-welcome: ${this.awOn?`🟢 ON (rooms:${awR})`:"🔴 OFF"}\n`+
      `  Auto-reply  : ${this.autoReplyOn?"🟢 ON":"🔴 OFF"}\n`+
      `  Auto-text   : ${atStatus}\n`+
      `  Flood       : ${this.floodStatus()}\n`+
      `  LowCard Bot : ${lcbStatus}\n`+
      `  Balance     : ${bal}\n`+
      `  Uptime      : ${up}`
    );
  }

  // ── Handle private message ────────────────────────────────
  async handlePrivate(data) {
    const senderId  = String(data.sender_id   || "");
    const senderName= String(data.sender_name || "");
    const content   = String(data.content     || "").trim();
    if (!content) return;
    if (this.userId && senderId === this.userId) return;
    if (senderName.toLowerCase() === this.username.toLowerCase()) return;
    this.log(`📨 PM from @${senderName}: "${content}"`);

    // Commands — both parents and sub-parents, PM only for sub-parents
    if (isAuthorized(senderName) && content.startsWith("|")) {
      await handleCommand(content, senderName, this, "private");
      return;
    }

    // /a AI trigger
    if (content.toLowerCase().startsWith("/a ") && this.autoReplyOn) {
      const q = content.slice(3).trim();
      this.sendPrivate(senderName, await getAIReply(q).catch(()=>"Error"));
      return;
    }

    if (this.autoReplyOn) {
      const q = content.replace(new RegExp(TRIGGER,"gi"),"").trim() || content;
      const key = `pvt:${senderId}:${q.slice(0,80)}`;
      if (this.processed.has(key)) return;
      this.processed.add(key);
      if (this.processed.size > 500) this.processed.delete(this.processed.values().next().value);
      this.sendPrivate(senderName, await getAIReply(q).catch(()=>"Error"));
    }
  }

  // ── Handle room message ───────────────────────────────────
  async handleRoom(data) {
    const senderId  = String(data.sender_id || "");
    const senderName= String(data.username  || "");
    const content   = String(data.content   || "").trim();
    const roomId    = data.room_id;
    if (!content) return;
    if (this.userId && senderId === this.userId) return;
    if (senderName.toLowerCase() === this.username.toLowerCase()) return;

    // Room commands — parents only
    if (isParent(senderName) && content.startsWith("|")) {
      await handleCommand(content, senderName, this, "room", roomId);
      return;
    }

    if (content.toLowerCase().startsWith("/a ") && this.autoReplyOn) {
      const q = content.slice(3).trim();
      this.sendRoom(roomId, `@${senderName} ${await getAIReply(q).catch(()=>"Error")}`);
      return;
    }

    if (this.tryPickVoucher(content, roomId)) return;

    // LowCard Bot auto-play — fires on every room message in an LCB room
    this.handleLcbMessage(content, roomId, data.msg_type);

    if (this.autoReplyOn && content.toLowerCase().includes(TRIGGER)) {
      const q = content.replace(new RegExp(TRIGGER,"gi"),"").trim() || content;
      const key = `room:${senderId}:${q.slice(0,80)}`;
      if (this.processed.has(key)) return;
      this.processed.add(key);
      if (this.processed.size > 500) this.processed.delete(this.processed.values().next().value);
      this.sendRoom(roomId, `@${senderName} ${await getAIReply(q).catch(()=>"Error")}`);
    }
  }

  // ── Connect ───────────────────────────────────────────────
  connect(defaultRoom) {
    if (this.reconnTimer) { clearTimeout(this.reconnTimer); this.reconnTimer = null; }
    if (this.isTokenExpired()) {
      this.log("⚠️ Token expired — re-logging in...");
      this.token = null;
      this.login().then(ok => {
        if (!ok) { this.reconnTimer = setTimeout(()=>this.connect(defaultRoom), 30_000); }
        else { this.connect(defaultRoom); }
      });
      return;
    }
    this.log("Connecting...");
    this.socket = io(API_BASE, { auth:{token:this.token}, transports:["websocket","polling"], reconnection:false });

    this.socket.on("connect", async () => {
      this.isConnected = true;
      this.log(`✓ Connected SID:${this.socket.id}`);
      await new Promise(r=>setTimeout(r,400));
      const rooms = this.joinedRooms.size ? [...this.joinedRooms] : [defaultRoom];
      this.joinedRooms.clear();
      for (const r of rooms) this.joinRoom(r);
      if (this.autoTextOn) this.startAutoText();
    });

    this.socket.on("room_joined",      d => { this.joinedRooms.add(Number(d?.room_id)); this.log(`✓ Joined room ${d?.room_id}`); });
    this.socket.on("user_joined_room", d => this.handleUserJoined(d));
    this.socket.on("balance_update",   d => (this.balance = d?.balance_cents));
    this.socket.on("private_message",  d => this.handlePrivate(d).catch(console.error));
    this.socket.on("new_message",      d => this.handleRoom(d).catch(console.error));
    this.socket.on("private_message_sent", d => this.log(`✓ PM delivered: "${String(d?.content||"").slice(0,60)}"`));
    // LowCard Bot — game_state gives the most reliable phase signals
    this.socket.on("game_state",       d => this.handleLcbGameState(d));

    this.socket.on("disconnect", reason => {
      this.isConnected = false;
      this.log(`! Disconnected: ${reason}`);
      this.stopAutoText(); this.stopFlood(); this.lcbStopAll();
      if (reason === "io client disconnect") return;
      this.reconnTimer = setTimeout(async () => {
        if (this.isTokenExpired()) {
          this.token = null;
          const ok = await this.login();
          if (!ok) { this.reconnTimer = setTimeout(()=>this.connect(defaultRoom), 30_000); return; }
        }
        this.connect(defaultRoom);
      }, 5_000);
    });

    this.socket.on("connect_error", e => {
      this.isConnected = false;
      this.log(`! Connect error: ${e.message}`);
      this.reconnTimer = setTimeout(()=>this.connect(defaultRoom), 8_000);
    });

    if (DEBUG) {
      const SKIP = ["room_count_update","private_user_typing","user_joined","user_left",
        "user_left_room","user_joined_room","room_joined","new_message","private_message",
        "private_message_sent","system_message","uno_state","balance_update","connect","disconnect"];
      this.socket.onAny((ev,d) => { if (!SKIP.includes(ev)) this.log(`[evt] "${ev}": ${JSON.stringify(d).slice(0,150)}`); });
    }
  }

  disconnect() {
    if (this.reconnTimer) clearTimeout(this.reconnTimer);
    this.stopAutoText(); this.stopFlood();
    if (this.socket) this.socket.disconnect();
    this.isConnected = false;
  }
}

// ══════════════════════════════════════════════════════════════
//  ACCOUNT MAP
// ══════════════════════════════════════════════════════════════
const accounts = new Map();

// $aa = all accounts that are NOT mother/parent/sub-parent
function getAllSubAccounts() {
  return [...accounts.values()].filter(
    a => !isMother(a.username) && !isParent(a.username) && !isSubParent(a.username)
  );
}

// ══════════════════════════════════════════════════════════════
//  COMMAND HANDLER
//  source: "private" | "room"
// ══════════════════════════════════════════════════════════════
async function handleCommand(content, senderName, callerAccount, source, sourceRoomId=null) {
  let cmd = content.trim();
  const isFullParent = isParent(senderName);
  const isSubP       = isSubParent(senderName);

  // Sub-parents: PM only
  if (isSubP && !isFullParent && source === "room") return;

  console.log(`\n[${isFullParent?"👑 PARENT":"👤 SUB-PARENT"}][${source.toUpperCase()}] @${senderName} → "${cmd}"`);

  // Reply always goes to PM
  const reply = text => callerAccount.sendPrivate(senderName, text);

  // ── Resolve targets ($aa or $name) ───────────────────────
  let targetAccounts = [];
  let isAllAccounts  = false;

  const dollarMatches = [...cmd.matchAll(/\$(\w+)/g)];
  if (dollarMatches.length > 0) {
    for (const m of dollarMatches) {
      const tok = m[1].toLowerCase();
      if (tok === "aa") {
        isAllAccounts  = true;
        targetAccounts = getAllSubAccounts();
        if (!targetAccounts.length) { reply("❌ No sub-accounts logged in. Use |lnu first."); return; }
        break;
      } else if (accounts.has(tok)) {
        targetAccounts.push(accounts.get(tok));
      } else {
        reply(`❌ Unknown account $${tok}. Use |accounts to list.`);
        return;
      }
    }
    cmd = cmd.replace(/\s*\$\w+/g, "").trim();
  } else {
    // Legacy @username
    const m = cmd.match(/^\|\w+\s+@(\w+)/);
    if (m) {
      const n = m[1].toLowerCase();
      if (accounts.has(n)) targetAccounts.push(accounts.get(n));
      else { reply(`❌ Unknown account @${m[1]}`); return; }
    }
  }

  const target = targetAccounts.length > 0 ? targetAccounts[0] : callerAccount;

  // Parent-only guard
  if (/^\|(ap|rp|asp|rsp|lnu|ltu)\b/i.test(cmd) && !isFullParent) {
    reply("❌ Permission denied. Full parents only."); return;
  }
  // $aa guard for sub-parents
  if (isAllAccounts && /^\|(jr|lr|flood|autoflood)\b/i.test(cmd) && !isFullParent) {
    reply("❌ Sub-parents cannot use $aa with this command."); return;
  }

  // ══════════════════════════════════════════════════════════
  //  |lnu — LOGIN NEW USER(S)
  //  Supports:  |lnu username:password
  //             |lnu user1:pass1;user2:pass2
  //  Password may contain colons — only the FIRST colon splits user:pass
  // ══════════════════════════════════════════════════════════
  const lnuMatch = cmd.match(/^\|lnu\s+(.+)/i);
  if (lnuMatch) {
    const entries = lnuMatch[1].trim().split(";").map(s=>s.trim()).filter(Boolean);
    let ok=0, fail=0;
    for (const entry of entries) {
      const colon = entry.indexOf(":");
      if (colon === -1) { reply(`❌ Bad format: "${entry}" — use username:password`); continue; }
      const uname = entry.slice(0, colon).trim();
      const pwd   = entry.slice(colon + 1).trim();
      if (!uname || !pwd) { reply(`❌ Empty user or pass in: "${entry}"`); continue; }
      if (accounts.has(uname.toLowerCase())) { reply(`⚠️ @${uname} already logged in`); continue; }
      reply(`⏳ Logging in @${uname}...`);
      const acc = new BotAccount({ username:uname, password:pwd });
      const loggedIn = await acc.login();
      if (!loggedIn) { reply(`❌ Login failed for @${uname} — check credentials`); fail++; continue; }
      accounts.set(uname.toLowerCase(), acc);
      acc.connect(ROOM_ID);
      reply(`✅ @${uname} logged in and connected to room ${ROOM_ID}`);
      ok++;
    }
    if (entries.length > 1) reply(`📊 Done: ${ok} success, ${fail} failed`);
    return;
  }

  // ── |ltu — logout ─────────────────────────────────────────
  const ltuMatch = cmd.match(/^\|ltu\s+(\w+)/i);
  if (ltuMatch) {
    const uname = ltuMatch[1].toLowerCase();
    if (isMother(uname)) { reply("❌ Cannot logout mother account"); return; }
    const acc = accounts.get(uname);
    if (!acc) { reply(`❌ @${uname} not logged in`); return; }
    acc.disconnect(); accounts.delete(uname);
    reply(`✅ @${uname} logged out`); return;
  }

  // ── |accounts ─────────────────────────────────────────────
  if (/^\|accounts/i.test(cmd)) {
    const list = [...accounts.values()].map(a => {
      const tag = isMother(a.username) ? " 👑" : "";
      return `  @${a.username}${tag} ${a.isConnected?"🟢":"🔴"} rooms:[${[...a.joinedRooms].join(",")||"none"}]`;
    }).join("\n");
    reply(`👥 Active (${accounts.size}):\n${list}`); return;
  }

  // ══════════════════════════════════════════════════════════
  //  ROOM MANAGEMENT
  // ══════════════════════════════════════════════════════════
  const joinMatch = cmd.match(/^\|jr\s+(\d+)/i);
  if (joinMatch) {
    const rid = joinMatch[1];
    const accs = isAllAccounts ? getAllSubAccounts() : targetAccounts.length ? targetAccounts : [target];
    if (isAllAccounts && !accs.length) { reply("❌ No sub-accounts logged in"); return; }
    for (const a of accs) a.joinRoom(rid);
    reply(`✅ ${accs.map(a=>`@${a.username}`).join(", ")} → joining room ${rid}`); return;
  }

  if (/^\|lr\s+all/i.test(cmd)) {
    if (isAllAccounts) {
      let n=0; for (const a of getAllSubAccounts()) n+=a.leaveAll();
      reply(`✅ All sub-accounts left all rooms (${n} total)`);
    } else {
      reply(`✅ @${target.username} left all rooms (${target.leaveAll()})`);
    }
    return;
  }

  const leaveMatch = cmd.match(/^\|lr\s+(\d+)/i);
  if (leaveMatch) {
    const rid = leaveMatch[1];
    if (isAllAccounts) {
      const accs = getAllSubAccounts().filter(a=>a.joinedRooms.has(Number(rid)));
      if (!accs.length) { reply(`⚠️ No sub-accounts are in room ${rid}`); return; }
      for (const a of accs) a.leaveRoom(rid);
      reply(`✅ Left room ${rid}: ${accs.map(a=>`@${a.username}`).join(", ")}`);
    } else {
      const accs = targetAccounts.length ? targetAccounts : [target];
      for (const a of accs) a.leaveRoom(rid);
      reply(`✅ ${accs.map(a=>`@${a.username}`).join(", ")} left room ${rid}`);
    }
    return;
  }

  const trMatch = cmd.match(/^\|tr\s+(\d+)\s+(.+)/i);
  if (trMatch) { target.sendRoom(trMatch[1], trMatch[2].trim()); reply(`✅ Sent to room ${trMatch[1]} as @${target.username}`); return; }

  const addRoomMatch = cmd.match(/^\|addroom\s+(.+)/i);
  if (addRoomMatch) {
    for (const r of addRoomMatch[1].split(",")) {
      const [n,id] = r.split(/[:=]/).map(s=>s.trim());
      if (!n||!id) { reply(`❌ Invalid: "${r}" — use Name=ID`); continue; }
      addRoom(n,id); reply(`✅ Added room: ${n}=${id}`);
    }
    return;
  }

  const rmRoomMatch = cmd.match(/^\|removeroom\s+(.+)/i);
  if (rmRoomMatch) {
    for (const r of rmRoomMatch[1].split(",")) {
      const n = r.split(/[:=]/)[0].trim();
      if (ROOM_LIST.has(n)) { removeRoom(n); reply(`✅ Removed: ${n}`); }
      else { reply(`❌ Room "${n}" not found`); }
    }
    return;
  }

  if (/^\|listroom/i.test(cmd)) { reply(`📋 Rooms:\n${listRooms()}`); return; }

  // ══════════════════════════════════════════════════════════
  //  FLOOD
  // ══════════════════════════════════════════════════════════
  const floodMatch = cmd.match(/^\|flood\s+(\d+)\s+(.+)/i);
  if (floodMatch) {
    const rid = floodMatch[1], txt = floodMatch[2].trim();
    const accs = isAllAccounts ? getAllSubAccounts() : targetAccounts.length ? targetAccounts : null;
    if (!accs) { reply(`❌ Specify: |flood ${rid} <text> $username  or  $aa`); return; }
    if (!accs.length) { reply("❌ No sub-accounts logged in"); return; }
    for (const a of accs) if (a.startCustomFlood(rid,txt)) reply(`🌊 CUSTOM FLOOD @${a.username} room:${rid}`);
    return;
  }

  const afMatch = cmd.match(/^\|autoflood\s+(\d+)/i);
  if (afMatch) {
    const rid = afMatch[1];
    const accs = isAllAccounts ? getAllSubAccounts() : targetAccounts.length ? targetAccounts : null;
    if (!accs) { reply(`❌ Specify: |autoflood ${rid} $username  or  $aa`); return; }
    if (!accs.length) { reply("❌ No sub-accounts logged in"); return; }
    for (const a of accs) {
      if (a.startAutoFlood(rid)) reply(`🌊 AUTO FLOOD @${a.username} room:${rid} ${a.floodMessages.length} msgs`);
      else reply(`❌ @${a.username}: check flood.txt`);
    }
    return;
  }

  if (/^\|flood\s+stop/i.test(cmd)) {
    const accs = isAllAccounts ? getAllSubAccounts() : targetAccounts.length ? targetAccounts : [target];
    for (const a of accs) a.stopFlood();
    reply(`🛑 FLOOD STOPPED: ${accs.map(a=>`@${a.username}`).join(", ")}`); return;
  }

  if (/^\|flood\s+reload/i.test(cmd)) {
    const msgs = loadLines("flood.txt");
    reply(`✅ Reloaded ${msgs.length} msgs from flood.txt`); return;
  }

  // ══════════════════════════════════════════════════════════
  //  FRIENDS & BALANCE
  // ══════════════════════════════════════════════════════════
  // ── |sf — send friend request ───────────────────────────
  const sfMatch = cmd.match(/^\|sf\s+(\w+)/i);
  if (sfMatch) {
    const r = await target.sendFriendRequest(sfMatch[1]);
    const ok = r.status < 400;
    reply(`${ok?"✅":"❌"} Friend request to @${sfMatch[1]} from @${target.username}` +
          (ok ? "" : `\nError: ${JSON.stringify(r.data).slice(0,100)}`));
    return;
  }

  // ── |af <id> — accept specific friend request ────────────
  const afFriendMatch = cmd.match(/^\|af\s+(\d+)/i);
  if (afFriendMatch) {
    const r = await target.acceptFriendRequest(afFriendMatch[1]);
    const ok = r.status < 400;
    reply(`${ok?"✅":"❌"} ${ok?"Accepted":"Failed"} friend request #${afFriendMatch[1]} on @${target.username}` +
          (ok ? "" : `\nError: ${JSON.stringify(r.data).slice(0,100)}`));
    return;
  }

  // ── |afa — accept ALL pending friend requests ─────────────
  if (/^\|afa/i.test(cmd)) {
    reply(`⏳ Accepting all friend requests for @${target.username}...`);
    const { accepted, failed, list } = await target.acceptAllFriendRequests();
    if (!accepted && !failed) { reply(`📭 No pending requests on @${target.username}`); return; }
    const summary = `📬 @${target.username}: ${accepted} accepted, ${failed} failed`;
    const detail  = list.join("\n");
    reply(`${summary}\n${detail}`);
    return;
  }

  // ── |fr — list pending friend requests ───────────────────
  if (/^\|fr/i.test(cmd)) {
    const r = await target.getFriendRequests();
    const reqs = Array.isArray(r.data) ? r.data : (r.data?.requests || r.data?.data || []);
    if (!reqs.length) { reply(`📭 No pending requests on @${target.username}`); return; }
    const list = reqs.slice(0,15).map(q =>
      `  ID:${q.id||q.request_id} from @${q.username||q.sender?.username||"?"}`
    ).join("\n");
    reply(`📬 Requests on @${target.username} (${reqs.length}):\n${list}` +
          (reqs.length>15 ? `\n  ...and ${reqs.length-15} more` : ""));
    return;
  }

  // ── |fl — list friends ────────────────────────────────────
  if (/^\|fl/i.test(cmd)) {
    const r = await target.getFriends();
    const friends = Array.isArray(r.data) ? r.data : (r.data?.friends || r.data?.data || []);
    if (!friends.length) { reply(`👥 @${target.username} has no friends yet`); return; }
    const list = friends.slice(0,20).map(f=>
      `  @${f.username||f.friend?.username||"?"}`
    ).join("\n");
    reply(`👥 Friends of @${target.username} (${friends.length}):\n${list}` +
          (friends.length>20 ? `\n  ...and ${friends.length-20} more` : ""));
    return;
  }

  // ── |balance — check balance ──────────────────────────────
  if (/^\|balance/i.test(cmd)) {
    const r = await target.getAccount();
    const bal = r.data?.balance_cents
             ?? r.data?.data?.balance_cents
             ?? target.balance
             ?? "unknown";
    reply(`💰 @${target.username}: ${bal} cents`);
    return;
  }

  // ── |pin — check if PIN is configured ────────────────────
  if (/^\|pin/i.test(cmd)) {
    const r = await target.getPinStatus();
    const hasPin = r.data?.has_pin ?? r.data?.pin_set ?? r.data?.data?.has_pin ?? null;
    if (hasPin === null) reply(`⚙️ @${target.username} PIN status: ${JSON.stringify(r.data).slice(0,100)}`);
    else reply(`${hasPin?"✅":"❌"} @${target.username} PIN is ${hasPin?"configured":"NOT set"}`);
    return;
  }

  // ── |send <to> <amount> <pin> — transfer coins ────────────
  // Usage:  |send faysal 10 333666 $acc
  // Optional flag $tag to announce transfer publicly
  const sendMatch = cmd.match(/^\|send\s+(\w+)\s+(\d+)\s+(\S+)(?:\s+(tag))?/i);
  if (sendMatch) {
    const toUser  = sendMatch[1];
    const amount  = Number(sendMatch[2]);
    const pin     = sendMatch[3];
    const sendTag = !!sendMatch[4];

    if (amount <= 0) { reply("❌ Amount must be greater than 0"); return; }

    reply(`⏳ @${target.username} sending ${amount} coins to @${toUser}...`);

    const r = await target.transferCoins(toUser, amount, pin, sendTag);
    const ok = r.status < 400;

    if (ok) {
      // Refresh balance after transfer
      const acc = await target.getAccount();
      const newBal = acc.data?.balance_cents ?? acc.data?.data?.balance_cents ?? "?";
      reply(
        `✅ Transfer successful!\n`+
        `  From   : @${target.username}\n`+
        `  To     : @${toUser}\n`+
        `  Amount : ${amount} coins\n`+
        `  Balance: ${newBal} cents remaining`
      );
    } else {
      const errMsg = r.data?.message || r.data?.error || r.data?.msg || JSON.stringify(r.data).slice(0,120);
      reply(`❌ Transfer failed!\n  From: @${target.username} → @${toUser}\n  Error: ${errMsg}`);
    }
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  FEATURE TOGGLES
  // ══════════════════════════════════════════════════════════
  if (/^\|vp\s+on/i.test(cmd))  { target.voucherOn=true;  reply(`✅ Voucher ON @${target.username}`);  return; }
  if (/^\|vp\s+off/i.test(cmd)) { target.voucherOn=false; reply(`⛔ Voucher OFF @${target.username}`); return; }

  const awOnM = cmd.match(/^\|aw\s+on(?:\s+(\d+))?/i);
  if (awOnM) {
    if (awOnM[1]) { target.awRooms.add(Number(awOnM[1])); target.awOn=true; reply(`✅ AW ON room ${awOnM[1]} @${target.username}`); }
    else { target.awOn=true; target.awRooms.clear(); reply(`✅ AW ON all rooms @${target.username}`); }
    return;
  }

  const awOffM = cmd.match(/^\|aw\s+off(?:\s+(\d+))?/i);
  if (awOffM) {
    if (awOffM[1]) { target.awRooms.delete(Number(awOffM[1])); if(!target.awRooms.size) target.awOn=false; reply(`⛔ AW OFF room ${awOffM[1]}`); }
    else { target.awOn=false; target.awRooms.clear(); reply(`⛔ AW OFF @${target.username}`); }
    return;
  }

  const awMsgM = cmd.match(/^\|aw_msg\s+(?:#(\d+)\s+)?(.+)/i);
  if (awMsgM) {
    if (awMsgM[1]) { target.awMessages.set(Number(awMsgM[1]),awMsgM[2]); reply(`✅ AW msg room ${awMsgM[1]}: "${awMsgM[2]}"`); }
    else { target.awTemplate=awMsgM[2]; reply(`✅ AW default: "${awMsgM[2]}"`); }
    return;
  }

  if (/^\|ar\s+on/i.test(cmd))  { target.autoReplyOn=true;  reply(`✅ Auto-reply ON @${target.username}`);  return; }
  if (/^\|ar\s+off/i.test(cmd)) { target.autoReplyOn=false; reply(`⛔ Auto-reply OFF @${target.username}`); return; }

  // ══════════════════════════════════════════════════════════
  //  AUTO-TEXT
  // ══════════════════════════════════════════════════════════
  const atOnM = cmd.match(/^\|at\s+on(?:\s+(\d+))?/i);
  if (atOnM) {
    if (!atOnM[1]) { reply("❌ Specify room: |at on <room_id>"); return; }
    if (!target.autoTextMessages.length) target.autoTextMessages = loadLines("at.txt");
    if (!target.autoTextMessages.length) { reply("❌ at.txt is empty"); return; }
    target.autoTextRooms.add(Number(atOnM[1])); target.autoTextOn=true;
    if (target.isConnected) { target.stopAutoText(); target.startAutoText(); }
    reply(`✅ AT ON room ${atOnM[1]} @${target.username} (${target.autoTextMessages.length} msgs, ${target.autoTextInterval}m)`); return;
  }

  const atOffM = cmd.match(/^\|at\s+off(?:\s+(\d+))?/i);
  if (atOffM) {
    if (atOffM[1]) {
      target.autoTextRooms.delete(Number(atOffM[1]));
      if (!target.autoTextRooms.size) { target.autoTextOn=false; target.stopAutoText(); }
      reply(`⛔ AT OFF room ${atOffM[1]} @${target.username}`);
    } else {
      target.autoTextOn=false; target.autoTextRooms.clear(); target.stopAutoText();
      reply(`⛔ AT OFF @${target.username}`);
    }
    return;
  }

  const atIntM = cmd.match(/^\|at\s+interval\s+(\d+)/i);
  if (atIntM) {
    const m=Number(atIntM[1]); if(m<1){reply("❌ Min 1 minute");return;}
    target.setAutoTextInterval(m); reply(`✅ AT interval ${m}m @${target.username}`); return;
  }

  if (/^\|at\s+reload/i.test(cmd)) {
    target.autoTextMessages=loadLines("at.txt"); target.autoTextIndex.clear();
    if (target.autoTextOn) { target.stopAutoText(); target.startAutoText(); }
    reply(`✅ Reloaded ${target.autoTextMessages.length} msgs from at.txt`); return;
  }

  if (/^\|at\s+status/i.test(cmd)) {
    if (!target.autoTextOn) { reply(`📝 AT OFF @${target.username}`); return; }
    const lines=[`📝 AT @${target.username}:`,`  Msgs:${target.autoTextMessages.length}`,`  Int:${target.autoTextInterval}m`,`  Rooms:${[...target.autoTextRooms].join(",")}`];
    for (const r of target.autoTextRooms) lines.push(`  Room ${r}: ${(target.autoTextIndex.get(r)||0)+1}/${target.autoTextMessages.length}`);
    reply(lines.join("\n")); return;
  }

  // ══════════════════════════════════════════════════════════
  //  PARENT MANAGEMENT (full parent only)
  // ══════════════════════════════════════════════════════════
  const aspM=cmd.match(/^\|asp\s+(\w+)/i); if(aspM&&isFullParent){SUB_PARENT_USERS.add(aspM[1].toLowerCase());reply(`✅ @${aspM[1]} added as sub-parent`);return;}
  const rspM=cmd.match(/^\|rsp\s+(\w+)/i); if(rspM&&isFullParent){SUB_PARENT_USERS.delete(rspM[1].toLowerCase());reply(`✅ @${rspM[1]} removed from sub-parents`);return;}
  const apM =cmd.match(/^\|ap\s+(\w+)/i);  if(apM&&isFullParent){PARENT_USERS.add(apM[1].toLowerCase());reply(`✅ @${apM[1]} added as parent`);return;}
  const rpM =cmd.match(/^\|rp\s+(\w+)/i);  if(rpM&&isFullParent){PARENT_USERS.delete(rpM[1].toLowerCase());reply(`✅ @${rpM[1]} removed from parents`);return;}

  // ══════════════════════════════════════════════════════════
  //  LOWCARD BOT AUTO-PLAY COMMANDS
  // ══════════════════════════════════════════════════════════

  // |lcb on <roomId> $acc   — enable LCB auto-play for account in room
  // |lcb off <roomId> $acc  — disable
  // |lcb off $acc           — disable all rooms for account
  // |lcb status $acc        — show LCB state
  const lcbOnMatch = cmd.match(/^\|lcb\s+on\s+(\d+)/i);
  if (lcbOnMatch) {
    const rid = lcbOnMatch[1];
    const accs = targetAccounts.length ? targetAccounts : [target];
    for (const acc of accs) {
      // Make sure account is in the room first
      if (!acc.joinedRooms.has(Number(rid))) {
        acc.joinRoom(rid);
        // Give a moment to join before enabling LCB
        setTimeout(() => { acc.lcbStart(Number(rid)); }, 1500);
        reply(`✅ @${acc.username} → joining room ${rid} + LCB ON 🃏`);
      } else {
        acc.lcbStart(Number(rid));
        reply(`✅ @${acc.username} → LCB AUTO-PLAY ON in room ${rid} 🃏`);
      }
    }
    return;
  }

  const lcbOffRoomMatch = cmd.match(/^\|lcb\s+off\s+(\d+)/i);
  if (lcbOffRoomMatch) {
    const rid = lcbOffRoomMatch[1];
    const accs = targetAccounts.length ? targetAccounts : [target];
    for (const acc of accs) {
      acc.lcbStop(Number(rid));
      reply(`⛔ @${acc.username} → LCB OFF in room ${rid}`);
    }
    return;
  }

  if (/^\|lcb\s+off/i.test(cmd)) {
    const accs = targetAccounts.length ? targetAccounts : [target];
    for (const acc of accs) {
      const count = acc.lcbRooms.size;
      acc.lcbStopAll();
      reply(`⛔ @${acc.username} → LCB OFF (stopped ${count} room(s))`);
    }
    return;
  }

  if (/^\|lcb\s+status/i.test(cmd)) {
    const accs = targetAccounts.length ? targetAccounts : [target];
    for (const acc of accs) {
      if (!acc.lcbRooms.size) { reply(`🃏 @${acc.username}: LCB OFF (no rooms)`); continue; }
      const lines = [`🃏 @${acc.username} LCB Status:`];
      for (const rid of acc.lcbRooms) {
        const s = acc.lcbState.get(rid);
        lines.push(`  Room ${rid}: phase=${s?.phase||"?"} round=${s?.round||0} joined=${s?.joinedGame||false}`);
      }
      reply(lines.join("\n"));
    }
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  STATUS & HELP
  // ══════════════════════════════════════════════════════════
  if (/^\|status/i.test(cmd)) {
    const motherAcc = accounts.get((USERNAME||"").toLowerCase());
    const motherBlock = motherAcc ? motherAcc.statusText() : `👑 @${USERNAME} (not in accounts)`;
    const subBlocks = [...accounts.values()].filter(a=>!isMother(a.username)).map(a=>a.statusText()).join("\n\n");
    reply(
      `📊 Bot Status\n`+
      `Mother     : @${USERNAME}\n`+
      `Parents    : [${[...PARENT_USERS].join(", ")}]\n`+
      `Sub-Parents: [${[...SUB_PARENT_USERS].join(", ")||"none"}]\n\n`+
      motherBlock + (subBlocks ? "\n\n"+subBlocks : "")
    );
    return;
  }

  if (/^\|help/i.test(cmd)) {
    let h = `📖 Bot Commands\n`;
    h += `  $aa = all sub-accs (skips mother/parent/sub-parent)\n`;
    h += `  $name = specific account\n\n`;
    h += `👥 Accounts (parent only):\n  |lnu user:pass\n  |lnu u1:p1;u2:p2\n  |ltu user\n  |accounts\n\n`;
    h += `🏠 Rooms:\n  |jr <id> $aa / $acc\n  |lr <id> $aa / $acc\n  |lr all $acc\n  |tr <id> <msg> $acc\n  |addroom Name=ID\n  |removeroom Name\n  |listroom\n\n`;
    h += `🌊 Flood:\n  |flood <id> <text> $aa / $acc\n  |autoflood <id> $aa / $acc\n  |flood stop $aa / $acc\n  |flood reload\n\n`;
    h += `📝 Auto-Text (at.txt):\n  |at on <id> $acc\n  |at off [id] $acc\n  |at interval <min>\n  |at reload\n  |at status\n\n`;
    h += `👋 Auto-welcome:\n  |aw on [id] $acc\n  |aw off [id] $acc\n  |aw_msg <text>  (use {username})\n  |aw_msg #<id> <text>\n\n`;
    h += `💬 Auto-reply: |ar on/off $acc\n`;
    h += `🎁 Voucher: |vp on/off $acc\n`;
    h += `👫 Friends & Coins:\n`
    h += `  |sf <user> $acc       → send friend request\n`
    h += `  |af <id> $acc         → accept by request ID\n`
    h += `  |afa $acc             → accept ALL pending requests\n`
    h += `  |fr $acc              → list pending requests\n`
    h += `  |fl $acc              → list friends\n`
    h += `  |balance $acc         → check balance\n`
    h += `  |pin $acc             → check if PIN is set\n`
    h += `  |send <to> <amt> <pin> $acc  → transfer coins\n`
    h += `  |send <to> <amt> <pin> tag $acc  → transfer + announce\n\n`;
    h += `🃏 LowCard Bot Auto-Play:\n`
    h += `  |lcb on <room_id> $acc    → start auto-play in room\n`
    h += `  |lcb off <room_id> $acc   → stop for that room\n`
    h += `  |lcb off $acc             → stop all rooms\n`
    h += `  |lcb status $acc          → show current state\n\n`
    if (isFullParent) h += `⚙️ Parent only:\n  |ap/rp <user>  |asp/rsp <user>\n\n`;
    h += `🔒 Access: Parents=PM+Room  Sub-parents=PM only  $aa=parents only\n`;
    h += `🤖 AI: /a <question> (PM or room)`;
    reply(h); return;
  }

  reply(`❓ Unknown command. Send "|help"`);
}

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  if (!USERNAME)          { console.error("❌ MIG66_USERNAME missing");             process.exit(1); }
  if (!TOKEN && !PASSWORD){ console.error("❌ MIG66_TOKEN or MIG66_PASSWORD needed");process.exit(1); }
  if (AI_PROVIDER==="mistral" && !process.env.MISTRAL_API_KEY)
                          { console.error("❌ MISTRAL_API_KEY missing");             process.exit(1); }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  mig66 AI Bot  ✅ Full Edition v4.1");
  console.log(`  Mother      : ${USERNAME}`);
  console.log(`  Room        : ${ROOM_ID}`);
  console.log(`  Trigger     : ${TRIGGER}`);
  console.log(`  AI          : ${AI_PROVIDER}`);
  console.log(`  Parents     : ${[...PARENT_USERS].join(", ")}`);
  console.log(`  Sub-Parents : ${[...SUB_PARENT_USERS].join(", ")||"none"}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const main = new BotAccount({ username:USERNAME, password:PASSWORD, token:TOKEN||null, isMain:true });
  const ok   = await main.login();
  if (!ok) process.exit(1);

  accounts.set(USERNAME.toLowerCase(), main);
  main.connect(ROOM_ID);

  process.on("SIGINT", () => {
    console.log("\n[*] Shutting down...");
    for (const a of accounts.values()) a.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
