require("dotenv").config();
const { updateStats } = require("./googleSheets");

(async () => {
  try {
    const dummyStats = {
      "United States": 1.23,
      India: 0.45,
      Japan: 2.78,
    };
    await updateStats(dummyStats);
    console.log("✅ Тестовые данные отправлены в Google Sheets");
  } catch (e) {
    console.error("❌ Ошибка теста:", e);
  }
})();
