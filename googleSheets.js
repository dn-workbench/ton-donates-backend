// googleSheets.js
require("dotenv").config();
const { GoogleSpreadsheet } = require("google-spreadsheet");

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_TITLE = process.env.SHEET_TITLE || "Stats";

if (!SPREADSHEET_ID) {
  throw new Error("SPREADSHEET_ID не задан в .env");
}

async function updateStats(statsObj) {
  try {
    // Загружаем сервисный аккаунт
    let creds;
    if (process.env.GOOGLE_CREDENTIALS) {
      creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } else if (process.env.GOOGLE_CREDENTIALS_PATH) {
      creds = require(process.env.GOOGLE_CREDENTIALS_PATH);
    } else {
      throw new Error(
        "Не найдены GOOGLE_CREDENTIALS или GOOGLE_CREDENTIALS_PATH"
      );
    }

    const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: creds.client_email,
      private_key: creds.private_key,
    });

    await doc.loadInfo();

    // Создаём лист, если нет
    let sheet = doc.sheetsByTitle[SHEET_TITLE];
    if (!sheet) {
      sheet = await doc.addSheet({
        title: SHEET_TITLE,
        headerValues: ["Country", "Amount (TON)"],
      });
    }

    // Очищаем лист
    await sheet.clear();
    await sheet.setHeaderRow(["Country", "Amount (TON)"]);

    // Заполняем данными
    const rows = Object.entries(statsObj).map(([country, amount]) => ({
      Country: country,
      "Amount (TON)": Number(amount) || 0,
    }));
    await sheet.addRows(rows);

    console.log("✅ Google Sheet обновлён");
  } catch (err) {
    console.error("⚠️ updateStats error:", err.message);
  }
}

module.exports = { updateStats };
