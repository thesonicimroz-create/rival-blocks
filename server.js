'use strict';
/* =====================================================================
 * RIVAL BLOCKS — multiplayer server (Node + Socket.io)
 *
 * Model: "validated relay".
 *  - Clients own their own movement (low latency) and send ~20 Hz state.
 *  - The SERVER owns: rooms, teams, round state machine, HP, damage
 *    numbers, kills, scores and win conditions.
 *  - Clients report hits ("I hit X with weapon W"). The server validates:
 *      * round is live, both players alive, different teams
 *      * weapon is in the attacker's declared loadout
 *      * distance between last-known positions <= weapon range (+ slack)
 *      * fire-rate via a token bucket (stops "infinite fire rate" cheats)
 *    and then computes the damage itself from its own weapon table.
 *  - Known limits: headshot flag and exact aim are client-reported, ammo
 *    is not tracked server-side. Fine for a friends/duel game; a ranked
 *    game would need server-side raycasts against map geometry.
 *
 * Run:  npm install && npm start     (http://localhost:3000)
 * ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const crypto = require('crypto');
const PORT = process.env.PORT || 3000;
/* Admin credentials: override with ADMIN_USER / ADMIN_PASS env vars in production. */
const ADMIN_USER = (process.env.ADMIN_USER || 'sonic_132917').toLowerCase();
const ADMIN_PASS = process.env.ADMIN_PASS || 'Sonicimr_Admin2';
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const FX_CMDS = new Set(['bombbox', 'nukebox', 'blockrain', 'grow', 'giant', 'shrink', 'size', 'normal', 'rainbowify', 'unrainbow', 'fire', 'sparkles', 'unfx', 'fling', 'explode', 'jail', 'unjail', 'speed', 'jump', 'fly', 'nuke', 'gravity', 'boombox', 'float', 'unfloat', 'crops', 'sky', 'disco', 'shockwave', 'burst', 'mutate']);
const INDEX = path.join(__dirname, 'index.html');

/* ---------- tiny static server (index.html only, no path traversal) ---------- */
const httpServer = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); return res.end('index.html missing next to server.js'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  } else if (url === '/health') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const io = new Server(httpServer, {
  cors: { origin: '*' },          // tighten this to your domain in production
  pingInterval: 10000,
  pingTimeout: 8000,
});

/* ---------- shared rules (KEEP IN SYNC with WEAPONS in index.html) ---------- */
const WEAPONS = {
  ar:       { dmg: 17, head: 1.6, interval: 0.095, range: 90 },
  burst:    { dmg: 24, head: 1.7, interval: 0.065, range: 100 },
  sniper:   { dmg: 78, head: 2.2, interval: 1.15,  range: 200 },
  revolver: { dmg: 46, head: 1.8, interval: 0.42,  range: 70 },
  uzi:      { dmg: 10, head: 1.5, interval: 0.052, range: 45 },
  katana:   { dmg: 48, head: 1.0, interval: 0.55,  range: 8 },   // range includes the dash-lunge
};
const PRIMARY = ['ar', 'burst', 'sniper'];
const SECONDARY = ['revolver', 'uzi'];
const MAPS = ['neon', 'sunset', 'yard'];
const WIN_SCORE = 5;
const COUNTDOWN_MS = 3200;
const COUNTDOWN_FIRST_MS = 8000;   // longer first countdown so the spawn cutscene can play
const LIVE_MS = 75000;
const ROUND_END_MS = 3200;
const SPAWNS = { 0: [[-5, 17], [5, 17]], 1: [[5, -17], [-5, -17]] };

/* ---------- state ---------- */
const rooms = new Map();

const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
const cleanName = (n) => String(n || 'Player').replace(/[^\w \-]/g, '').trim().slice(0, 14) || 'Player';

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let tries = 0; tries < 50; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[(Math.random() * letters.length) | 0];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const cap = (r) => (r.mode === '2v2' ? 4 : 2);

function cleanLoadout(l) {
  const p = Array.isArray(l) ? l : [];
  return [PRIMARY.includes(p[0]) ? p[0] : 'ar', SECONDARY.includes(p[1]) ? p[1] : 'revolver', 'katana'];
}

