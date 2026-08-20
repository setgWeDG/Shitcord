/* ══════════════════════════════════════════════════════════════
   Shitcord server — Raspberry Pi 4
   Node + express + ws + SQLite.

   Everything that used to live in the browser now lives here:
   passwords are hashed with scrypt and never leave the Pi, private
   channels are enforced server-side, and messages arrive over a
   WebSocket instead of being polled.

     npm install
     node server.js
   ══════════════════════════════════════════════════════════════ */

const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const crypto  = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');

const PORT   = process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'shitcord.db');
const DEFAULT_CHANNELS = ['general', 'ninersmp', 'school', 'memes'];

/* ─────────────────────────── database ─────────────────────────── */
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // survives power loss much better on an SD card
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  name       TEXT PRIMARY KEY,
  salt       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  code_salt  TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  joined     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token   TEXT PRIMARY KEY,
  user    TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  dm      INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  last_at INTEGER NOT NULL DEFAULT 0,
  owner   TEXT
);
/* a room with no rows here is open to everyone */
CREATE TABLE IF NOT EXISTS room_members (
  room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user TEXT NOT NULL,
  PRIMARY KEY (room, user)
);
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  room       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user       TEXT NOT NULL,
  text       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  edited     INTEGER,
  pinned     INTEGER NOT NULL DEFAULT 0,
  sys        TEXT,
  reply_id   TEXT,
  reply_user TEXT,
  reply_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_room ON messages(room, at);
