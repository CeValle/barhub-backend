require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");

const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","x-app-secret"] }));
app.use(express.json({ limit: "15mb" }));

app.use("/api/sync",      require("./sync"));
app.use("/api/nomina",    require("./nomina"));
app.use("/api/propinas",  require("./propinas"));
app.use("/api/dashboard", require("./dashboard"));
app.use("/api/compras",   require("./compras"));
app.use("/api/gastos",    require("./gastos"));

app.get("/health", (_req, res) => res.json({ ok: true, project: "barhub", version: "fix-foto-v5", ts: new Date().toISOString() }));

// ── PWA assets ────────────────────────────────────────────────────────────────
app.get("/manifest.json", (_req, res) => {
    res.setHeader("Content-Type", "application/manifest+json");
    res.sendFile(path.join(__dirname, "manifest.json"));
});

app.get("/sw.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Service-Worker-Allowed", "/barhub");
    res.sendFile(path.join(__dirname, "sw.js"));
});

app.get("/barhub-icon.svg", (_req, res) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="80" fill="#0D0F0E"/>
<rect x="24" y="24" width="464" height="464" rx="60" fill="#141716" stroke="#2A2E2B" stroke-width="2"/>
<text x="256" y="360" text-anchor="middle" font-family="Arial,sans-serif" font-size="280" font-weight="800" fill="#4ADE80">B</text>
</svg>`;
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(svg);
});

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

// Manejador de errores global — siempre devuelve JSON, nunca HTML
app.use((err, _req, res, _next) => {
    if (err.type === "entity.too.large")
        return res.status(413).json({ ok: false, error: "Imagen demasiado grande (máx 15 MB)" });
    if (err.status === 400 && err.type === "entity.parse.failed")
        return res.status(400).json({ ok: false, error: "JSON inválido en el body" });
    console.error("[ERROR]", err.message);
    res.status(err.status || 500).json({ ok: false, error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("BarHub backend corriendo en puerto " + PORT);
});
