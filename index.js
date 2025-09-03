// index.js — Fastify backend (hardened)
// ─────────────────────────────────────────────────────────────────────────────
// Ключевые отличия:
//  - Атомарная запись JSON (tmp → rename), отдельная папка data/
//  - Пагинация TonAPI до PAGE_LIMIT, чтобы не пропускать транзакции
//  - Валидация входящих тел (fastify schema) для админ-ручек
//  - CORS: точные origin'ы + *.vercel.app + локалка
//  - Graceful shutdown (SIGINT/SIGTERM)
//  - Лёгкий джиттер интервала опроса TonAPI
//  - Аккуратные логи и защита от кривых JSON

require("dotenv").config();

const fastify = require("fastify");
const cors = require("@fastify/cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ─── Optional Google Sheets ──────────────────────────────────────────────────
let updateStats = async () => {};
try {
  ({ updateStats } = require("./googleSheets"));
  console.log("✅ googleSheets подключен");
} catch (e) {
  console.warn("⚠️  googleSheets не подключен:", e?.message || e);
}

// ─── Process-level error guards ──────────────────────────────────────────────
process.on("uncaughtException", (err) =>
  console.error("💥 uncaughtException:", err)
);
process.on("unhandledRejection", (reason) =>
  console.error("💥 unhandledRejection:", reason)
);

// ─── ENV ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const PROD_VERCEL =
  process.env.PROD_VERCEL_ORIGIN ||
  "https://donation-official-frontend.vercel.app";

const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DATA_DIR = process.env.DATA_DIR || "./data";
const STATS_FILE = path.resolve(
  DATA_DIR,
  process.env.STATS_FILE || "stats.json"
);
const STATE_FILE = path.resolve(
  DATA_DIR,
  process.env.STATE_FILE || "state.json"
);

const TON_WALLET = process.env.TON_WALLET || "";
const TONAPI_KEY = process.env.TONAPI_KEY || "";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
// Предел по страницам на одну итерацию опроса:
const PAGE_LIMIT = Number(process.env.PAGE_LIMIT || 5);

const ADMIN_KEY = process.env.ADMIN_KEY || "";

// ─── App ─────────────────────────────────────────────────────────────────────
const app = fastify({ logger: true });

// ─── CORS ────────────────────────────────────────────────────────────────────
const STATIC_ALLOWED = new Set([
  PROD_VERCEL,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...FRONTEND_ORIGINS,
]);

app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / direct
    if (STATIC_ALLOWED.has(origin)) return cb(null, true);
    try {
      const u = new URL(origin);
      if (u.host.endsWith(".vercel.app")) return cb(null, true);
    } catch (_) {}
    app.log.warn({ origin }, "CORS rejected");
    return cb(new Error("CORS not allowed"), false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-admin-key"],
});

// ─── FS helpers (atomic write) ───────────────────────────────────────────────
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function safeReadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8");
      return JSON.parse(text);
    }
  } catch (e) {
    app.log.warn({ file, err: e.message }, "readJSON failed");
  }
  return fallback;
}
function atomicWriteJSON(file, data) {
  try {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    app.log.warn({ file, err: e.message }, "writeJSON failed");
  }
}

// ─── Boot: paths info ────────────────────────────────────────────────────────
ensureDir(DATA_DIR);
app.log.info({ CWD: process.cwd() }, "boot");
app.log.info({ STATS_FILE, STATE_FILE }, "paths");
app.log.info(
  { PROD_VERCEL_ORIGIN: PROD_VERCEL, EXTRA_ORIGINS: FRONTEND_ORIGINS },
  "CORS"
);

// ─── State & stats ───────────────────────────────────────────────────────────
let stats = safeReadJSON(STATS_FILE, {});
let state = Object.assign({ lastSeenTxId: null }, safeReadJSON(STATE_FILE, {}));

const NANOTONS = 1e9;

// Базовые страны (чтобы фронт не пустел)
const BASE_COUNTRIES = [
  "United States",
  "India",
  "China",
  "Japan",
  "Germany",
  "United Kingdom",
  "France",
  "Italy",
  "Canada",
  "Australia",
  "Brazil",
  "Mexico",
  "Spain",
  "Netherlands",
  "Turkey",
  "South Korea",
  "Indonesia",
  "Saudi Arabia",
  "United Arab Emirates",
  "Israel",
  "Sweden",
  "Switzerland",
  "Poland",
  "Ukraine",
  "Russia",
  "Argentina",
  "Colombia",
  "South Africa",
  "Nigeria",
  "Egypt",
  "Vietnam",
  "Thailand",
  "Malaysia",
  "Singapore",
  "Philippines",
  "Kazakhstan",
  "Norway",
  "Denmark",
  "Ireland",
  "Austria",
];
function ensureBaseCountries(obj) {
  for (const c of BASE_COUNTRIES) if (obj[c] == null) obj[c] = 0;
}
ensureBaseCountries(stats);

