/* =========================================================
   מורקפה · MorCafe — Banner API
   ---------------------------------------------------------
   GET  /api/banner  → the public banner state
   POST /api/banner  → { action: "verify" | "save" | "changePassword" }
                        (needs header x-admin-key)

   Storage: Upstash Redis REST (Vercel Marketplace).
   Zero dependencies on purpose — this stays a static site, no build step.

   AUTH (Sep 2026 — owner asked for an encrypted, self-changeable password
   instead of only the Vercel-dashboard env var):
     Two valid credentials, either one works:
       1) ADMIN_PASSWORD env var — the "recovery key," set once in Vercel
          Settings → Environment Variables. Requires Vercel dashboard
          access to view/change — a safety net if the personal password
          below is ever forgotten.
       2) A personal password the owner sets from the admin panel itself
          ("שינוי סיסמה") — stored ONLY as a salted scrypt hash in the KV
          store (key morcafe:adminAuth). The plain password is never
          written anywhere, only this one-way hash.
     Every login attempt is checked against both; it's accepted if either
     matches. Failed attempts are rate-limited per IP, persisted in the KV
     store when available (survives cold starts / multiple regions),
     falling back to an in-memory counter when no store is configured yet.
   ========================================================= */
"use strict";

const crypto = require("node:crypto");

const BANNER_KEY = "morcafe:banner";
const AUTH_KEY = "morcafe:adminAuth";
const MIN_PASSWORD_LEN = 8;
const MAX_ATTEMPTS = 8;
const LOCKOUT_SECONDS = 600; // 10 minutes

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

function store() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

async function kvGet(key) {
  const s = store();
  if (!s) return null;
  const res = await fetch(s.url + "/get/" + encodeURIComponent(key), {
    headers: { Authorization: "Bearer " + s.token },
    cache: "no-store",
  });
  if (!res.ok) throw new Error("store read failed (" + res.status + ")");
  const data = await res.json();
  return data && data.result != null ? data.result : null;
}

async function kvSet(key, rawValue) {
  const s = store();
  if (!s) throw new Error("store not configured");
  const res = await fetch(s.url + "/set/" + encodeURIComponent(key), {
    method: "POST",
    headers: { Authorization: "Bearer " + s.token, "Content-Type": "text/plain" },
    body: rawValue,
  });
  if (!res.ok) throw new Error("store write failed (" + res.status + ")");
}

/* best-effort helpers for the rate-limit counters — a store hiccup here
   must never block a real login, so these swallow their own errors */
async function kvIncr(key) {
  const s = store();
  if (!s) return null;
  try {
    const res = await fetch(s.url + "/incr/" + encodeURIComponent(key), {
      method: "POST",
      headers: { Authorization: "Bearer " + s.token },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.result === "number" ? data.result : null;
  } catch (e) { return null; }
}
async function kvExpire(key, seconds) {
  const s = store();
  if (!s) return;
  try {
    await fetch(s.url + "/expire/" + encodeURIComponent(key) + "/" + seconds, {
      method: "POST",
      headers: { Authorization: "Bearer " + s.token },
    });
  } catch (e) { /* best effort */ }
}
async function kvDel(key) {
  const s = store();
  if (!s) return;
  try {
    await fetch(s.url + "/del/" + encodeURIComponent(key), {
      method: "POST",
      headers: { Authorization: "Bearer " + s.token },
    });
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

/* two valid credentials — either is accepted (see file header) */
async function checkAuth(givenKey) {
  if (!givenKey || typeof givenKey !== "string") return false;
  const envPw = process.env.ADMIN_PASSWORD || "";
  if (envPw && safeEqual(givenKey, envPw)) return true;
  try {
    const auth = await readAuth();
    if (auth && verifyPasswordHash(givenKey, auth)) return true;
  } catch (e) { /* store hiccup — fall through to false */ }
  return false;
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
