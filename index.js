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
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

const STATS_FILE = process.env.STATS_FILE || "stats.json";
const STATE_FILE = process.env.STATE_FILE || "state.json";

const TON_WALLET = process.env.TON_WALLET;
const TONAPI_KEY = process.env.TONAPI_KEY || "";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);

// ===== Fastify app =====
const app = fastify({ logger: false });

app.register(cors, {
  origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN,
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

// ===== state & stats =====
let stats = safeReadJSON(STATS_FILE, {});
let state = Object.assign({ lastSeenTxId: null }, safeReadJSON(STATE_FILE, {}));

const NANOTONS = 1e9;

// — нормализация стран по комменту —
const COUNTRY_SET = new Set([
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
]);
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
    safeWriteJSON(STATS_FILE, stats);
    safeWriteJSON(STATE_FILE, state);

    try {
      await updateStats(stats);
      console.log("✅ Google Sheet обновлён");
    } catch (e) {
      console.warn("⚠️  Sheets пропущен:", e.message);
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

// ===== routes =====
app.get("/health", async (_req, reply) => {
  reply.send({ ok: true, lastSeenTxId: state.lastSeenTxId });
});
app.get("/stats", async (_req, reply) => {
  reply.header("Cache-Control", "no-store");
  reply.send(stats);
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
