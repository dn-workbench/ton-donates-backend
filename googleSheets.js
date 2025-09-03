// googleSheets.js
// Обновляет Google Sheet по схеме: два столбца — Country | Amount
// Требует сервисный аккаунт и переменные окружения (см. ниже).

const { google } = require("googleapis");

const SHEET_ID = process.env.SHEET_ID; // ID таблицы
const SHEET_TAB = process.env.SHEET_TAB || "Sheet1"; // Имя листа/вкладки

// Сервисный аккаунт (email и приватный ключ)
const SVC_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
let SVC_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || "";

// Если ключ пришёл с экранированными \n — восстановим настоящие переводы строк
if (SVC_PRIVATE_KEY.includes("\\n")) {
  SVC_PRIVATE_KEY = SVC_PRIVATE_KEY.replace(/\\n/g, "\n");
}

// Создаём клиента
function getSheetsClient() {
  if (!SHEET_ID) throw new Error("SHEET_ID is required");
  if (!SVC_EMAIL || !SVC_PRIVATE_KEY) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_PRIVATE_KEY are required"
    );
  }

  const auth = new google.auth.JWT({
    email: SVC_EMAIL,
    key: SVC_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

/**
 * Обновляет лист: шапка и все пары Country|Amount (отсортировано по Amount desc).
 * @param {Record<string, number>} stats - объект вида { "United States": 12.34, "France": 1.1, ... }
 */
async function updateStats(stats) {
  const sheets = getSheetsClient();

  // Преобразуем объект в массив строк
  const rows = Object.entries(stats || {})
    .map(([country, amount]) => [country, Number(amount || 0)])
    // Убираем пустые/некорректные ключи
    .filter(([country]) => country && typeof country === "string")
    // Сортируем по сумме по убыванию
    .sort((a, b) => b[1] - a[1]);

  // Готовим данные с заголовком
  const values = [["Country", "Amount"], ...rows];

  // Очищаем диапазон на листе и записываем новые данные
  // Можно очищать весь лист, а можно диапазон A:B — хватит двух столбцов
  const range = `${SHEET_TAB}!A:B`;

  // Сначала clear, потом write — самый простой и предсказуемый способ
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: "RAW", // или USER_ENTERED, если хочешь авто-формат
    requestBody: {
      values,
    },
  });

  return { ok: true, updated: rows.length };
}

module.exports = { updateStats };
