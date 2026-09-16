/* =========================================================
   מורקפה · MorCafe — Banner API
   ---------------------------------------------------------
   GET  /api/banner  → the public banner state
   POST /api/banner  → { action: "verify" | "save" | "changePassword" }
                        (needs header x-admin-key)

   Storage: Vercel's native Redis (Marketplace) — connected as a plain
   `REDIS_URL` connection string, not a REST API. This is a real (tiny)
   dependency on the `redis` npm client, the one exception to keeping the
   site build-free — Vercel installs it automatically from package.json.
   (Sep 2026: an earlier version of this file assumed the classic Upstash
   REST-style integration, KV_REST_API_URL + KV_REST_API_TOKEN — the
   project ended up with Vercel's newer native Redis product instead,
   which only exposes REDIS_URL, so the storage layer below was rewritten
   to use a real Redis client. Everything above the storage layer —
   auth, rate limiting, sanitizing, the handler — is unchanged.)

   AUTH (Sep 2026 — owner asked for an encrypted, self-changeable password
   that never requires touching Vercel's Environment Variables screen):
     Up to three credentials can grant access; whichever apply are checked
     in this order, first match wins:
       1) ADMIN_PASSWORD env var — OPTIONAL. Only relevant if someone sets
          it manually in Vercel Settings → Environment Variables. Not
          required for the system to work at all.
       2) The personal password the owner set from the admin panel itself
          ("שינוי סיסמה") — stored ONLY as a salted scrypt hash in the KV
          store (key morcafe:adminAuth). The plain password is never
          written anywhere, only this one-way hash.
       3) BOOTSTRAP_PASSWORD (below) — a one-time default baked into this
          file, valid ONLY until a personal password has been set (i.e.
          only while morcafe:adminAuth doesn't exist yet). The instant a
          personal password is saved via the panel, this stops being
          accepted, permanently — the standard "default password you must
          change on first login" pattern. This is what lets first setup
          skip Vercel's dashboard entirely: connect the database, open
          /admin.html, log in with BOOTSTRAP_PASSWORD, immediately set a
          personal password.
     Failed attempts are rate-limited per IP, persisted in the KV store
     when available (survives cold starts / multiple regions), falling
     back to an in-memory counter when no store is configured yet.
   ========================================================= */
"use strict";

const crypto = require("node:crypto");

const BANNER_KEY = "morcafe:banner";
const AUTH_KEY = "morcafe:adminAuth";
const MIN_PASSWORD_LEN = 8;
const MAX_ATTEMPTS = 8;
const LOCKOUT_SECONDS = 600; // 10 minutes

/* One-time default login — works ONLY until a personal password has been
   set via the admin panel (see checkAuth below). Change it immediately
   after first login using "שינוי סיסמה". This is what lets first setup
   skip Vercel's Environment Variables screen entirely. */
const BOOTSTRAP_PASSWORD = "MorCafe-Bootstrap-2026!";

const DEFAULTS = {
  active: false,
  eyebrow: "הודעה חשובה",
  title: "העגלה סגורה זמנית",
  body: "אנחנו נמצאים כרגע באירוע פרטי מחוץ לעגלה. נשמח לראותכם שוב בקרוב — תודה על ההבנה!",
  note: "",
  ctaText: "",
  ctaHref: "",
  id: "0",
  updatedAt: null,
};

const LIMITS = { eyebrow: 40, title: 90, body: 700, note: 140, ctaText: 40, ctaHref: 400 };

/* ---------------------------------- store ---------------------------------- */

const { createClient } = require("redis");

/* module-level singleton so warm serverless instances reuse one open
   connection across requests instead of reconnecting every time */
let redisClientPromise = null;

function store() {
  return !!process.env.REDIS_URL;
}

function getClient() {
  if (!store()) return null;
  if (!redisClientPromise) {
    const client = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: 5000 },
    });
    // required by the redis v4 client — otherwise an unhandled 'error'
    // event would crash the whole function process
    client.on("error", function (err) {
      console.error("[api/banner] redis client error:", err && err.message);
    });
    redisClientPromise = client.connect().then(
      function () { return client; },
      function (err) {
        redisClientPromise = null; // let the next call retry a fresh connection
        throw err;
      }
    );
  }
  return redisClientPromise;
}

async function kvGet(key) {
  const clientP = getClient();
  if (!clientP) return null;
  const client = await clientP;
  const val = await client.get(key);
  return val == null ? null : val;
}

async function kvSet(key, rawValue) {
  const clientP = getClient();
  if (!clientP) throw new Error("store not configured");
  const client = await clientP;
  await client.set(key, rawValue);
}

/* best-effort helpers for the rate-limit counters — a store hiccup here
   must never block a real login, so these swallow their own errors */
