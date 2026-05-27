const router = require("express").Router();
const { supabase } = require("./supabase");

// GET /api/gastos?año=2026&mes=5
router.get("/", async (req, res) => {
  try {
    const { año, mes } = req.query;
    if (!año || !mes) return res.status(400).json({ ok: false, error: "Faltan año y mes" });
    const { data, error } = await supabase.from("gastos_fijos")
      .select("*").eq("año", +año).eq("mes", +mes).order("concepto");
    if (error) throw error;
    res.json({ ok: true, gastos: data || [] });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/gastos  (upsert por año+mes+concepto)
router.post("/", async (req, res) => {
  try {
    const { año, mes, concepto, monto, area } = req.body;
    if (!año || !mes || !concepto) return res.status(400).json({ ok: false, error: "Faltan campos" });
    const { data, error } = await supabase.from("gastos_fijos").upsert(
      { año: +año, mes: +mes, concepto, monto: +monto || 0, area: area || "compartido", updated_at: new Date().toISOString() },
      { onConflict: "año,mes,concepto" }
    ).select().single();
    if (error) throw error;
    res.json({ ok: true, gasto: data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/gastos/:id
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await supabase.from("gastos_fijos").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
