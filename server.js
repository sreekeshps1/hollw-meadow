"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, "data"); // point at a persistent disk in production
const FILE = path.join(DATA, "accounts.json");
fs.mkdirSync(DATA, { recursive: true });

/* ───── LAYER 1 · ACCOUNTS (JSON file; swap for SQLite/Postgres later) ───── */
let accounts = {};
try { accounts = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) {}
let dirty = false;
const online = new Map(); // lowercase name -> player
const flush = () => {
  if (!dirty) return; dirty = false;
  try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(accounts)); fs.renameSync(FILE + ".tmp", FILE); } catch (e) { console.error(e); }
};
setInterval(flush, 5000);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { for (const p of online.values()) save(p); flush(); process.exit(0); });

const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, k) => e ? rej(e) : res(k)));
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const clampInt = (v, n) => Math.min(n - 1, Math.max(0, v | 0));
const cleanLook = l => ({ skin: clampInt(l && l.skin, 4), hair: clampInt(l && l.hair, 5), shirt: clampInt(l && l.shirt, 6) });
function fail(ws, msg) { send(ws, { t: "err", msg }); if ((ws.fails = (ws.fails || 0) + 1) >= 8) ws.close(); }

/* ───── LAYER 2 · WORLD (maps, collision, portals) ───── */
const T = 24, W = 30, H = 20, SPEED = 70;
const rng = s => () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
const grid = f => Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => f(x, y)));
const edge = (x, y) => x === 0 || y === 0 || x === W - 1 || y === H - 1;
// tiles: 0 grass, 1 water, 2 tree, 3 path, 4 sand, 5 house, 6 door
function meadow() {
  const r = rng(7);
  const t = grid((x, y) => edge(x, y) ? 2 : (x - 6) ** 2 / 16 + (y - 13) ** 2 / 9 < 1 ? 1 : (x - 6) ** 2 / 25 + (y - 13) ** 2 / 16 < 1 ? 4 : (y === 10 || x === 15) ? 3 : r() < .08 ? 2 : 0);
  t[10][W - 1] = 3; return t;
}
function village() {
  const r = rng(11);
  const t = grid((x, y) => edge(x, y) ? 2 : (y === 10 || x === 15) ? 3 : r() < .04 ? 2 : 0);
  for (const [hx, hy] of [[4, 3], [10, 3], [18, 3], [24, 3], [4, 14], [22, 14]]) {
    for (let y = hy; y < hy + 3; y++) for (let x = hx; x < hx + 4; x++) t[y][x] = 5;
    t[hy + 2][hx + 1] = 6;
  }
  t[10][0] = 3; return t;
}
// To add a map: create tiles, add an entry here, and link portals in both directions.
const MAPS = {
  meadow: { name: "Hollow Meadow", tiles: meadow(), portals: [{ x: W - 1, y: 10, to: "village", tx: 1, ty: 10 }], spawn: [15, 10] },
  village: { name: "Lantern Village", tiles: village(), portals: [{ x: 0, y: 10, to: "meadow", tx: W - 2, ty: 10 }], spawn: [15, 10] }
};
const solid = (m, px, py) => { const t = (MAPS[m].tiles[Math.floor(py / T)] || [])[Math.floor(px / T)]; return t === undefined || t === 1 || t === 2 || t === 5; };
const blocked = (m, x, y) => solid(m, x - 6, y - 2) || solid(m, x + 6, y - 2) || solid(m, x - 6, y + 6) || solid(m, x + 6, y + 6);
const mapMsg = id => ({ t: "map", id, name: MAPS[id].name, tiles: MAPS[id].tiles, portals: MAPS[id].portals.map(({ x, y }) => ({ x, y })) });

