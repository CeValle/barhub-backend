// Ejecutado por Railway Cron Job cada viernes 21:00 UTC (2 PM Hermosillo)
// No forma parte del servidor Express — es un proceso independiente de corta duración.
require("dotenv").config();
const https = require("https");

const HOST   = (process.env.BARHUB_URL || "https://web-production-1975f.up.railway.app").replace(/^https?:\/\//, "");
const SECRET = process.env.APP_SECRET  || "BarHub2026";

function llamarSync() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const req  = https.request({
      hostname: HOST,
      path:     "/api/sync/manual",
      method:   "POST",
      timeout:  120000, // 2 min — contempla cold start si el servidor estaba dormido
      headers: {
        "Content-Type":   "application/json",
        "x-app-secret":   SECRET,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", c  => { data += c; });
      res.on("end",  ()  => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout 120s")); });
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log("[CRON-SYNC] Disparando sync:", new Date().toISOString());
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const r = await llamarSync();
      console.log(`[CRON-SYNC] OK (intento ${intento}) status=${r.status}`, r.body.slice(0, 300));
      process.exit(0);
    } catch (e) {
      console.warn(`[CRON-SYNC] Intento ${intento} fallido:`, e.message);
      if (intento < 3) await new Promise(r => setTimeout(r, 15000));
    }
  }
  console.error("[CRON-SYNC] Sync fallido después de 3 intentos");
  process.exit(1);
}

main();
