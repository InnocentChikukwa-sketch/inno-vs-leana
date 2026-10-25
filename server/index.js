// Game room accounts server
// - unique usernames across the whole site (case-insensitive)
// - passwords stored as scrypt hashes, never in plain text
// - "stay signed in" tokens (only a hash of each token is stored)
// - invite a partner by username; accepted pairs get a private room key that only the two of them receive
// - optional welcome email through Brevo (username only, never the password)
"use strict";
const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "";            // a sender address verified in Brevo
const ADMIN_KEY = process.env.ADMIN_KEY || "";             // the password for admin.html; admin is switched off until it is set
const SITE_URL = process.env.SITE_URL || "https://inno-vs-leana.onrender.com/";

if (!DATABASE_URL) console.error("DATABASE_URL is not set yet: accounts are switched off until it is");
const pool = DATABASE_URL && new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1|@dpg-[^.:/]+(\/|:|$)/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 5,
});

/* ---------- database ---------- */
async function migrate() {
  await pool.query(`
    create table if not exists users(
      id serial primary key,
      username text not null,
      pass_hash text not null,
      email text,
      created_at timestamptz not null default now());
    create unique index if not exists users_username_lower on users (lower(username));
    create table if not exists sessions(
      token_hash text primary key,
      user_id int not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      last_seen timestamptz not null default now());
    create table if not exists pairs(
      id serial primary key,
      user_lo int not null references users(id) on delete cascade,
      user_hi int not null references users(id) on delete cascade,
      room_key text not null unique,
      created_at timestamptz not null default now(),
      unique(user_lo, user_hi));
    create table if not exists invites(
      from_id int not null references users(id) on delete cascade,
      to_id int not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key(from_id, to_id));
    create table if not exists presence(
      user_id int primary key references users(id) on delete cascade,
      game text not null default 'home',
      last_ping timestamptz not null default now());
    create table if not exists activity(
      day date not null,
      user_id int not null references users(id) on delete cascade,
      game text not null,
      primary key(day, user_id, game));
  `);
}

/* ---------- helpers ---------- */
const RESERVED = new Set(["admin", "root", "system", "support", "help", "api", "null", "undefined", "game", "games", "gameroom", "moderator"]);
function checkUsername(u) {
  u = String(u || "").trim();
  if (u.length < 3) return [null, "Usernames need at least 3 characters."];
  if (u.length > 20) return [null, "Usernames can be at most 20 characters."];
  if (!/^[A-Za-z0-9_.]+$/.test(u)) return [null, "Use only letters, numbers, dots and underscores."];
  if (/^[._]|[._]$/.test(u)) return [null, "Usernames can't start or end with a dot or underscore."];
  if (RESERVED.has(u.toLowerCase())) return [null, "That username is reserved. Try another."];
  return [u, null];
}
function checkEmail(e) {
  e = String(e || "").trim();
  if (!e) return [null, null];
  if (e.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return [null, "That email address doesn't look right."];
  return [e, null];
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split("$");
  if (alg !== "scrypt") return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(keyHex, "hex");
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
async function newSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query("insert into sessions(token_hash,user_id) values($1,$2)", [sha(token), userId]);
  return token;
}
async function userFromReq(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!m) return null;
  const r = await pool.query(
    "update sessions set last_seen=now() where token_hash=$1 returning user_id", [sha(m[1].trim())]);
  if (!r.rowCount) return null;
  const u = await pool.query("select id, username, email from users where id=$1", [r.rows[0].user_id]);
  return u.rows[0] || null;
}
async function findUser(name) {
  const r = await pool.query("select id, username from users where lower(username)=lower($1)", [String(name || "").trim()]);
  return r.rows[0] || null;
}

// simple per-IP limit for sign-up and log-in attempts
const hits = new Map();
function limited(req, key, max = 20, windowMs = 10 * 60 * 1000) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const k = key + "|" + ip, now = Date.now();
  const list = (hits.get(k) || []).filter((t) => now - t < windowMs);
  list.push(now); hits.set(k, list);
  return list.length > max;
}

const GAMES = ["home", "tod", "zim8", "tsoro", "spies", "snakes", "yemakomba"];
const TODAY = "(now() at time zone 'Africa/Harare')::date";
function isAdmin(req) {
  const given = String(req.headers["x-admin-key"] || "");
  return crypto.timingSafeEqual(Buffer.from(sha(given)), Buffer.from(sha(ADMIN_KEY)));
}

