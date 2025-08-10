// googleSheets.js
const { google } = require("googleapis");

function readServiceAccountFromEnv() {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;

  if (!rawJson && !b64) {
    throw new Error(
      "Нет ключа: GOOGLE_SERVICE_ACCOUNT_JSON или GOOGLE_SERVICE_ACCOUNT_BASE64"
    );
  }
  try {
    const json = rawJson
      ? rawJson
      : Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch (e) {
    throw new Error("Невалидный ключ сервис-аккаунта: " + e.message);
  }
}

function createSheetsClient() {
  const creds = readServiceAccountFromEnv();
  const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    scopes,
    null
  );
  return google.sheets({ version: "v4", auth });
}

async function getSpreadsheet(sheets, spreadsheetId) {
  const { data } = await sheets.spreadsheets.get({ spreadsheetId });
  return data;
}

async function ensureSheetExists(sheets, spreadsheetId, sheetTitle) {
  const ss = await getSpreadsheet(sheets, spreadsheetId);
  const found = (ss.sheets || []).find(
    (s) => s.properties?.title === sheetTitle
  );

  if (found) return found.properties.sheetId;

  // создаём вкладку
  const batchReq = {
    spreadsheetId,
    resource: {
      requests: [
        {
          addSheet: {
            properties: {
              title: sheetTitle,
              gridProperties: { rowCount: 1000, columnCount: 10 },
            },
          },
        },
      ],
    },
  };
  const res = await sheets.spreadsheets.batchUpdate(batchReq);
  const sheetId = res.data.replies?.[0]?.addSheet?.properties?.sheetId;
  return sheetId;
}

async function clearRange(sheets, spreadsheetId, rangeA1) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: rangeA1,
  });
}

function toRows(stats) {
  // stats: { "United States": 1.234, "India": 0.5, ... }
  const entries = Object.entries(stats || {}).sort((a, b) => b[1] - a[1]);
  const nowIso = new Date().toISOString();
  const header = ["Country", "TON", "UpdatedAt"];
  const rows = entries.map(([country, amount]) => [
    country,
    Number(amount || 0),
    nowIso,
  ]);
  return { header, rows };
}

async function writeAll(sheets, spreadsheetId, sheetTitle, header, rows) {
  // Пишем шапку + данные одним batchUpdate для минимизации квоты
  const body = {
    data: [
      {
        range: `${sheetTitle}!A1:C1`,
        values: [header],
      },
      {
        range: `${sheetTitle}!A2:C${rows.length + 1}`,
        values: rows.length ? rows : [["", "", ""]],
      },
    ],
    valueInputOption: "USER_ENTERED",
    includeValuesInResponse: false,
  };
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    resource: body,
  });
}

async function autosizeColumns(sheets, spreadsheetId, sheetId) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
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
}

function withRetry(fn, attempts = 3) {
  return async (...args) => {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn(...args);
      } catch (e) {
        lastErr = e;
        // 429/5xx — подождём чуть-чуть
        const code = e?.code || e?.response?.status;
        if (code && (code === 429 || code >= 500)) {
          await new Promise((r) => setTimeout(r, 500 * Math.pow(2, i)));
          continue;
        }
        break;
      }
    }
    throw lastErr;
  };
}

/**
 * Главная функция: принимает объект stats и полностью обновляет таблицу.
 * Вызывается из вашего index.js -> updateStats(stats)
 */
async function updateStats(stats) {
  const spreadsheetId = process.env.SHEET_ID;
  if (!spreadsheetId) throw new Error("SHEET_ID не задан");

  const sheetTitle = process.env.SHEET_TAB || "Stats";
  const sheets = createSheetsClient();

  const ensureSheet = withRetry(ensureSheetExists);
  const clear = withRetry(clearRange);
  const write = withRetry(writeAll);
  const auto = withRetry(autosizeColumns);

  const sheetId = await ensureSheet(sheets, spreadsheetId, sheetTitle);

  const { header, rows } = toRows(stats);

  // Чистим разумный диапазон, вдруг строк стало меньше
  await clear(sheets, spreadsheetId, `${sheetTitle}!A1:C10000`);
  await write(sheets, spreadsheetId, sheetTitle, header, rows);
  await auto(sheets, spreadsheetId, sheetId);

  return { ok: true, rows: rows.length };
}

module.exports = { updateStats };