/* ───── LAYER 3 · PLAYERS (join, leave, auth) ───── */
function save(p) { const a = p.a; a.map = p.map; a.x = p.x; a.y = p.y; a.look = p.look; dirty = true; }
function leave(ws) { const p = ws.p; if (!p) return; save(p); online.delete(p.key); ws.p = null; }
function join(ws, key, a) {
  const old = online.get(key);
  if (old) { send(old.ws, { t: "err", msg: "You logged in from another place." }); save(old); online.delete(key); old.ws.p = null; old.ws.close(); }
  const p = { ws, key, a, name: a.name, gender: a.gender, look: a.look, map: MAPS[a.map] ? a.map : "meadow", x: a.x, y: a.y, dx: 0, dy: 0, say: "", sayUntil: 0, lastChat: 0 };
  if (blocked(p.map, p.x, p.y)) { p.x = (MAPS[p.map].spawn[0] + .5) * T; p.y = (MAPS[p.map].spawn[1] + .5) * T; }
  ws.p = p; online.set(key, p);
  send(ws, { t: "welcome", name: p.name, gender: p.gender, look: p.look });
  send(ws, mapMsg(p.map));
}
async function auth(ws, m) {
  if (ws.busy) return; ws.busy = true;
  try {
    const name = String(m.name || "").trim(), pw = String(m.pw || ""), key = name.toLowerCase();
    let a;
    if (m.t === "register") {
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return fail(ws, "Use 3–16 letters, numbers or underscores for the name.");
      if (pw.length < 6 || pw.length > 72) return fail(ws, "Use 6–72 characters for the password.");
      if (!["male", "female", "other"].includes(m.gender)) return fail(ws, "Choose a gender.");
      if (accounts[key]) return fail(ws, "That character name is taken. Try another.");
      const salt = crypto.randomBytes(16), hash = (await scrypt(pw, salt)).toString("hex");
      if (accounts[key]) return fail(ws, "That character name is taken. Try another.");
      a = accounts[key] = { name, gender: m.gender, salt: salt.toString("hex"), hash, look: { skin: 0, hair: 0, shirt: { male: 0, female: 1, other: 2 }[m.gender] }, map: "meadow", x: 15.5 * T, y: 10.5 * T };
      dirty = true;
    } else {
      a = accounts[key];
      const ok = a && crypto.timingSafeEqual(await scrypt(pw, Buffer.from(a.salt, "hex")), Buffer.from(a.hash, "hex"));
      if (!ok) return fail(ws, "Name or password is incorrect.");
    }
    join(ws, key, a);
  } catch (e) { console.error(e); fail(ws, "Something went wrong. Try again."); }
  finally { ws.busy = false; }
}

/* ───── LAYER 4 · GAME TICK (20 Hz, server-authoritative movement) ───── */
setInterval(() => {
  const dt = 1 / 20, now = Date.now();
  for (const p of online.values()) {
    if (p.dx || p.dy) {
      const s = SPEED * dt * (p.dx && p.dy ? .7071 : 1), nx = p.x + p.dx * s, ny = p.y + p.dy * s;
      if (!blocked(p.map, nx, p.y)) p.x = nx;
      if (!blocked(p.map, p.x, ny)) p.y = ny;
      const tx = Math.floor(p.x / T), ty = Math.floor(p.y / T);
      const g = MAPS[p.map].portals.find(o => o.x === tx && o.y === ty);
      if (g) { p.map = g.to; p.x = (g.tx + .5) * T; p.y = (g.ty + .5) * T; send(p.ws, mapMsg(p.map)); }
    }
    if (p.say && now > p.sayUntil) p.say = "";
  }
  const by = {};
  for (const p of online.values()) (by[p.map] || (by[p.map] = [])).push(p);
  for (const id in by) {
    const msg = JSON.stringify({ t: "s", p: by[id].map(p => [p.name, p.gender, p.look, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, p.say]) });
    for (const p of by[id]) if (p.ws.readyState === 1) p.ws.send(msg);
  }
}, 50);
setInterval(() => { // player counts for the world map
  const maps = Object.keys(MAPS).map(id => ({ id, name: MAPS[id].name, n: [...online.values()].filter(p => p.map === id).length }));
  const msg = JSON.stringify({ t: "world", maps });
  for (const p of online.values()) if (p.ws.readyState === 1) p.ws.send(msg);
}, 2000);

/* ───── LAYER 5 · NETWORK (HTTP + WebSocket) ───── */
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (url === "/" || url === "/index.html") {
    return fs.readFile(path.join(__dirname, "public", "index.html"), (e, d) => {
      if (e) { res.writeHead(500); return res.end("Error"); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(d);
    });
  }
  res.writeHead(404); res.end("Not found");
});
const wss = new WebSocketServer({ server, maxPayload: 2048 });
wss.on("connection", ws => {
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    const p = ws.p;
    if (!p) { if (m.t === "login" || m.t === "register") auth(ws, m); return; }
    if (m.t === "in") { p.dx = Math.sign(+m.dx) || 0; p.dy = Math.sign(+m.dy) || 0; }
    else if (m.t === "look") { p.look = cleanLook(m.look); p.a.look = p.look; dirty = true; }
    else if (m.t === "chat") {
      const text = String(m.text || "").replace(/\s+/g, " ").trim().slice(0, 120), now = Date.now();
      if (!text || now - p.lastChat < 700) return;
      p.lastChat = now; p.say = text; p.sayUntil = now + 5000;
      for (const q of online.values()) if (q.map === p.map) send(q.ws, { t: "chat", from: p.name, text });
    }
  });
  ws.on("close", () => leave(ws));
  ws.on("error", () => {});
});
server.listen(PORT, () => console.log("Hollow Meadow listening on " + PORT));
