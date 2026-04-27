require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const cron    = require("node-cron");

const app  = express();
app.use(cors());
app.use(express.json());

// ── RUTAS ─────────────────────────────────────────────────────────────────────
app.use("/api/sync",      require("./routes/sync"));
app.use("/api/nomina",    require("./routes/nomina"));
app.use("/api/propinas",  require("./routes/propinas"));
app.use("/api/dashboard", require("./routes/dashboard"));

app.get("/health", (_req, res) => res.json({ ok: true, project: "barhub", ts: new Date().toISOString() }));

// ── CRON: Viernes 2 PM (Mexicali = UTC-7, 21:00 UTC) ─────────────────────────
// "0 21 * * 5" = cada viernes a las 21:00 UTC = 2 PM Mexicali/Hermosillo (MST)
cron.schedule("0 21 * * 5", async () => {
  console.log(`[CRON] Iniciando sync semanal: ${new Date().toISOString()}`);
  try {
    const { syncSemanal } = require("./services/driveSync");
    const resultado = await syncSemanal();
    console.log("[CRON] Sync completado:", JSON.stringify(resultado, null, 2));
  } catch (err) {
    console.error("[CRON] Error en sync:", err.message);
  }
}, { timezone: "America/Hermosillo" });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BarHub backend corriendo en puerto ${PORT}`);
  console.log(`Cron job: viernes 2 PM Mexicali (21:00 UTC)`);
});