CREATE TABLE IF NOT EXISTS reactions (
  msg   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  user  TEXT NOT NULL,
  PRIMARY KEY (msg, emoji, user)
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY, user TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  post TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user TEXT NOT NULL, PRIMARY KEY (post, user)
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL
);
`);

for (const name of DEFAULT_CHANNELS) {
  db.prepare(`INSERT OR IGNORE INTO rooms (id,name,dm,created,last_at)
              VALUES (?,?,0,?,0)`).run(name, name, Date.now());
}

/* ──────────────────────────── crypto ──────────────────────────── */
const scrypt = (pw, salt) =>
  new Promise((ok, no) =>
    crypto.scrypt(pw, salt, 64, (e, buf) => (e ? no(e) : ok(buf.toString('hex')))));

const rnd = n => crypto.randomBytes(n).toString('hex');

/* constant-time compare so login timing can't leak a valid hash */
function same(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function recoveryCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = n => Array.from(crypto.randomBytes(n), b => A[b % A.length]).join('');
  return [pick(4), pick(4), pick(4)].join('-');
}

const uid = () => Date.now().toString(36) + '-' + rnd(4);
const cleanName = s => String(s || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 20);
const RESERVED = ['admin', 'mod', 'owner', 'root', 'system', 'everyone', 'here'];

/* ──────────────────────────── queries ─────────────────────────── */
const Q = {
  userByName:  db.prepare(`SELECT * FROM users WHERE name = ?`),
  addUser:     db.prepare(`INSERT INTO users (name,salt,hash,code_salt,code_hash,joined)
                           VALUES (@name,@salt,@hash,@code_salt,@code_hash,@joined)`),
  setPassword: db.prepare(`UPDATE users SET salt=?, hash=?, code_salt=?, code_hash=? WHERE name=?`),
  allUsers:    db.prepare(`SELECT name, joined FROM users ORDER BY name`),

  addSession:  db.prepare(`INSERT INTO sessions (token,user,created) VALUES (?,?,?)`),
  getSession:  db.prepare(`SELECT user FROM sessions WHERE token = ?`),
  dropSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),

  allRooms:    db.prepare(`SELECT * FROM rooms`),
  roomById:    db.prepare(`SELECT * FROM rooms WHERE id = ?`),
  roomByName:  db.prepare(`SELECT * FROM rooms WHERE dm = 0 AND name = ?`),
  addRoom:     db.prepare(`INSERT INTO rooms (id,name,dm,created,last_at,owner)
                           VALUES (@id,@name,@dm,@created,0,@owner)`),
  touchRoom:   db.prepare(`UPDATE rooms SET last_at = ? WHERE id = ?`),
  addMember:   db.prepare(`INSERT OR IGNORE INTO room_members (room,user) VALUES (?,?)`),
  membersOf:   db.prepare(`SELECT user FROM room_members WHERE room = ?`),
  isMember:    db.prepare(`SELECT 1 FROM room_members WHERE room = ? AND user = ?`),
  memberCount: db.prepare(`SELECT COUNT(*) n FROM room_members WHERE room = ?`),

  addMsg:      db.prepare(`INSERT INTO messages
                           (id,room,user,text,at,sys,reply_id,reply_user,reply_text)
                           VALUES (@id,@room,@user,@text,@at,@sys,@reply_id,@reply_user,@reply_text)`),
  msgById:     db.prepare(`SELECT * FROM messages WHERE id = ?`),
  history:     db.prepare(`SELECT * FROM (SELECT * FROM messages WHERE room = ?
                           ORDER BY at DESC LIMIT 300) ORDER BY at ASC`),
  editMsg:     db.prepare(`UPDATE messages SET text = ?, edited = ? WHERE id = ?`),
  delMsg:      db.prepare(`DELETE FROM messages WHERE id = ?`),
  pinMsg:      db.prepare(`UPDATE messages SET pinned = ? WHERE id = ?`),

  reactionsOf: db.prepare(`SELECT emoji, user FROM reactions WHERE msg = ?`),
  addReact:    db.prepare(`INSERT OR IGNORE INTO reactions (msg,emoji,user) VALUES (?,?,?)`),
  delReact:    db.prepare(`DELETE FROM reactions WHERE msg=? AND emoji=? AND user=?`),
  hasReact:    db.prepare(`SELECT 1 FROM reactions WHERE msg=? AND emoji=? AND user=?`),

  addPost:     db.prepare(`INSERT INTO posts (id,user,text,at) VALUES (?,?,?,?)`),
  allPosts:    db.prepare(`SELECT * FROM posts ORDER BY at DESC LIMIT 200`),
  postById:    db.prepare(`SELECT * FROM posts WHERE id = ?`),
  delPost:     db.prepare(`DELETE FROM posts WHERE id = ?`),
  likesOf:     db.prepare(`SELECT user FROM likes WHERE post = ?`),
  addLike:     db.prepare(`INSERT OR IGNORE INTO likes (post,user) VALUES (?,?)`),
  delLike:     db.prepare(`DELETE FROM likes WHERE post=? AND user=?`),
  hasLike:     db.prepare(`SELECT 1 FROM likes WHERE post=? AND user=?`),
  addComment:  db.prepare(`INSERT INTO comments (id,post,user,text,at) VALUES (?,?,?,?,?)`),
  commentsOf:  db.prepare(`SELECT * FROM comments WHERE post = ? ORDER BY at ASC`)
};

/* ───────────────────────── shape helpers ──────────────────────── */
function roomMembers(id) {
  const rows = Q.membersOf.all(id);
  return rows.length ? rows.map(r => r.user) : null;   // null = open to everyone
}
function canSee(user, roomId) {
  const r = Q.roomById.get(roomId);
  if (!r) return false;
  if (!Q.memberCount.get(roomId).n) return true;       // open channel
  return !!Q.isMember.get(roomId, user);
}
function roomsFor(user) {
  return Q.allRooms.all()
    .filter(r => canSee(user, r.id))
    .map(r => ({
      id: r.id, name: r.name, dm: !!r.dm, created: r.created,
      lastAt: r.last_at, members: roomMembers(r.id)
    }));
}
function shapeMsg(row) {
  const r = {};
  for (const { emoji, user } of Q.reactionsOf.all(row.id)) (r[emoji] ||= []).push(user);
  const m = {
    id: row.id, user: row.user, text: row.text, at: row.at,
    ed: row.edited || undefined, p: row.pinned ? 1 : undefined,
    sys: row.sys || undefined,
    r: Object.keys(r).length ? r : undefined
  };
  if (row.reply_id) m.re = { id: row.reply_id, user: row.reply_user, text: row.reply_text };
  return m;
}
function shapePost(row) {
  return {
    id: row.id, user: row.user, text: row.text, at: row.at,
    likes: Q.likesOf.all(row.id).map(x => x.user),
    comments: Q.commentsOf.all(row.id)
      .map(c => ({ id: c.id, user: c.user, text: c.text, at: c.at }))
  };
}
const allPosts = () => Q.allPosts.all().map(shapePost);
const userMap  = () => Object.fromEntries(Q.allUsers.all().map(u => [u.name, { joined: u.joined }]));

/* ──────────────────────── http + sessions ─────────────────────── */
const app = express();
app.use(express.json({ limit: '64kb' }));
app.disable('x-powered-by');

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function whoIs(req) {
  const t = parseCookies(req).sc_token;
  if (!t) return null;
  const row = Q.getSession.get(t);
  return row ? row.user : null;
}
function startSession(res, name) {
  const token = rnd(32);
  Q.addSession.run(token, name, Date.now());
  res.setHeader('Set-Cookie',
    `sc_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 365}`);
  return token;
}

app.get('/api/me', (req, res) => {
  const me = whoIs(req);
  me ? res.json({ name: me }) : res.status(401).json({ error: 'not signed in' });
});

app.get('/api/check', (req, res) => {
  const n = cleanName(req.query.name);
  res.json({ taken: !!Q.userByName.get(n) || RESERVED.includes(n) });
});

app.post('/api/signup', async (req, res) => {
  const name = cleanName(req.body.name);
  const pw   = String(req.body.password || '');
  if (name.length < 3)  return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  if (RESERVED.includes(name) || Q.userByName.get(name))
    return res.status(409).json({ error: 'That username is taken.' });
  if (pw.length < 8)    return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const code = recoveryCode();
  const salt = rnd(16), codeSalt = rnd(16);
  Q.addUser.run({
    name, salt, hash: await scrypt(pw, salt),
    code_salt: codeSalt, code_hash: await scrypt(code, codeSalt),
    joined: Date.now()
  });

  /* announce the join in #general */
  const at = Date.now();
  Q.addMsg.run({ id: uid(), room: 'general', user: name, text: '', at,
                 sys: 'join', reply_id: null, reply_user: null, reply_text: null });
  Q.touchRoom.run(at, 'general');

  startSession(res, name);
  broadcastAll({ t: 'users', users: userMap() });
  fanout('general', { t: 'rooms' });
  res.json({ name, code });
});

app.post('/api/login', async (req, res) => {
  const name = cleanName(req.body.name);
  const row  = Q.userByName.get(name);
  if (!row) return res.status(401).json({ error: 'No account with that username.' });
  if (!same(await scrypt(String(req.body.password || ''), row.salt), row.hash))
    return res.status(401).json({ error: 'Wrong password.' });
  startSession(res, name);
  res.json({ name });
});

app.post('/api/recover', async (req, res) => {
  const name = cleanName(req.body.name);
  const row  = Q.userByName.get(name);
  const code = String(req.body.code || '').trim().toUpperCase();
  const pw   = String(req.body.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!row || !same(await scrypt(code, row.code_salt), row.code_hash))
    return res.status(401).json({ error: "That username and recovery code don't match." });

  const next = recoveryCode();
  const salt = rnd(16), codeSalt = rnd(16);
  const [pwHash, codeHash] = await Promise.all([scrypt(pw, salt), scrypt(next, codeSalt)]);
  Q.setPassword.run(salt, pwHash, codeSalt, codeHash, name);
  startSession(res, name);
  res.json({ name, code: next });
});

app.post('/api/logout', (req, res) => {
  const t = parseCookies(req).sc_token;
  if (t) Q.dropSession.run(t);
  res.setHeader('Set-Cookie', 'sc_token=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

/* ── pages ───────────────────────────────────────────────────────
   Served explicitly so a missing file produces a useful message
   instead of Express's bare "Cannot GET /chat.html".              */
function folderListing() {
  try {
    return fs.readdirSync(__dirname)
      .filter(f => !f.startsWith('.') && f !== 'node_modules')
      .sort();
  } catch { return []; }
}
function sendPage(res, file) {
  const full = path.join(__dirname, file);
  if (fs.existsSync(full)) return res.sendFile(full);
  const here = folderListing();
  const close = here.filter(f => f.toLowerCase().replace(/[^a-z]/g, '')
                                  .includes(file.replace('.html', '')));
  res.status(404).type('html').send(`<!DOCTYPE html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{background:#1E1F22;color:#DBDEE1;font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;
      margin:0;padding:40px 20px;display:flex;justify-content:center}
 .k{max-width:620px}
 h1{color:#fff;font-size:22px;margin:0 0 6px}
 code{background:#111214;padding:2px 6px;border-radius:4px;font-size:13.5px}
 ul{background:#2B2D31;border-radius:6px;padding:14px 14px 14px 34px;margin:10px 0}
 li{font-family:ui-monospace,Menlo,monospace;font-size:13.5px}
 .hit{color:#F0B232}
 .note{color:#949BA4;font-size:14px}
</style>
<div class="k">
<h1>Can't find ${file}</h1>
<p class="note">The server is running, but <code>${file}</code> isn't in the folder
it serves from.</p>
<p>Looking in:<br><code>${__dirname}</code></p>
<p>What's actually in there:</p>
<ul>${here.length ? here.map(f =>
   `<li class="${close.includes(f) ? 'hit' : ''}">${f}</li>`).join('')
   : '<li>(empty)</li>'}</ul>
${close.length ? `<p class="note">Those highlighted names look close &mdash; the file is
probably there under the wrong name. Rename it to exactly
<code>${file}</code>.</p>` : `<p class="note">Copy <code>${file}</code> into that folder
and reload this page. No restart needed.</p>`}
</div>`);
}

app.get('/',            (req, res) => sendPage(res, 'index.html'));
app.get('/index.html',  (req, res) => sendPage(res, 'index.html'));
app.get('/chat',        (req, res) => sendPage(res, 'chat.html'));
app.get('/chat.html',   (req, res) => sendPage(res, 'chat.html'));
app.use(express.static(__dirname, { extensions: ['html'] }));
app.use((req, res) => sendPage(res, req.path.replace(/^\//, '') || 'index.html'));

/* ──────────────────────────── sockets ─────────────────────────── */
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });
const live   = new Map();   // ws -> { user }
const typing = new Map();   // user -> { room, at }

server.on('upgrade', (req, socket, head) => {
  const user = whoIs(req);
  if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    live.set(ws, { user });
    wss.emit('connection', ws, req);
  });
});

const online = () => [...new Set([...live.values()].map(v => v.user))];
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcastAll(obj) { for (const ws of live.keys()) send(ws, obj); }

/* only people who can see the room ever receive its traffic */
function fanout(roomId, obj) {
  for (const [ws, v] of live) if (canSee(v.user, roomId)) send(ws, obj);
}
function pushPresence() {
  const now = Date.now();
  const t = {};
  for (const [u, x] of typing) if (now - x.at < 7000) t[u] = x.room;
  broadcastAll({ t: 'presence', online: online(), typing: t });
}
setInterval(pushPresence, 4000);

wss.on('connection', ws => {
  const me = live.get(ws).user;

  send(ws, {
    t: 'hello', me,
    users: userMap(),
    rooms: roomsFor(me),
    posts: allPosts()
  });
  pushPresence();

  ws.on('close', () => { live.delete(ws); typing.delete(me); pushPresence(); });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const now = Date.now();

    switch (m.t) {

      case 'open': {
        if (!canSee(me, m.room)) return;
        send(ws, { t: 'history', room: m.room, messages: Q.history.all(m.room).map(shapeMsg) });
        break;
      }

      case 'msg': {
        const text = String(m.text || '').slice(0, 1000).trim();
        if (!text || !canSee(me, m.room)) return;
        const row = {
          id: uid(), room: m.room, user: me, text, at: now, sys: null,
          reply_id: m.re?.id || null, reply_user: m.re?.user || null,
          reply_text: m.re ? String(m.re.text).slice(0, 200) : null
        };
        Q.addMsg.run(row);
        Q.touchRoom.run(now, m.room);
        typing.delete(me);
        fanout(m.room, { t: 'msg', room: m.room, message: shapeMsg(Q.msgById.get(row.id)) });
        fanout(m.room, { t: 'roomtouch', room: m.room, lastAt: now });
        break;
      }

      case 'edit': {
        const row = Q.msgById.get(m.id);
        if (!row || row.user !== me) return;            // only your own
        Q.editMsg.run(String(m.text || '').slice(0, 1000), now, m.id);
        fanout(row.room, { t: 'update', room: row.room, message: shapeMsg(Q.msgById.get(m.id)) });
        break;
      }

      case 'del': {
        const row = Q.msgById.get(m.id);
        if (!row || row.user !== me) return;
        Q.delMsg.run(m.id);
        fanout(row.room, { t: 'remove', room: row.room, id: m.id });
        break;
      }

      case 'react': {
        const row = Q.msgById.get(m.id);
        if (!row || !canSee(me, row.room)) return;
        const e = String(m.emoji || '').slice(0, 8);
        Q.hasReact.get(m.id, e, me) ? Q.delReact.run(m.id, e, me) : Q.addReact.run(m.id, e, me);
        fanout(row.room, { t: 'update', room: row.room, message: shapeMsg(Q.msgById.get(m.id)) });
        break;
      }

      case 'pin': {
        const row = Q.msgById.get(m.id);
        if (!row || !canSee(me, row.room)) return;
        Q.pinMsg.run(row.pinned ? 0 : 1, m.id);
        fanout(row.room, { t: 'update', room: row.room, message: shapeMsg(Q.msgById.get(m.id)) });
        break;
      }

      case 'typing': {
        if (!canSee(me, m.room)) return;
        typing.set(me, { room: m.room, at: now });
        pushPresence();
        break;
      }

      case 'room': {
        const name = String(m.name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 24);
        if (name.length < 2) return send(ws, { t: 'err', msg: 'Channel names need 2+ characters.' });
        if (Q.roomByName.get(name)) return send(ws, { t: 'err', msg: 'There is already a channel called #' + name + '.' });
        const id = name + '-' + rnd(2);
        Q.addRoom.run({ id, name, dm: 0, created: now, owner: me });
        const picked = Array.isArray(m.members) ? m.members.filter(u => Q.userByName.get(u)) : [];
        if (picked.length) {
          Q.addMember.run(id, me);
          picked.forEach(u => Q.addMember.run(id, u));
        }
        pushRooms();
        send(ws, { t: 'goto', room: id });
        break;
      }

      case 'dm': {
        const other = cleanName(m.user);
        if (!Q.userByName.get(other) || other === me) return;
        const id = 'dm-' + [me, other].sort().join('--');
        if (!Q.roomById.get(id)) {
          Q.addRoom.run({ id, name: id, dm: 1, created: now, owner: me });
          Q.addMember.run(id, me);
          Q.addMember.run(id, other);
        }
        pushRooms();
        send(ws, { t: 'goto', room: id });
        break;
      }

      case 'post': {
        const text = String(m.text || '').slice(0, 600).trim();
        if (!text) return;
        Q.addPost.run(uid(), me, text, now);
        broadcastAll({ t: 'posts', posts: allPosts() });
        break;
      }
      case 'like': {
        if (!Q.postById.get(m.id)) return;
        Q.hasLike.get(m.id, me) ? Q.delLike.run(m.id, me) : Q.addLike.run(m.id, me);
        broadcastAll({ t: 'posts', posts: allPosts() });
        break;
      }
      case 'comment': {
        const text = String(m.text || '').slice(0, 300).trim();
        if (!text || !Q.postById.get(m.id)) return;
        Q.addComment.run(uid(), m.id, me, text, now);
        broadcastAll({ t: 'posts', posts: allPosts() });
        break;
      }
      case 'delpost': {
        const p = Q.postById.get(m.id);
        if (!p || p.user !== me) return;
        Q.delPost.run(m.id);
        broadcastAll({ t: 'posts', posts: allPosts() });
        break;
      }
    }
  });
});

/* rooms are per-user, so everyone gets their own view */
function pushRooms() {
  for (const [ws, v] of live) send(ws, { t: 'rooms', rooms: roomsFor(v.user) });
}

const NEEDED = ['index.html', 'chat.html'];
const missing = NEEDED.filter(f => !fs.existsSync(path.join(__dirname, f)));

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} is already in use.`);
    console.error(`    Shitcord may already be running — try http://localhost:${PORT}`);
    console.error(`    Otherwise stop it:  pkill -f "node server.js"`);
    console.error(`    Or use another port: PORT=8081 node server.js\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\n  ✗ Not allowed to use port ${PORT}. Ports under 1024 need root.`);
    console.error(`    Try:  PORT=8080 node server.js\n`);
  } else {
    console.error('\n  ✗ Could not start:', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  const ip = Object.values(nets).flat()
    .find(n => n && n.family === 'IPv4' && !n.internal)?.address || 'localhost';
  console.log(`\n  Shitcord is up.`);
  console.log(`  On this Pi      http://localhost:${PORT}`);
  console.log(`  On your network http://${ip}:${PORT}`);
  console.log(`  Database        ${DB_PATH}`);
  console.log(`  Serving from    ${__dirname}`);
  if (missing.length) {
    console.log(`\n  ⚠  MISSING: ${missing.join(', ')}`);
    console.log(`     These must sit in the same folder as server.js.`);
    console.log(`     That folder currently holds:`);
    folderListing().forEach(f => console.log(`       ${f}`));
    console.log(`     Copy them in — no restart needed.\n`);
  } else {
    console.log(`  Pages           index.html, chat.html  ✓\n`);
  }
});
