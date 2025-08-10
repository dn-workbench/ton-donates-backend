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
      return JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } catch (e) {
      throw new Error("GOOGLE_CREDENTIALS не парсится: " + e.message);
    }
  }
  if (!process.env.GOOGLE_CREDENTIALS_PATH) {
    throw new Error("Нужен GOOGLE_CREDENTIALS или GOOGLE_CREDENTIALS_PATH");
  }
  const filePath = path.resolve(process.env.GOOGLE_CREDENTIALS_PATH);
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function getSheetsClient() {
  if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID не задан");
  const creds = readServiceAccount();

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
    // очищаем и записываем заново
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
    } catch (_) {}

    console.log("✅ Google Sheet обновлён");
  } catch (err) {
    console.warn(
      "⚠️  updateStats: не удалось обновить Google Sheets:",
      err.message
    );
  }
}

module.exports = { updateStats };