/* ---------- cosmetics (colours / pattern / accessories) are validated, then relayed so everyone sees them ---------- */
const HEXRE = /^#[0-9a-fA-F]{6}$/, COS_PATS = ['solid', 'stripes', 'carbon', 'glitch', 'lava'], COS_ACCS = ['headband', 'headphones', 'halo', 'crown'];
function cleanCos(c) {
  c = c && typeof c === 'object' ? c : {};
  const hx = (v, d) => (typeof v === 'string' && HEXRE.test(v) ? v.toLowerCase() : d);
  return {
    a: hx(c.a, null), b: hx(c.b, null), s: hx(c.s, '#f1c27d'), t: hx(c.t, null),
    p: COS_PATS.includes(c.p) ? c.p : 'solid',
    x: (Array.isArray(c.x) ? c.x : []).filter((v, i, ar) => COS_ACCS.includes(v) && ar.indexOf(v) === i).slice(0, 3),
  };
}

function newPlayer(socket, name, team, loadout, cos) {
  return {
    id: socket.id, name: cleanName(name), team, loadout: cleanLoadout(loadout), cos: cleanCos(cos),
    hp: 100, alive: true, god: false, kills: 0, deaths: 0, dmg: 0,
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, w: 0, f: 0,
    bucket: {}, // per-weapon token bucket {tokens,last}
  };
}

function publicRoom(r) {
  return {
    code: r.code, name: r.name, hostId: r.hostId, mode: r.mode, map: r.map, phase: r.phase,
    players: [...r.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, cos: p.cos })),
  };
}
const emitRoom = (r) => io.to(r.code).emit('room', publicRoom(r));

function pickTeam(r) {
  let a = 0, b = 0;
  r.players.forEach((p) => (p.team === 0 ? a++ : b++));
  return a <= b ? 0 : 1;
}

/* ---------- round state machine ---------- */
function startRound(r) {
  r.round++;
  r.phase = 'countdown';
  const cd = r.round === 1 ? COUNTDOWN_FIRST_MS : COUNTDOWN_MS;
  r.deadline = Date.now() + cd;
  const spawns = {};
  [0, 1].forEach((team) => {
    let i = 0;
    r.players.forEach((p) => {
      if (p.team !== team) return;
      const s = SPAWNS[team][i % SPAWNS[team].length];
      i++;
      p.hp = 100; p.alive = true;
      p.x = s[0]; p.y = 0; p.z = s[1];
      spawns[p.id] = { x: s[0], y: 0, z: s[1], yaw: team === 0 ? 0 : Math.PI };
    });
  });
  io.to(r.code).emit('roundStart', { round: r.round, scores: r.scores.slice(), spawns, cd: cd / 1000 });
}

function endRound(r, win, reason) {
  if (r.phase === 'roundEnd' || r.phase === 'lobby') return;
  r.phase = 'roundEnd';
  r.deadline = Date.now() + ROUND_END_MS;
  if (win >= 0) {
    r.scores[win]++;
    if (r.scores[win] >= WIN_SCORE) r.matchOver = true;
  }
  io.to(r.code).emit('roundEnd', { win, scores: r.scores.slice(), reason });
}

function checkRoundEnd(r) {
  if (r.phase !== 'live') return;
  const alive = [0, 0];
  r.players.forEach((p) => { if (p.alive) alive[p.team]++; });
  if (alive[0] === 0 && alive[1] === 0) endRound(r, -1, 'draw');
  else if (alive[0] === 0) endRound(r, 1, 'elim');
  else if (alive[1] === 0) endRound(r, 0, 'elim');
}

function timeoutRound(r) {
  const hp = [0, 0];
  r.players.forEach((p) => { if (p.alive) hp[p.team] += p.hp; });
  endRound(r, hp[0] === hp[1] ? -1 : hp[0] > hp[1] ? 0 : 1, 'time');
}

function finishMatch(r) {
  const stats = [...r.players.values()].map((p) => ({
    id: p.id, name: p.name, team: p.team, k: p.kills, d: p.deaths, dmg: p.dmg,
  }));
  io.to(r.code).emit('matchEnd', { win: r.scores[0] > r.scores[1] ? 0 : 1, scores: r.scores.slice(), stats });
  r.phase = 'lobby';
  r.matchOver = false;
  emitRoom(r);
}

