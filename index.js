// index.js (Fastify backend with robust CORS)

require("dotenv").config();

const fastify = require("fastify");
const cors = require("@fastify/cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ===== Google Sheets (мягкий импорт) =====
let updateStats = async () => {};
try {
  ({ updateStats } = require("./googleSheets"));
  console.log("✅ googleSheets подключен");
} catch (e) {
  console.warn("⚠️  googleSheets не подключен:", e?.message || e);
}

process.on("uncaughtException", (err) =>
  console.error("💥 uncaughtException:", err)
);
process.on("unhandledRejection", (reason) =>
  console.error("💥 unhandledRejection:", reason)
);

// ===== ENV =====
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

// Твой прод-домен Vercel (подставь свой при желании — иначе работаем по правилу *.vercel.app)
const PROD_VERCEL =
  process.env.PROD_VERCEL_ORIGIN ||
  "https://donation-official-frontend-dcvzqj63a-dn-workbenchs-projects.vercel.app";

// Дополнительно можно указать список доменов через запятую (опционально)
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const STATS_FILE = process.env.STATS_FILE || "stats.json";
const STATE_FILE = process.env.STATE_FILE || "state.json";

const TON_WALLET = process.env.TON_WALLET;
const TONAPI_KEY = process.env.TONAPI_KEY || "";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);

const ADMIN_KEY = process.env.ADMIN_KEY || ""; // <-- добавь в .env при использовании админ-ручек

// ===== Fastify app =====
const app = fastify({ logger: false });

// ---- CORS (исправлено) ----
// Правила:
//  - точный прод-домен (PROD_VERCEL)
//  - любые *.vercel.app (превью)
//  - локалка http://localhost:5173
//  - + список из FRONTEND_ORIGINS (через запятую)
const STATIC_ALLOWED = new Set([
  PROD_VERCEL,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...FRONTEND_ORIGINS,
]);

app.register(cors, {
  origin: (origin, cb) => {
    // Запросы без Origin (напр. curl) — пускаем
    if (!origin) return cb(null, true);

    // Точная строка из списка
    if (STATIC_ALLOWED.has(origin)) return cb(null, true);

    // Любой поддомен vercel.app (превью и пр.)
    try {
      const u = new URL(origin);
      if (u.host.endsWith(".vercel.app")) return cb(null, true);
    } catch (_) {
      // невалидный Origin — не пускаем
    }

    return cb(new Error("CORS not allowed"), false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-admin-key"],
});

// ===== helpers =====
function safeReadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.warn(`⚠️  Не удалось прочитать ${file}:`, e.message);
  }
  return fallback;
}
function safeWriteJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn(`⚠️  Не удалось записать ${file}:`, e.message);
  }
}

console.log("🔧 CWD:", process.cwd());
console.log("📄 STATS_FILE:", path.resolve(STATS_FILE));
console.log("📄 STATE_FILE:", path.resolve(STATE_FILE));
console.log("🌐 PROD_VERCEL_ORIGIN:", PROD_VERCEL);
if (FRONTEND_ORIGINS.length) {
  console.log("🌐 EXTRA ORIGINS:", FRONTEND_ORIGINS.join(", "));
}

// ===== state & stats =====
let stats = safeReadJSON(STATS_FILE, {});
let state = Object.assign({ lastSeenTxId: null }, safeReadJSON(STATE_FILE, {}));
const NANOTONS = 1e9;

// — базовые 40 стран — чтобы /stats никогда не был пустым —
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

// — нормализация стран по комменту —
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

// ===== TonAPI polling =====
async function fetchFromTonapi() {
  if (!TON_WALLET) throw new Error("TON_WALLET не задан в .env");

  const url = `https://tonapi.io/v2/blockchain/accounts/${TON_WALLET}/transactions?limit=50`;
  const headers = TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {};

  const { data } = await axios.get(url, { headers, timeout: 15000 });
  const items = data?.transactions || data?.items || [];
  if (!Array.isArray(items) || items.length === 0) return;

  for (const tx of items) {
    const inMsg = tx?.in_msg;
    if (!inMsg) continue; // только входящие

    const txId = tx?.hash || tx?.transaction_id?.hash || tx?.lt;
    if (state.lastSeenTxId && txId && txId === state.lastSeenTxId) break;

    const valueNano =
      Number(inMsg?.value) || Number(inMsg?.amount) || Number(tx?.value) || 0;

    const comment =
      inMsg?.decoded?.comment || inMsg?.message || tx?.message || null;

    const country = normalizeCountry(comment);
    if (country && valueNano > 0) addDonation(country, valueNano / NANOTONS);
  }

  const newest = items[0];
  if (newest) {
    state.lastSeenTxId =
      newest?.hash ||
      newest?.transaction_id?.hash ||
      newest?.lt ||
      state.lastSeenTxId;
  }
}

