const router   = require("express").Router();
const { syncSemanal } = require("./driveSync");

// POST /api/sync/manual
router.post("/manual", async (req, res) => {
    const secret = req.headers["x-app-secret"];
    if (secret !== process.env.APP_SECRET) {
          return res.status(401).json({ error: "No autorizado" });
    }
    try {
          console.log("[SYNC MANUAL] Iniciado");
          const resultado = await syncSemanal();
          res.json({ ok: true, resultado });
    } catch (err) {
          console.error("[SYNC MANUAL] Error:", err.message);
          res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
