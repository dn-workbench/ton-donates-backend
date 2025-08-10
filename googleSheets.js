// googleSheets.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_TITLE = process.env.SHEET_TITLE || "Stats";

function readServiceAccount() {
  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      const parsed = JSON.parse(process.env.GOOGLE_CREDENTIALS);
      // 🔧 важно: превратить "\\n" в реальные переводы строк
      if (parsed.private_key && typeof parsed.private_key === "string") {
        parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      }
      return parsed;
    } catch (e) {
      throw new Error("GOOGLE_CREDENTIALS не парсится: " + e.message);
    }
  }
  if (!process.env.GOOGLE_CREDENTIALS_PATH) {
    throw new Error("Нужен GOOGLE_CREDENTIALS или GOOGLE_CREDENTIALS_PATH");
  }
  const filePath = path.resolve(process.env.GOOGLE_CREDENTIALS_PATH);
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.private_key && typeof parsed.private_key === "string") {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }
  return parsed;
}

function getSheetsClient() {
  if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID не задан");
  const creds = readServiceAccount();

  // 👇 полезный лог — виден в Render logs (не содержит приватный ключ!)
  console.log(
    "🟢 Sheets auth as:",
    creds.client_email,
    "| spreadsheet:",
    SPREADSHEET_ID,
    "| sheet:",
    SHEET_TITLE
  );

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

async function ensureSheetExists(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const has = meta.data.sheets?.some(
    (s) => s.properties?.title === SHEET_TITLE
  );
  if (has) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: SHEET_TITLE,
              gridProperties: { frozenRowCount: 1 },
            },
          },
        },
      ],
    },
  });
}

async function updateStats(statsObj) {
  // более подробные ошибки наружу — чтобы их было видно в Render logs
  try {
    const sheets = getSheetsClient();
    await ensureSheetExists(sheets);

    const rows = Object.entries(statsObj || {})
      .map(([country, amount]) => [country, Number(amount) || 0])
      .sort((a, b) => b[1] - a[1]);

    const now = new Date().toISOString();
    const values = [
      ["Country", "Amount (TON)", "UpdatedAt"],
      ...rows.map(([c, a]) => [c, a, now]),
    ];

    const range = `${SHEET_TITLE}!A1:C`;

    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TITLE}!A1`,
      valueInputOption: "RAW",
      requestBody: { values },
    });

    // автоширина колонок (по возможности)
    try {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID,
      });
      const sheetId = meta.data.sheets.find(
        (s) => s.properties.title === SHEET_TITLE
      ).properties.sheetId;
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [
            {
              autoResizeDimensions: {
                dimensions: {
                  sheetId,
                  dimension: "COLUMNS",
                  startIndex: 0,
                  endIndex: 3,
                },
              },
            },
          ],
        },
      });
    } catch (e) {
      console.warn("ℹ️ Автоширина не применена:", e.message);
    }

    console.log("✅ Google Sheet обновлён:", rows.length, "строк");
  } catch (err) {
    // раньше тут была тихая варнинга — сделаем явную ошибку
    console.error("❌ updateStats error:", err.response?.data || err.message);
    throw err;
  }
}

module.exports = { updateStats };