function applyDamage(r, a, v, wid, head, lunge) {
  if (v.god) return;                      // admin god mode
  const W = WEAPONS[wid];
  const amt = Math.round(W.dmg * (head ? W.head : 1) * (lunge ? 1.35 : 1));
  v.hp = Math.max(0, v.hp - amt);
  a.dmg += amt;
  io.to(r.code).emit('dmg', { t: v.id, a: a.id, hp: v.hp, amt, h: head ? 1 : 0, w: wid });
  if (v.hp <= 0) {
    v.alive = false; v.deaths++; a.kills++;
    io.to(r.code).emit('kill', { v: v.id, a: a.id, w: wid, h: head ? 1 : 0 });
    checkRoundEnd(r);
  }
}

/* token bucket: allows small network bursts but caps sustained fire rate */
function allowShot(p, wid) {
  const W = WEAPONS[wid];
  const now = Date.now();
  const b = p.bucket[wid] || (p.bucket[wid] = { tokens: 3, last: now });
  b.tokens = Math.min(3, b.tokens + (now - b.last) / (W.interval * 800));
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function removePlayer(socket) {
  const code = socket.data.room;
  if (!code) return;
  socket.leave(code);
  socket.data.room = null;
  const r = rooms.get(code);
  if (!r) return;
  r.players.delete(socket.id);
  if (r.players.size === 0) { rooms.delete(code); return; }
  if (r.hostId === socket.id) r.hostId = r.players.keys().next().value;
  io.to(code).emit('playerLeft', { id: socket.id });
  if (r.phase !== 'lobby') {
    const teams = [0, 0];
    r.players.forEach((p) => teams[p.team]++);
    if (teams[0] === 0 || teams[1] === 0) {
      r.scores[teams[0] === 0 ? 1 : 0] = WIN_SCORE; // remaining team wins by forfeit
      finishMatch(r);
      return;
    }
    checkRoundEnd(r);
  }
  emitRoom(r);
}

/* ---------- public room list (server browser) ---------- */
const cleanRoomName = (n) => String(n || '').replace(/[^\w \-!'.]/g, '').trim().slice(0, 24);
function roomSummary(r) {
  const host = r.players.get(r.hostId);
  return { code: r.code, name: r.name, players: r.players.size, max: cap(r), map: r.map, mode: r.mode, phase: r.phase, host: host ? host.name : '?', pub: r.pub };
}
const roomListPublic = () => [...rooms.values()].filter((r) => r.pub).map(roomSummary);
const roomListAll = () => [...rooms.values()].map(roomSummary);
let lastRoomSig = '';
setInterval(() => {                       // push the list to browsing clients only when it changes
  const list = roomListPublic(), sig = JSON.stringify(list);
  if (sig !== lastRoomSig) { lastRoomSig = sig; io.to('__browser').emit('roomList', list); }
}, 1000);

/* ---------- sockets ---------- */
/* ---------- friends & presence (in-memory; a server restart clears pending requests) ---------- */
const users = new Map();     // friend code -> socket id
const inbox = new Map();     // friend code -> requests / acceptances waiting for them to come online
const watchers = new Map();  // friend code -> Set(socket ids that want its presence)
const lastPres = new Map();  // friend code -> last presence JSON, for change detection
const FCODE = /^[A-Z0-9]{6}$/;
function sockOf(code) { const id = users.get(code); return id ? io.sockets.sockets.get(id) : null; }
function presenceOf(code) {
  const s = sockOf(code);
  if (!s) return { code, st: 'offline' };
  const r = rooms.get(s.data.room);
  if (!r) return { code, name: s.data.fname, st: 'menu' };
  return { code, name: s.data.fname, st: r.phase === 'lobby' ? 'lobby' : 'match', room: r.code, join: r.phase === 'lobby' && r.players.size < cap(r) };
}
function setWatch(socket, list) {
  (socket.data.watch || []).forEach((c) => { const w = watchers.get(c); if (w) w.delete(socket.id); });
  socket.data.watch = (Array.isArray(list) ? list : []).map((c) => String(c).toUpperCase()).filter((c) => FCODE.test(c)).slice(0, 100);
  socket.data.watch.forEach((c) => { if (!watchers.has(c)) watchers.set(c, new Set()); watchers.get(c).add(socket.id); });
}
function dropUser(socket) {
  const c = socket.data.fcode;
  if (c && users.get(c) === socket.id) users.delete(c);
  setWatch(socket, []);
}
function queueInbox(code, rec) {
  const q = inbox.get(code) || [];
  if (!q.some((x) => x.t === rec.t && x.from.code === rec.from.code)) q.push(rec);
  inbox.set(code, q.slice(-50));
}

io.on('connection', (socket) => {
  socket.data.room = null; socket.data.admin = false; socket.data.tries = 0; socket.data.lastChat = 0;

  socket.on('create', (data, cb) => {
    if (typeof cb !== 'function') return;
    data = data || {};
    removePlayer(socket);
    const code = makeCode();
    if (!code) return cb({ ok: false, error: 'Server busy, try again' });
    const r = {
      code, hostId: socket.id,
      name: cleanRoomName(data.room) || (cleanName(data.name) + "'s room"), pub: data.pub !== false,
      mode: data.mode === '2v2' ? '2v2' : '1v1',
      map: MAPS.includes(data.map) ? data.map : 'neon',
      players: new Map(), phase: 'lobby', round: 0, scores: [0, 0], deadline: 0, matchOver: false,
    };
    r.players.set(socket.id, newPlayer(socket, data.name, 0, data.loadout, data.cos));
    rooms.set(code, r);
    socket.join(code);
    socket.data.room = code;
    cb({ ok: true, id: socket.id, room: publicRoom(r) });
  });

  socket.on('join', (data, cb) => {
    if (typeof cb !== 'function') return;
    data = data || {};
    const code = String(data.code || '').toUpperCase().trim();
    const r = rooms.get(code);
    if (!r) return cb({ ok: false, error: 'Room not found' });
    if (r.phase !== 'lobby') return cb({ ok: false, error: 'Match already in progress' });
    if (r.players.size >= cap(r)) return cb({ ok: false, error: 'Room is full' });
    removePlayer(socket);
    r.players.set(socket.id, newPlayer(socket, data.name, pickTeam(r), data.loadout, data.cos));
    socket.join(code);
    socket.data.room = code;
    cb({ ok: true, id: socket.id, room: publicRoom(r) });
    emitRoom(r);
  });

  socket.on('config', (data) => {
    const r = rooms.get(socket.data.room);
    if (!r || r.hostId !== socket.id || r.phase !== 'lobby' || !data) return;
    if (MAPS.includes(data.map)) r.map = data.map;
    if ((data.mode === '1v1' || data.mode === '2v2') && (data.mode === '2v2' || r.players.size <= 2)) {
      r.mode = data.mode;
    }
    emitRoom(r);
  });

  socket.on('cos', (c) => {
    const r = rooms.get(socket.data.room), p = r && r.players.get(socket.id);
    if (p && r.phase === 'lobby') { p.cos = cleanCos(c); emitRoom(r); }
  });

  socket.on('loadout', (l) => {
    const r = rooms.get(socket.data.room);
    const p = r && r.players.get(socket.id);
    if (p && r.phase === 'lobby') p.loadout = cleanLoadout(l);
  });

  socket.on('start', () => {
    const r = rooms.get(socket.data.room);
    if (!r || r.hostId !== socket.id || r.phase !== 'lobby') return;
    const t = [0, 0];
    r.players.forEach((p) => t[p.team]++);
    if (t[0] < 1 || t[1] < 1) {
      socket.emit('err', 'Need at least one player on each team');
      return;
    }
    r.scores = [0, 0]; r.round = 0; r.matchOver = false;
    r.players.forEach((p) => { p.kills = 0; p.deaths = 0; p.dmg = 0; p.bucket = {}; });
    io.to(r.code).emit('start', {
      map: r.map, mode: r.mode,
      players: [...r.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, cos: p.cos })),
    });
    startRound(r);
  });

  socket.on('state', (s) => {
    const r = rooms.get(socket.data.room);
    const p = r && r.players.get(socket.id);
    if (!p || !s) return;
    p.x = clampN(num(s.x), -40, 40); p.y = clampN(num(s.y), -5, 30); p.z = clampN(num(s.z), -40, 40);
    p.yaw = num(s.r); p.pitch = clampN(num(s.p), -1.6, 1.6);
    p.w = num(s.w) | 0; p.f = num(s.f) | 0;
  });

  socket.on('fire', (d) => {
    const r = rooms.get(socket.data.room);
    const p = r && r.players.get(socket.id);
    if (!p || !d || !p.alive || (r.phase !== 'live')) return;
    if (!p.loadout.includes(d.w) || !Array.isArray(d.o) || !Array.isArray(d.d)) return;
    socket.to(r.code).emit('fire', { i: socket.id, o: d.o.slice(0, 3).map((n) => num(n)), d: d.d.slice(0, 3).map((n) => num(n)), w: d.w });
  });

  socket.on('hit', (d) => {
    const r = rooms.get(socket.data.room);
    if (!r || r.phase !== 'live' || !d) return;
    const a = r.players.get(socket.id);
    const v = r.players.get(d.t);
    const W = WEAPONS[d.w];
    if (!a || !v || !W || !a.alive || !v.alive || a.team === v.team) return;
    if (!a.loadout.includes(d.w)) return;
    const dist = Math.hypot(a.x - v.x, (a.y - v.y) * 0.5, a.z - v.z);
    if (dist > W.range + 4) return;                 // 4 m of latency slack
    if (!allowShot(a, d.w)) return;
    const head = d.h && d.w !== 'katana';
    applyDamage(r, a, v, d.w, !!head, d.w === 'katana' && !!d.L);
  });

  /* --- server browser --- */
  socket.on('browse', (_d, cb) => { socket.join('__browser'); if (typeof cb === 'function') cb(roomListPublic()); });
  socket.on('unbrowse', () => socket.leave('__browser'));

  /* --- chat (room scope, or "/g" global scope), 500 ms rate limit --- */
  socket.on('chat', (d) => {
    if (!d) return;
    const now = Date.now(); if (now - socket.data.lastChat < 500) return; socket.data.lastChat = now;
    const text = String(d.t || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 140); if (!text) return;
    const r = rooms.get(socket.data.room), p = r && r.players.get(socket.id);
    const msg = { n: p ? p.name : 'Guest', t: text, a: socket.data.admin ? 1 : 0, g: d.g ? 1 : 0 };
    if (d.g) io.emit('chat', msg); else if (r) io.to(r.code).emit('chat', msg);
  });

  /* --- admin (re-checked on the server; max 5 login attempts per connection) --- */
  socket.on('adminLogin', (d, cb) => {
    if (typeof cb !== 'function') return;
    if (!d || ++socket.data.tries > 5) return cb(false);
    const uu = String(d.u || '').trim().toLowerCase(), ok = safeEq(uu, ADMIN_USER) && safeEq(d.p || '', ADMIN_PASS);
    socket.data.admin = !!ok; cb(!!ok);
  });
  socket.on('admin', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    if (!socket.data.admin || !d) return cb('Not authorised');
    const r = rooms.get(socket.data.room), me = r && r.players.get(socket.id); if (!r || !me) return cb('Join a room first');
    switch (d.cmd) {
      case 'god': me.god = d.arg === 'on' ? true : d.arg === 'off' ? false : !me.god; return cb('god ' + (me.god ? 'ON' : 'OFF'));
      case 'heal': r.players.forEach((p) => { if (p.alive) { p.hp = 100; io.to(r.code).emit('dmg', { t: p.id, a: p.id, hp: 100, amt: 0, h: 0, w: 'ar' }); } }); return cb('everyone healed');
      case 'skip': if (r.phase !== 'live') return cb('round is not live'); endRound(r, me.team, 'admin'); return cb('round skipped');
      case 'announce': io.to(r.code).emit('announce', String(d.arg || '').slice(0, 120)); return cb('announced');
      case 'kick': {
        const name = String(d.arg || '').toLowerCase(); const t = [...r.players.values()].find((p) => p.id !== socket.id && p.name.toLowerCase() === name);
        if (!t) return cb('no such player'); const ts = io.sockets.sockets.get(t.id); if (ts) { ts.emit('kicked'); removePlayer(ts); } return cb('kicked ' + t.name);
      }
      default: return cb('unknown command');
    }
  });
  /* relay a visual/physics admin effect to everyone in the room; each client applies it locally */
  socket.on('adminfx', (d) => {
    if (!socket.data.admin || !d || !FX_CMDS.has(d.cmd)) return;
    const r = rooms.get(socket.data.room); if (!r || r.phase === 'lobby') return;
    const targets = (Array.isArray(d.targets) ? d.targets : []).slice(0, 8).map((x) => String(x).slice(0, 40));
    io.to(r.code).emit('adminfx', { cmd: d.cmd, targets, arg: String(d.arg || '').slice(0, 12), seed: num(d.seed, 1) | 0 });
  });
  /* events / giveaways / coin gifts: admin-only kinds are re-checked here; 'got' and 'gjoin' are open to the room. Everything is sanitised and echoed to the whole room (sender included). */
  const EV_ADMIN = new Set(['estart', 'estop', 'gstart', 'gcancel', 'gwin', 'coins']), EV_OPEN = new Set(['got', 'gjoin']);
  const ci = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10) || 0));
  socket.on('evt', (d) => {
    if (!d || typeof d.k !== 'string') return;
    const r = rooms.get(socket.data.room); if (!r || r.phase === 'lobby') return;
    const adm = EV_ADMIN.has(d.k); if (!adm && !EV_OPEN.has(d.k)) return; if (adm && !socket.data.admin) return;
    const now = Date.now(); if (now - (socket.data.lastEvt || 0) < 100) return; socket.data.lastEvt = now;
    const m = { k: d.k, from: socket.id }, clean = (x, n) => String(x == null ? '' : x).replace(/[\u0000-\u001f<>]/g, '').slice(0, n);
    switch (d.k) {
      case 'estart': if (!['survive', 'blitz', 'hunt'].includes(d.kind)) return; m.kind = d.kind; m.reward = ci(d.reward, 0, 1000000); m.secs = ci(d.secs, 0, 300); m.seed = num(d.seed, 1) | 0; break;
      case 'gstart': { const p = d.prize || {}; if (!['coins', 'title', 'skin', 'cos'].includes(p.k)) return; m.prize = { k: p.k, v: p.k === 'coins' ? ci(p.v, 1, 1000000) : clean(p.v, 24), label: clean(p.label, 40) }; m.secs = ci(d.secs, 5, 300); break; }
      case 'gwin': m.id = d.id ? clean(d.id, 40) : null; m.name = clean(d.name, 20); break;
      case 'coins': m.to = (Array.isArray(d.to) ? d.to : []).slice(0, 12).map((x) => clean(x, 40)); m.n = ci(d.n, -1000000, 1000000); break;
      case 'got': m.i = ci(d.i, 0, 63); break;
      case 'gjoin': { const p = r.players.get(socket.id); m.name = p ? p.name : 'Guest'; break; }
    }
    io.to(r.code).emit('evt', m);
  });
  socket.on('adminRooms', (_d, cb) => { if (typeof cb === 'function') cb(socket.data.admin ? roomListAll() : []); });
  socket.on('adminClose', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    if (!socket.data.admin || !d) return cb('Not authorised');
    const r = rooms.get(String(d.code || '').toUpperCase()); if (!r) return cb('room not found');
    [...r.players.keys()].forEach((id) => { const ts = io.sockets.sockets.get(id); if (ts) { ts.emit('kicked'); removePlayer(ts); } });
    rooms.delete(r.code); cb('room ' + r.code + ' closed');
  });

  /* --- friends --- */
  const socOk = () => { const n = Date.now(); if (n - (socket.data.lastSoc || 0) < 300) return false; socket.data.lastSoc = n; return true; };
  socket.on('hello', (d, cb) => {
    d = d || {};
    const code = String(d.code || '').toUpperCase();
    if (!FCODE.test(code)) { if (typeof cb === 'function') cb({ ok: false }); return; }
    dropUser(socket);
    socket.data.fcode = code; socket.data.fname = cleanName(d.name); users.set(code, socket.id); setWatch(socket, d.friends);
    const mine = inbox.get(code) || []; inbox.delete(code);
    if (typeof cb === 'function') cb({ ok: true, presence: socket.data.watch.map(presenceOf), inbox: mine });
  });
  socket.on('watch', (d) => setWatch(socket, d && d.friends));
  socket.on('friendReq', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const me = socket.data.fcode; if (!me) return cb({ ok: false, error: 'Not registered yet — try again' });
    if (!socOk()) return cb({ ok: false, error: 'Slow down' });
    const q = String((d && d.to) || '').trim(); let to = q.toUpperCase();
    if (!users.has(to)) {
      const byName = [...users.keys()].find((c) => { const s2 = sockOf(c); return s2 && String(s2.data.fname).toLowerCase() === q.toLowerCase(); });
      if (byName) to = byName; else if (!FCODE.test(to)) return cb({ ok: false, error: 'No online player with that name — use their friend code' });
    }
    if (to === me) return cb({ ok: false, error: "That's your own code" });
    const from = { code: me, name: socket.data.fname }, ts = sockOf(to);
    if (ts) ts.emit('friendReq', from); else queueInbox(to, { t: 'req', from });
    cb({ ok: true, code: to, name: ts ? ts.data.fname : to, online: !!ts });
  });
  socket.on('friendAccept', (d, cb) => {
    const me = socket.data.fcode, to = String((d && d.to) || '').toUpperCase(); if (!me || !FCODE.test(to)) return;
    const from = { code: me, name: socket.data.fname }, ts = sockOf(to);
    if (ts) ts.emit('friendAccepted', from); else queueInbox(to, { t: 'acc', from });
    if (typeof cb === 'function') cb({ ok: true, presence: presenceOf(to) });
  });
  socket.on('invite', (d, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const me = socket.data.fcode, r = rooms.get(socket.data.room);
    if (!me || !r) return cb({ ok: false, error: 'Create or join a room first' });
    if (r.phase !== 'lobby') return cb({ ok: false, error: 'Match already started' });
    if (!socOk()) return cb({ ok: false, error: 'Slow down' });
    const ts = sockOf(String((d && d.to) || '').toUpperCase());
    if (!ts) return cb({ ok: false, error: 'Friend is offline' });
    ts.emit('invite', { from: socket.data.fname, fromCode: me, room: r.code, name: r.name });
    cb({ ok: true });
  });

  socket.on('leave', () => removePlayer(socket));
  socket.on('disconnect', () => { removePlayer(socket); dropUser(socket); });
});