async function kvIncr(key) {
  const clientP = getClient();
  if (!clientP) return null;
  try {
    const client = await clientP;
    return await client.incr(key);
  } catch (e) { return null; }
}
async function kvExpire(key, seconds) {
  const clientP = getClient();
  if (!clientP) return;
  try {
    const client = await clientP;
    await client.expire(key, seconds);
  } catch (e) { /* best effort */ }
}
async function kvDel(key) {
  const clientP = getClient();
  if (!clientP) return;
  try {
    const client = await clientP;
    await client.del(key);
  } catch (e) { /* best effort */ }
}

async function readBanner() {
  const raw = await kvGet(BANNER_KEY);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) { return null; }
}
async function writeBanner(value) { await kvSet(BANNER_KEY, JSON.stringify(value)); }

async function readAuth() {
  const raw = await kvGet(AUTH_KEY);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.salt && parsed.hash ? parsed : null;
  } catch (e) { return null; }
}
async function writeAuth(record) { await kvSet(AUTH_KEY, JSON.stringify(record)); }

/* ----------------------------------- auth ---------------------------------- */

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* scrypt: salted, one-way — this is what "encrypted" means in practice for
   a password: it's never stored (or logged) in a form that can be turned
   back into the original password, only this hash. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt: salt, hash: hash };
}
function verifyPasswordHash(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const candidate = crypto.scryptSync(password, record.salt, 64).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(record.hash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* up to three credentials can grant access — see file header for the order
   and the bootstrap-retirement rule */
async function checkAuth(givenKey) {
  if (!givenKey || typeof givenKey !== "string") return false;

  const envPw = process.env.ADMIN_PASSWORD || "";
  if (envPw && safeEqual(givenKey, envPw)) return true;

  let auth = null;
  try {
    auth = await readAuth();
  } catch (e) {
    // can't reach the store to check — fail CLOSED (deny), never fall back
    // to the bootstrap default here, or a transient hiccup would let it
    // bypass a personal password that's actually already been set
    return false;
  }

  if (auth) return verifyPasswordHash(givenKey, auth);

  // no personal password has been set yet — the one-time bootstrap default
  // is still live. The moment a personal password is saved, `auth` above
  // will be truthy on every future call and this line stops being reached.
  return safeEqual(givenKey, BOOTSTRAP_PASSWORD);
}

/* -------------------------- brute-force protection -------------------------- */

/* in-memory fallback — used only when no KV store is configured yet.
   Protects a single warm instance; resets on cold start / other regions,
   which is why the KV-backed version above is preferred once available. */
const memoryFailures = new Map(); // ipHash → { count, until }

function ipHash(ip) {
  return crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 20);
}

async function isRateLimited(ip) {
  const h = ipHash(ip);
  if (store()) {
    let raw = null;
    try { raw = await kvGet("morcafe:loginfail:" + h); } catch (e) { raw = null; }
    const n = raw ? parseInt(raw, 10) : 0;
    return n >= MAX_ATTEMPTS;
  }
  const rec = memoryFailures.get(h);
  return !!(rec && rec.count >= MAX_ATTEMPTS && Date.now() < rec.until);
}

async function recordFailure(ip) {
  const h = ipHash(ip);
  if (store()) {
    const n = await kvIncr("morcafe:loginfail:" + h);
    if (n === 1) await kvExpire("morcafe:loginfail:" + h, LOCKOUT_SECONDS);
    return;
  }
  const rec = memoryFailures.get(h) || { count: 0, until: 0 };
  rec.count += 1;
  rec.until = Date.now() + LOCKOUT_SECONDS * 1000;
  memoryFailures.set(h, rec);
}

async function clearFailures(ip) {
  const h = ipHash(ip);
  if (store()) { await kvDel("morcafe:loginfail:" + h); return; }
  memoryFailures.delete(h);
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

/* --------------------------------- helpers --------------------------------- */

function readJson(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string") {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise(function (resolve) {
    let raw = "";
    req.on("data", function (c) { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on("end", function () {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
    req.on("error", function () { resolve({}); });
  });
}

/* strip control chars, collapse >2 blank lines, trim, cap length.
   Plain regex literal (not new RegExp("...")) so the \x escapes are
   parsed once, safely, by the JS engine — not re-interpreted as text. */
function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

function cleanHref(value) {
  const raw = cleanText(value, LIMITS.ctaHref);
  if (!raw) return "";
  if (/^(https?:\/\/|tel:|mailto:)/i.test(raw)) return raw;
  if (/^www\./i.test(raw)) return "https://" + raw;
  return "";
}

function sanitize(input) {
  const out = {
    active: input.active === true || input.active === "true",
    eyebrow: cleanText(input.eyebrow, LIMITS.eyebrow) || DEFAULTS.eyebrow,
    title: cleanText(input.title, LIMITS.title),
    body: cleanText(input.body, LIMITS.body),
    note: cleanText(input.note, LIMITS.note),
    ctaText: cleanText(input.ctaText, LIMITS.ctaText),
    ctaHref: cleanHref(input.ctaHref),
  };
  if (!out.ctaHref) out.ctaText = "";
  return out;
}

function publicView(banner) {
  if (!banner || !banner.active) return { active: false };
  return {
    active: true,
    id: String(banner.id || "0"),
    eyebrow: banner.eyebrow || DEFAULTS.eyebrow,
    title: banner.title || "",
    body: banner.body || "",
    note: banner.note || "",
    ctaText: banner.ctaText || "",
    ctaHref: banner.ctaHref || "",
  };
}

/* --------------------------------- handler --------------------------------- */

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Robots-Tag", "noindex");

  const configured = !!store();
  const givenKey = req.headers["x-admin-key"];
  // only pay the auth-check cost (KV read + scrypt) when a key is actually
  // sent — ordinary visitors' public GETs never send one, so this stays
  // cheap on the hot path everyone hits
  const isAdmin = (typeof givenKey === "string" && givenKey) ? await checkAuth(givenKey) : false;

  /* ------------------------------- GET ------------------------------- */
  if (req.method === "GET") {
    if (isAdmin) res.setHeader("Cache-Control", "no-store");
    // max-age=0 keeps the BROWSER revalidating every load (without it browsers
    // apply heuristic caching and visitors keep seeing a stale banner);
    // s-maxage still lets Vercel's CDN absorb bursts for 5s.
    else res.setHeader("Cache-Control", "public, max-age=0, s-maxage=5, stale-while-revalidate=20");

    if (!configured) {
      return res.status(200).end(JSON.stringify({ banner: { active: false }, configured: false }));
    }
    try {
      const banner = (await readBanner()) || Object.assign({}, DEFAULTS);
      const payload = isAdmin
        ? { banner: banner, configured: true, admin: true }
        : { banner: publicView(banner), configured: true };
      return res.status(200).end(JSON.stringify(payload));
    } catch (e) {
      // never break the public site because the store hiccuped
      return res.status(200).end(JSON.stringify({ banner: { active: false }, configured: true, error: "store" }));
    }
  }

  /* ------------------------------- POST ------------------------------ */
  if (req.method === "POST") {
    res.setHeader("Cache-Control", "no-store");
    const ip = clientIp(req);

    if (await isRateLimited(ip)) {
      return res.status(429).end(JSON.stringify({ ok: false, error: "rate-limited",
        message: "יותר מדי ניסיונות כניסה. נסו שוב בעוד 10 דקות." }));
    }
    if (!isAdmin) {
      await recordFailure(ip);
      await new Promise(function (r) { setTimeout(r, 600); });
      return res.status(401).end(JSON.stringify({ ok: false, error: "unauthorized", message: "סיסמה שגויה." }));
    }
    await clearFailures(ip);

    const body = await readJson(req);
    const action = body && body.action;

    if (action === "verify") {
      return res.status(200).end(JSON.stringify({ ok: true, configured: configured }));
    }

    if (action === "save") {
      if (!configured) {
        return res.status(500).end(JSON.stringify({ ok: false, error: "missing-store",
          message: "לא מחובר מאגר נתונים. יש ליצור Upstash Redis בלשונית Storage ב־Vercel ולחבר אותו לפרויקט." }));
      }
      const clean = sanitize(body.banner || {});
      if (clean.active && !clean.title && !clean.body) {
        return res.status(400).end(JSON.stringify({ ok: false, error: "empty",
          message: "צריך למלא כותרת או טקסט להודעה לפני ההדלקה." }));
      }
      const record = Object.assign({}, clean, {
        id: String(Date.now()),
        updatedAt: new Date().toISOString(),
      });
      try {
        await writeBanner(record);
      } catch (e) {
        return res.status(502).end(JSON.stringify({ ok: false, error: "store-write",
          message: "השמירה נכשלה. נסו שוב בעוד רגע." }));
      }
      return res.status(200).end(JSON.stringify({ ok: true, banner: record }));
    }

    if (action === "changePassword") {
      const raw = typeof body.newPassword === "string" ? body.newPassword : "";
      if (raw.length < MIN_PASSWORD_LEN) {
        return res.status(400).end(JSON.stringify({ ok: false, error: "weak-password",
          message: "הסיסמה החדשה צריכה להיות באורך " + MIN_PASSWORD_LEN + " תווים לפחות." }));
      }
      if (!configured) {
        return res.status(500).end(JSON.stringify({ ok: false, error: "missing-store",
          message: "לא ניתן לשמור סיסמה חדשה בלי חיבור למאגר הנתונים ב־Vercel." }));
      }
      try {
        const rec = hashPassword(raw);
        await writeAuth(Object.assign({}, rec, { updatedAt: new Date().toISOString() }));
      } catch (e) {
        return res.status(502).end(JSON.stringify({ ok: false, error: "store-write",
          message: "שמירת הסיסמה נכשלה. נסו שוב." }));
      }
      return res.status(200).end(JSON.stringify({ ok: true }));
    }

    return res.status(400).end(JSON.stringify({ ok: false, error: "bad-action" }));
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
};