async function sendWelcome(email, username) {
  if (!BREVO_API_KEY || !MAIL_FROM || !email) return;
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: MAIL_FROM, name: "Game room" },
        to: [{ email }],
        subject: "Your Game room username",
        textContent: `Welcome to Game room!\n\nYour username is: ${username}\n\nKeep your password somewhere safe; we never send it by email.\nPlay here: ${SITE_URL}\n`,
        htmlContent: `<p>Welcome to Game room!</p><p>Your username is: <b>${username.replace(/[<>&]/g, "")}</b></p><p>Keep your password somewhere safe; we never send it by email.</p><p><a href="${SITE_URL}">Open Game room</a></p>`,
      }),
    });
    if (!r.ok) console.error("welcome email failed", r.status, await r.text());
  } catch (e) { console.error("welcome email error", e.message); }
}

async function meResponse(user) {
  const partners = await pool.query(`
    select u.username, p.room_key from pairs p
      join users u on u.id = case when p.user_lo=$1 then p.user_hi else p.user_lo end
     where p.user_lo=$1 or p.user_hi=$1 order by p.created_at`, [user.id]);
  const incoming = await pool.query(
    "select u.username from invites i join users u on u.id=i.from_id where i.to_id=$1 order by i.created_at", [user.id]);
  const outgoing = await pool.query(
    "select u.username from invites i join users u on u.id=i.to_id where i.from_id=$1 order by i.created_at", [user.id]);
  return {
    user: { username: user.username, email: user.email || null },
    partners: partners.rows.map((r) => ({ username: r.username, room: r.room_key })),
    invites: { incoming: incoming.rows.map((r) => r.username), outgoing: outgoing.rows.map((r) => r.username) },
  };
}
async function makePair(a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  await pool.query(
    "insert into pairs(user_lo,user_hi,room_key) values($1,$2,$3) on conflict (user_lo,user_hi) do nothing",
    [lo, hi, crypto.randomBytes(16).toString("hex")]);
  await pool.query("delete from invites where (from_id=$1 and to_id=$2) or (from_id=$2 and to_id=$1)", [a, b]);
}
async function arePartners(a, b) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return (await pool.query("select 1 from pairs where user_lo=$1 and user_hi=$2", [lo, hi])).rowCount > 0;
}

