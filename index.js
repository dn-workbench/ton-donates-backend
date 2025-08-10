require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// ================== ENV ==================
const PORT = Number(process.env.PORT || 3000);
const STATS_FILE = process.env.STATS_FILE || "stats.json";
const STATE_FILE = process.env.STATE_FILE || "state.json"; // где храним lastSeenTxId
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

const TON_WALLET = process.env.TON_WALLET; // адрес в формате EQ../UQ..
const TONAPI_KEY = process.env.TONAPI_KEY || ""; // ключ из TonConsole
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);

// ================== Google Sheets (мягкий импорт) ==================
let updateStats = async () => {};
try {
  ({ updateStats } = require("./googleSheets"));
  console.log("✅ googleSheets подключен");
} catch (e) {
  console.warn("⚠️  googleSheets не подключен:", e?.message || e);
  console.warn("    Продолжаю без обновления Google Sheets.");
}

// ================== Express ==================
const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN }));

// ================== Files helpers ==================
function safeReadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
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

// ================== Состояние и статистика ==================
let stats = safeReadJSON(STATS_FILE, {}); // { "United States": 123.45, ... } (TON)
let state = Object.assign({ lastSeenTxId: null }, safeReadJSON(STATE_FILE, {}));
const NANOTONS = 1e9;

// ================== Нормализация стран ==================
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

// частичные алиасы (на всякий случай)
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
  let s = raw.trim();
  if (!s) return null;

  // прямые совпадения
  if (COUNTRY_SET.has(s)) return s;

  // Алиасы по верхнему регистру
  const upper = s.toUpperCase();
  if (ALIASES[upper]) return ALIASES[upper];

  // Тайтлкейс
  const title =
    s.length < 3 ? s.toUpperCase() : s[0].toUpperCase() + s.slice(1);
  if (COUNTRY_SET.has(title)) return title;

  return null;
}

function addDonation(country, amountTON) {
  if (!country || isNaN(amountTON) || amountTON <= 0) return;
  if (!stats[country]) stats[country] = 0;
  stats[country] = Number((stats[country] + amountTON).toFixed(6)); // точность до микротона
}

// ================== Опрос TonAPI ==================
async function fetchFromTonapi() {
  if (!TON_WALLET) throw new Error("TON_WALLET не задан в .env");

  const url = `https://tonapi.io/v2/blockchain/accounts/${TON_WALLET}/transactions?limit=50`;
  const headers = TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {};

  const { data } = await axios.get(url, { headers, timeout: 15000 });
  const items = data?.transactions || data?.items || [];
  if (!Array.isArray(items) || items.length === 0) return;

  // Идём от свежих к старым, пока не дойдём до уже обработанной
  for (const tx of items) {
    const inMsg = tx?.in_msg;
    if (!inMsg) continue; // нас интересуют только входящие

    const txId = tx?.hash || tx?.transaction_id?.hash || tx?.lt;
    if (state.lastSeenTxId && txId && txId === state.lastSeenTxId) break;

    const valueNano =
      Number(inMsg?.value) || Number(inMsg?.amount) || Number(tx?.value) || 0;

    // комментарий к платежу (где донор пишет страну)
    const comment =
      inMsg?.decoded?.comment || inMsg?.message || tx?.message || null;

    const country = normalizeCountry(comment);
    if (country && valueNano > 0) {
      addDonation(country, valueNano / NANOTONS);
    }
  }

  // запомним "самую свежую" транзакцию как маркер
  const newest = items[0];
  if (newest) {
    state.lastSeenTxId =
      newest?.hash ||
      newest?.transaction_id?.hash ||
      newest?.lt ||
      state.lastSeenTxId;
  }
}

// ================== Цикл опроса ==================
async function pollOnce() {
  try {
    await fetchFromTonapi();

    // сохраняем на диск
    safeWriteJSON(STATS_FILE, stats);
    safeWriteJSON(STATE_FILE, state);

    // отправляем в Google Sheets (мягко)
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
  // первый проход сразу
  pollOnce();
}

// ================== API ==================
app.get("/health", (_req, res) => {
  res.json({ ok: true, lastSeenTxId: state.lastSeenTxId });
});

app.get("/stats", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(stats);
});

// ================== START ==================
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на :${PORT}`);
  if (!TON_WALLET) {
    console.warn("⚠️  TON_WALLET не задан — опрос TonAPI отключён");
  } else {
    startPolling();
  }
});

// страховка на случай ошибок
process.on("uncaughtException", (err) =>
  console.error("💥 uncaughtException:", err)
);
process.on("unhandledRejection", (r) =>
  console.error("💥 unhandledRejection:", r)
);