// Нормализация стран
const COUNTRY_SET = new Set(BASE_COUNTRIES);
const ALIASES = {
  USA: "United States",
  US: "United States",
  "U.S.": "United States",
  UK: "United Kingdom",
  UAE: "United Arab Emirates",
  KOREA: "South Korea",
  "SOUTH KOREA": "South Korea",
  RUSSIA: "Russia",
  CHINA: "China",
  INDIA: "India",
};
function normalizeCountry(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (COUNTRY_SET.has(s)) return s;

  const upper = s.toUpperCase();
  if (ALIASES[upper]) return ALIASES[upper];

  const title =
    s.length < 3 ? s.toUpperCase() : s[0].toUpperCase() + s.slice(1);
  if (COUNTRY_SET.has(title)) return title;

  const lower = s.toLowerCase();
  for (const c of COUNTRY_SET) if (c.toLowerCase() === lower) return c;

  return null;
}
function addDonation(country, amountTON) {
  if (!country || isNaN(amountTON) || amountTON <= 0) return;
  if (!stats[country]) stats[country] = 0;
  stats[country] = Number((stats[country] + amountTON).toFixed(6));
}

// ─── TonAPI polling (with pagination) ────────────────────────────────────────
async function fetchFromTonapiPaged() {
  if (!TON_WALLET) throw new Error("TON_WALLET не задан в .env");

  const headers = TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {};
  let page = 0;
  let stop = false;
  let newestId = state.lastSeenTxId || null;

  // крутим страницы, пока не встретим lastSeenTxId или не превысим PAGE_LIMIT
  while (!stop && page < PAGE_LIMIT) {
    const url = `https://tonapi.io/v2/blockchain/accounts/${TON_WALLET}/transactions?limit=50&offset=${
      page * 50
    }`;
    const { data } = await axios.get(url, { headers, timeout: 15000 });

    const items = data?.transactions || data?.items || [];
    if (!Array.isArray(items) || items.length === 0) break;

    // гарантируем порядок от новых к старым
    items.sort((a, b) => {
      const at = a.utime || a.now || 0;
      const bt = b.utime || b.now || 0;
      return bt - at;
    });

    for (const tx of items) {
      const inMsg = tx?.in_msg;
      if (!inMsg) continue; // только входящие

      const txId = tx?.hash || tx?.transaction_id?.hash || tx?.lt;
      if (state.lastSeenTxId && txId && txId === state.lastSeenTxId) {
        stop = true;
        break;
      }

      const valueNano =
        Number(inMsg?.value) || Number(inMsg?.amount) || Number(tx?.value) || 0;

      const comment =
        inMsg?.decoded?.comment || inMsg?.message || tx?.message || null;

      const country = normalizeCountry(comment);
      if (country && valueNano > 0) addDonation(country, valueNano / NANOTONS);

      // сохраняем id самой новой транзакции из первой страницы (или первой итерации)
      if (!newestId) {
        newestId = txId || newestId;
      }
    }

    // если прошлись по странице и не встретили lastSeenTxId — идём дальше
    page += 1;
  }

  if (newestId) {
    state.lastSeenTxId = newestId;
  }
}