/* ---------- routes ---------- */
const routes = {
  "GET /api/health": async () => [200, { ok: true }],

  "GET /api/available": async (req, url) => {
    const [u, err] = checkUsername(url.searchParams.get("u"));
    if (err) return [200, { available: false, reason: err }];
    return [200, (await findUser(u)) ? { available: false, reason: "That username is taken." } : { available: true }];
  },

  "POST /api/register": async (req, url, body) => {
    if (limited(req, "reg")) return [429, { error: "Too many attempts. Wait a few minutes and try again." }];
    const [username, uerr] = checkUsername(body.username);
    if (uerr) return [400, { error: uerr, field: "username" }];
    const pw = String(body.password || "");
    if (pw.length < 6) return [400, { error: "Passwords need at least 6 characters.", field: "password" }];
    if (pw.length > 200) return [400, { error: "That password is too long.", field: "password" }];
    const [email, eerr] = checkEmail(body.email);
    if (eerr) return [400, { error: eerr, field: "email" }];
    let row;
    try {
      row = (await pool.query("insert into users(username,pass_hash,email) values($1,$2,$3) returning id, username, email",
        [username, hashPassword(pw), email])).rows[0];
    } catch (e) {
      if (e.code === "23505") return [409, { error: "That username is taken. Try another.", field: "username" }];
      throw e;
    }
    const token = await newSession(row.id);
    sendWelcome(email, row.username);
    return [201, { token, ...(await meResponse(row)), emailed: !!(email && BREVO_API_KEY && MAIL_FROM) }];
  },

  "POST /api/login": async (req, url, body) => {
    if (limited(req, "login", 30)) return [429, { error: "Too many attempts. Wait a few minutes and try again." }];
    const r = await pool.query("select id, username, email, pass_hash from users where lower(username)=lower($1)", [String(body.username || "").trim()]);
    const u = r.rows[0];
    if (!u || !verifyPassword(String(body.password || ""), u.pass_hash)) return [401, { error: "That username and password don't match." }];
    const token = await newSession(u.id);
    return [200, { token, ...(await meResponse(u)) }];
  },

  "POST /api/logout": async (req) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
    if (m) await pool.query("delete from sessions where token_hash=$1", [sha(m[1].trim())]);
    return [200, { ok: true }];
  },

  "GET /api/me": async (req, url, body, user) => [200, await meResponse(user)],

  "POST /api/invite": async (req, url, body, user) => {
    const to = await findUser(body.username);
    if (!to) return [404, { error: "No one has that username. Check the spelling." }];
    if (to.id === user.id) return [400, { error: "That's your own username." }];
    if (await arePartners(user.id, to.id)) return [400, { error: `You're already partners with ${to.username}.` }];
    // they already invited me: pair straight away
    const back = await pool.query("select 1 from invites where from_id=$1 and to_id=$2", [to.id, user.id]);
    if (back.rowCount) { await makePair(user.id, to.id); return [200, { paired: to.username, ...(await meResponse(user)) }]; }
    await pool.query("insert into invites(from_id,to_id) values($1,$2) on conflict do nothing", [user.id, to.id]);
    return [200, { invited: to.username, ...(await meResponse(user)) }];
  },

  "POST /api/invite/respond": async (req, url, body, user) => {
    const from = await findUser(body.username);
    if (!from) return [404, { error: "That invite is no longer there." }];
    const r = await pool.query("select 1 from invites where from_id=$1 and to_id=$2", [from.id, user.id]);
    if (!r.rowCount) return [404, { error: "That invite is no longer there." }];
    if (body.accept) await makePair(user.id, from.id);
    else await pool.query("delete from invites where from_id=$1 and to_id=$2", [from.id, user.id]);
    return [200, await meResponse(user)];
  },

  "POST /api/invite/cancel": async (req, url, body, user) => {
    const to = await findUser(body.username);
    if (to) await pool.query("delete from invites where from_id=$1 and to_id=$2", [user.id, to.id]);
    return [200, await meResponse(user)];
  },

  // phones tell the server which page is open (once a minute) so the admin page can count who is online
  "POST /api/ping": async (req, url, body, user) => {
    let game = String(body.game || "").toLowerCase().replace(/[^a-z0-9]/g, "") || "home";
    if (!GAMES.includes(game)) game = "home";
    await pool.query(
      "insert into presence(user_id,game,last_ping) values($1,$2,now()) on conflict (user_id) do update set game=$2, last_ping=now()", [user.id, game]);
    await pool.query(`insert into activity(day,user_id,game) values(${TODAY},$1,$2) on conflict do nothing`, [user.id, game]);
    return [200, { ok: true }];
  },

  /* ----- admin (needs the x-admin-key header) ----- */
  "GET /api/admin/stats": async () => {
    const q = (sql, args) => pool.query(sql, args).then((r) => r.rows);
    const [[tot], online, signups, today, week, [dau], [wau], recent] = await Promise.all([
      q(`select (select count(*) from users)::int users, (select count(*) from pairs)::int couples,
                (select count(*) from invites)::int invites, (select count(*) from sessions)::int devices`),
      q(`select u.username, p.game, extract(epoch from now()-p.last_ping)::int ago
           from presence p join users u on u.id=p.user_id
          where p.last_ping > now() - interval '150 seconds' order by p.last_ping desc`),
      q(`select to_char((created_at at time zone 'Africa/Harare')::date,'YYYY-MM-DD') as day, count(*)::int as n
           from users where (created_at at time zone 'Africa/Harare')::date >= ${TODAY} - 13 group by 1`),
      q(`select game, count(distinct user_id)::int n from activity where day=${TODAY} group by game`),
      q(`select game, count(distinct user_id)::int n from activity where day>=${TODAY} - 6 group by game`),
      q(`select count(distinct user_id)::int n from activity where day=${TODAY}`),
      q(`select count(distinct user_id)::int n from activity where day>=${TODAY} - 6`),
      q(`select u.username, u.created_at,
                exists(select 1 from pairs p where p.user_lo=u.id or p.user_hi=u.id) paired
           from users u order by u.created_at desc limit 8`),
    ]);
    const byGame = {};
    online.forEach((r) => { byGame[r.game] = (byGame[r.game] || 0) + 1; });
    const perGame = (rows) => Object.fromEntries(rows.filter((r) => r.game !== "home").map((r) => [r.game, r.n]));
    return [200, {
      totals: tot, online: { count: online.length, byGame, people: online },
      activeToday: dau.n, active7d: wau.n,
      gamesToday: perGame(today), games7d: perGame(week),
      signups: signups, recent, serverTime: new Date().toISOString(),
    }];
  },

  "GET /api/admin/users": async (req, url) => {
    const term = "%" + String(url.searchParams.get("q") || "").trim().replace(/[%_\\]/g, "") + "%";
    const r = await pool.query(`
      select u.id, u.username, u.email, u.created_at,
             (select count(*) from sessions s where s.user_id=u.id)::int devices,
             greatest(p.last_ping, (select max(last_seen) from sessions s where s.user_id=u.id)) last_seen,
             coalesce(p.last_ping > now() - interval '150 seconds', false) online, p.game,
             coalesce((select string_agg(o.username, ', ' order by o.username) from pairs pr
                        join users o on o.id = case when pr.user_lo=u.id then pr.user_hi else pr.user_lo end
                       where pr.user_lo=u.id or pr.user_hi=u.id), '') partners
        from users u left join presence p on p.user_id=u.id
       where u.username ilike $1 or coalesce(u.email,'') ilike $1
       order by u.created_at desc limit 200`, [term]);
    return [200, { users: r.rows }];
  },

  "POST /api/admin/signout": async (req, url, body) => {
    const r = await pool.query("delete from sessions where user_id=$1", [Number(body.id) || 0]);
    return [200, { ok: true, signedOut: r.rowCount }];
  },

  "POST /api/admin/delete-user": async (req, url, body) => {
    const r = await pool.query("delete from users where id=$1 returning username", [Number(body.id) || 0]);
    return [200, { ok: true, deleted: r.rows[0] ? r.rows[0].username : null }];
  },
};
const NEEDS_ADMIN = new Set(["GET /api/admin/stats", "GET /api/admin/users", "POST /api/admin/signout", "POST /api/admin/delete-user"]);
const NEEDS_LOGIN = new Set(["POST /api/ping", "GET /api/me", "POST /api/invite", "POST /api/invite/respond", "POST /api/invite/cancel"]);

