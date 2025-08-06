require("dotenv").config();
const { google } = require("googleapis");

// Загружаем JSON из переменной окружения
const keys = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

const auth = new google.auth.GoogleAuth({
  credentials: keys,
  scopes: SCOPES,
});

const sheets = google.sheets({ version: "v4", auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

async function updateStats(stats) {
  const values = Object.entries(stats).map(([country, amount]) => [
    country,
    amount.toFixed(2),
  ]);

  values.unshift(["Country", "Amount"]); // Заголовок

  const resource = { values };

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: "A1:B",
      valueInputOption: "RAW",
      resource,
    });
    console.log("✅ Google Sheet обновлен");
  } catch (err) {
    console.error("❌ Ошибка при обновлении Google Sheets:", err);
  }
}

module.exports = { updateStats };
