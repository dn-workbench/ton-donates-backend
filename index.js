require("dotenv").config(); // 👈 Подключаем переменные окружения

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const { updateStats } = require("./googleSheets");

const app = express();
const PORT = process.env.PORT || 3000;
const STATS_FILE = process.env.STATS_FILE || "stats.json";

app.use(cors());

let stats = {};

// Загружаем статистику из файла
try {
  const data = fs.readFileSync(STATS_FILE, "utf8");
  stats = JSON.parse(data);
  console.log("📂 Статистика загружена из файла");
} catch {
  console.log("❌ Файл статистики не найден, начинаем с нуля");
}

// Сохраняем статистику в файл
function saveStats() {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

// Фейковые транзакции
async function fetchTransactions() {
  try {
    const fakeTransactions = [
      { in_msg: { comment: "Ukraine" }, amount: 811311 * 1e9 },
      { in_msg: { comment: "Germany" }, amount: 222242 * 1e9 },
      { in_msg: { comment: "United States" }, amount: 92125 * 1e9 },
      { in_msg: { comment: "France" }, amount: 521121 * 1e9 },
      { in_msg: { comment: "Japan" }, amount: 54 * 1e9 },
      { in_msg: { comment: "Brazil" }, amount: 22.2 * 1e9 },
      { in_msg: { comment: "Ukraine" }, amount: 12 * 1e9 },
    ];

    stats = {};

    fakeTransactions.forEach((tx) => {
      const comment = tx.in_msg?.comment;
      if (comment) {
        const country = comment.trim();
        const amountTON = Number(tx.amount) / 1e9;

        if (!stats[country]) stats[country] = 0;
        stats[country] += amountTON;
      }
    });

    console.log("📊 Тестовая статистика:", stats);
    saveStats(); // сохраняем локально
    await updateStats(stats); // в Google Sheets
  } catch (err) {
    console.error("❌ Ошибка при генерации данных:", err.message);
  }
}

// Обновление каждую минуту
setInterval(fetchTransactions, 60 * 1000);
fetchTransactions();

// API для frontend
app.get("/stats", (req, res) => {
  res.json(stats);
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});