/* ---------- http ---------- */
function send(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, x-admin-key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(obj));
}
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, "http://x");
  const key = `${req.method} ${url.pathname.replace(/\/+$/, "")}`;
  if (url.pathname === "/" ) return send(res, 200, { ok: true, service: "game room accounts" });
  const fn = routes[key];
  if (!fn) return send(res, 404, { error: "Not found" });
  if (!pool && key !== "GET /api/health") return send(res, 503, { error: "Accounts aren't switched on yet. Try again a bit later." });
  try {
    if (NEEDS_ADMIN.has(key)) {
      if (!ADMIN_KEY) return send(res, 503, { error: "Admin isn't set up yet: add an ADMIN_KEY on the server." });
      if (!isAdmin(req)) {
        if (limited(req, "adminfail", 10)) return send(res, 429, { error: "Too many wrong keys. Wait ten minutes." });
        return send(res, 401, { error: "Wrong admin key." });
      }
    }
    let body = {};
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 20000) return send(res, 413, { error: "Too much data." }); }
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return send(res, 400, { error: "Bad request." }); }
    }
    let user = null;
    if (NEEDS_LOGIN.has(key)) { user = await userFromReq(req); if (!user) return send(res, 401, { error: "Please log in again." }); }
    const [status, out] = await fn(req, url, body, user);
    send(res, status, out);
  } catch (e) {
    console.error(key, e);
    send(res, 500, { error: "Something went wrong on the server. Try again." });
  }
});

if (!pool) server.listen(PORT, () => console.log("game room accounts listening on", PORT, "(no database yet)"));
else migrate().then(() => server.listen(PORT, () => console.log("game room accounts listening on", PORT)))
  .catch((e) => { console.error("could not prepare the database", e); process.exit(1); });
