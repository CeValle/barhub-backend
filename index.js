require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const cron    = require("node-cron");
const path    = require("path");
const fs      = require("fs");

const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","x-app-secret"] }));
app.use(express.json());

app.use("/api/sync",      require("./sync"));
app.use("/api/nomina",    require("./nomina"));
app.use("/api/propinas",  require("./propinas"));
app.use("/api/dashboard", require("./dashboard"));

app.get("/health", (_req, res) => res.json({ ok: true, project: "barhub", ts: new Date().toISOString() }));

app.get("/barhub", (_req, res) => {
    const htmlPath = path.join(__dirname, "barhub.html");
    if (!fs.existsSync(htmlPath)) {
        return res.status(200).setHeader("Content-Type","text/html").send(
            "<h1>BarHub</h1><p>Falta barhub.html en el repo. Sube el archivo al repositorio de GitHub.</p>"
        );
    }
    const html = fs.readFileSync(htmlPath, "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
});

cron.schedule("0 21 * * 5", async () => {
    console.log("[CRON] Iniciando sync: " + new Date().toISOString());
    try {
        const { syncSemanal } = require("./driveSync");
        const resultado = await syncSemanal();
        console.log("[CRON] Completado:", JSON.stringify(resultado));
    } catch (err) {
        console.error("[CRON] Error:", err.message);
    }
}, { timezone: "America/Hermosillo" });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("BarHub backend corriendo en puerto " + PORT);
});