async function pollOnce() {
  try {
    await fetchFromTonapiPaged();
    ensureBaseCountries(stats);

    atomicWriteJSON(STATS_FILE, stats);
    atomicWriteJSON(STATE_FILE, state);

    // Google Sheet (если подключен)
    try {
      if (
        typeof updateStats === "function" &&
        updateStats !== (async () => {})
      ) {
        await updateStats(stats);
        app.log.info("✅ Google Sheet обновлён");
      }
    } catch (e) {
      app.log.warn({ err: e.message }, "Sheets error");
    }

    const top5 = Object.entries(stats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    app.log.info({ top5 }, "stats updated");
  } catch (e) {
    app.log.error({ err: e.message }, "pollOnce error");
  }
}

let timer = null;
function startPolling() {
  if (timer) clearInterval(timer);
  // лёгкий джиттер, чтоб не синхронизироваться с другими инстансами/лимитами
  const base = POLL_INTERVAL_MS;
  const jitter = Math.floor(Math.random() * 5000);
  timer = setInterval(pollOnce, base + jitter);
  // первый прогон сразу
  pollOnce();
}

// ─── Admin auth helper ──────────────────────────────────────────────────────
function getAdminKey(req) {
  return req.headers["x-admin-key"] || (req.body && req.body.key) || "";
}

// ─── Routes ─────────────────────────────────────────────────────────────────
app.get("/", async (_req, reply) => {
  reply.send({
    ok: true,
    message: "TON donations backend",
    endpoints: ["/health", "/stats", "/admin/*"],
  });
});

app.get("/health", async (_req, reply) => {
  reply.send({ ok: true, lastSeenTxId: state.lastSeenTxId });
});

app.get("/stats", async (_req, reply) => {
  ensureBaseCountries(stats);
  reply.header("Cache-Control", "no-store");
  reply.send(stats);
});

// ─── Schemas for admin routes ────────────────────────────────────────────────
const updateCountrySchema = {
  body: {
    type: "object",
    required: ["country", "amount"],
    properties: {
      country: { type: "string", minLength: 1 },
      amount: { type: "number", minimum: 0 },
    },
    additionalProperties: false,
  },
};

const addCountrySchema = {
  body: {
    type: "object",
    required: ["country", "delta"],
    properties: {
      country: { type: "string", minLength: 1 },
      delta: { type: "number" },
    },
    additionalProperties: false,
  },
};

// === ADMIN: set absolute amount ===
app.post(
  "/admin/update-country",
  { schema: updateCountrySchema },
  async (req, reply) => {
    try {
      const key = getAdminKey(req);
      if (!ADMIN_KEY || key !== ADMIN_KEY)
        return reply.code(403).send({ error: "Forbidden" });

      const { country, amount } = req.body;
      const normalized = normalizeCountry(country);
      if (!normalized)
        return reply.code(400).send({ error: "Unknown country" });

      stats[normalized] = Number(Number(amount).toFixed(6));
      ensureBaseCountries(stats);
      atomicWriteJSON(STATS_FILE, stats);

      try {
        if (
          typeof updateStats === "function" &&
          updateStats !== (async () => {})
        ) {
          await updateStats(stats);
        }
      } catch (e) {
        app.log.warn({ err: e.message }, "Sheets error");
      }

      return reply.send({
        ok: true,
        country: normalized,
        amount: stats[normalized],
      });
    } catch (e) {
      app.log.error({ err: e }, "/admin/update-country");
      return reply.code(500).send({ error: "Internal error" });
    }
  }
);

// === ADMIN: increment by delta ===
app.post(
  "/admin/add-country",
  { schema: addCountrySchema },
  async (req, reply) => {
    try {
      const key = getAdminKey(req);
      if (!ADMIN_KEY || key !== ADMIN_KEY)
        return reply.code(403).send({ error: "Forbidden" });

      const { country, delta } = req.body;
      const normalized = normalizeCountry(country);
      if (!normalized)
        return reply.code(400).send({ error: "Unknown country" });

      const d = Number(delta);
      if (!Number.isFinite(d))
        return reply.code(400).send({ error: "Invalid delta" });

      if (!stats[normalized]) stats[normalized] = 0;
      stats[normalized] = Number((stats[normalized] + d).toFixed(6));
      if (stats[normalized] < 0) stats[normalized] = 0;

      ensureBaseCountries(stats);
      atomicWriteJSON(STATS_FILE, stats);

      try {
        if (
          typeof updateStats === "function" &&
          updateStats !== (async () => {})
        ) {
          await updateStats(stats);
        }
      } catch (e) {
        app.log.warn({ err: e.message }, "Sheets error");
      }

      return reply.send({
        ok: true,
        country: normalized,
        amount: stats[normalized],
      });
    } catch (e) {
      app.log.error({ err: e }, "/admin/add-country");
      return reply.code(500).send({ error: "Internal error" });
    }
  }
);

// === ADMIN: ручная синхронизация с Google Sheets ===
app.post("/admin/sync-sheets", async (req, reply) => {
  try {
    const key = req.headers["x-admin-key"] || "";
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    if (typeof updateStats !== "function") {
      return reply
        .code(500)
        .send({ ok: false, error: "Sheets module not loaded" });
    }

    const res = await updateStats(stats);

    return reply.send({
      ok: true,
      message: "Synced to Google Sheets",
      ...res,
    });
  } catch (e) {
    req.log.error(e, "sync-sheets failed");
    return reply.code(500).send({ ok: false, error: e.message });
  }
});

// ─── Start & graceful shutdown ───────────────────────────────────────────────
app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    console.error("❌ Fastify listen error:", err);
    process.exit(1);
  }
  console.log(`🚀 Server on ${address}`);
  if (!TON_WALLET) {
    console.warn("⚠️  TON_WALLET не задан — опрос TonAPI отключён");
  } else {
    startPolling();
  }
});

async function shutdown() {
  try {
    if (timer) clearInterval(timer);
    await app.close();
  } catch (e) {
    console.error("shutdown error:", e);
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