async function pollOnce() {
  try {
    await fetchFromTonapi();
    ensureBaseCountries(stats); // на всякий случай

    // сохраняем кэш
    safeWriteJSON(STATS_FILE, stats);
    safeWriteJSON(STATE_FILE, state);

    // отправляем в Google Sheets (если модуль реально подключен)
    try {
      if (
        typeof updateStats === "function" &&
        updateStats !== (async () => {})
      ) {
        await updateStats(stats);
        console.log("✅ Google Sheet обновлён");
      }
    } catch (e) {
      console.warn("⚠️  Sheets ошибка:", e.message);
    }

    const top5 = Object.entries(stats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    console.log("📊 Топ-5:", top5);
  } catch (e) {
    console.error("❌ Ошибка опроса:", e.message);
  }
}

let timer = null;
function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(pollOnce, POLL_INTERVAL_MS);
  pollOnce();
}

// ===== utils: админ-ключ =====
function getAdminKey(req) {
  return req.headers["x-admin-key"] || (req.body && req.body.key) || "";
}

// ===== routes =====
app.get("/", async (_req, reply) => {
  reply.send({
    ok: true,
    message: "TON donations backend",
    endpoints: ["/health", "/stats"],
  });
});

app.get("/health", async (_req, reply) => {
  reply.send({ ok: true, lastSeenTxId: state.lastSeenTxId });
});

app.get("/stats", async (_req, reply) => {
  ensureBaseCountries(stats);
  // no-store, чтобы браузер не кэшировал HTTP-ответ
  reply.header("Cache-Control", "no-store");
  // заголовок CORS отдаст плагин, но можно явно продублировать на время диагностики:
  // reply.header("Access-Control-Allow-Origin", "*");
  reply.send(stats);
});

// === ADMIN: установить абсолютное значение по стране ===
app.post("/admin/update-country", async (req, reply) => {
  try {
    const key = getAdminKey(req);
    if (!ADMIN_KEY || key !== ADMIN_KEY)
      return reply.code(403).send({ error: "Forbidden" });

    const { country, amount } = req.body || {};
    const normalized = normalizeCountry(country);
    if (!normalized) return reply.code(400).send({ error: "Unknown country" });

    const num = Number(amount);
    if (!Number.isFinite(num) || num < 0)
      return reply.code(400).send({ error: "Invalid amount" });

    stats[normalized] = Number(num.toFixed(6));
    ensureBaseCountries(stats);
    safeWriteJSON(STATS_FILE, stats);

    try {
      if (
        typeof updateStats === "function" &&
        updateStats !== (async () => {})
      ) {
        await updateStats(stats);
      }
    } catch (e) {
      console.warn("⚠️  Sheets ошибка:", e.message);
    }

    return reply.send({
      ok: true,
      country: normalized,
      amount: stats[normalized],
    });
  } catch (e) {
    console.error("❌ /admin/update-country:", e);
    return reply.code(500).send({ error: "Internal error" });
  }
});

// === ADMIN: инкремент/добавить сумму к стране ===
app.post("/admin/add-country", async (req, reply) => {
  try {
    const key = getAdminKey(req);
    if (!ADMIN_KEY || key !== ADMIN_KEY)
      return reply.code(403).send({ error: "Forbidden" });

    const { country, delta } = req.body || {};
    const normalized = normalizeCountry(country);
    if (!normalized) return reply.code(400).send({ error: "Unknown country" });

    const d = Number(delta);
    if (!Number.isFinite(d))
      return reply.code(400).send({ error: "Invalid delta" });

    if (!stats[normalized]) stats[normalized] = 0;
    stats[normalized] = Number((stats[normalized] + d).toFixed(6));
    if (stats[normalized] < 0) stats[normalized] = 0;

    ensureBaseCountries(stats);
    safeWriteJSON(STATS_FILE, stats);

    try {
      if (
        typeof updateStats === "function" &&
        updateStats !== (async () => {})
      ) {
        await updateStats(stats);
      }
    } catch (e) {
      console.warn("⚠️  Sheets ошибка:", e.message);
    }

    return reply.send({
      ok: true,
      country: normalized,
      amount: stats[normalized],
    });
  } catch (e) {
    console.error("❌ /admin/add-country:", e);
    return reply.code(500).send({ error: "Internal error" });
  }
});

// ===== start =====
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