/* ---------- 20 Hz tick: phase timers + state broadcast ---------- */
setInterval(() => {
  const now = Date.now();
  rooms.forEach((r) => {
    if (r.phase === 'lobby') return;
    if (r.phase === 'countdown' && now >= r.deadline) {
      r.phase = 'live';
      r.deadline = now + LIVE_MS;
      io.to(r.code).emit('phase', { phase: 'live', dur: LIVE_MS / 1000 });
    } else if (r.phase === 'live' && now >= r.deadline) {
      timeoutRound(r);
    } else if (r.phase === 'roundEnd' && now >= r.deadline) {
      if (r.matchOver) finishMatch(r); else startRound(r);
    }
    if (r.phase === 'lobby') return;
    const list = [];
    r.players.forEach((p) => list.push({
      i: p.id,
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
      r: +p.yaw.toFixed(3), p: +p.pitch.toFixed(3), w: p.w, f: p.f,
    }));
    io.to(r.code).emit('states', list);
  });
}, 50);

/* presence diffs: pushed to everyone watching that friend code, at most once a second */
setInterval(() => {
  watchers.forEach((set, code) => {
    if (set.size === 0) { watchers.delete(code); lastPres.delete(code); return; }
    const p = presenceOf(code), j = JSON.stringify(p);
    if (lastPres.get(code) === j) return;
    lastPres.set(code, j);
    set.forEach((sid) => { const s2 = io.sockets.sockets.get(sid); if (s2) s2.emit('presence', [p]); });
  });
}, 1000);

httpServer.listen(PORT, () => console.log('Rival Blocks server on http://localhost:' + PORT));
