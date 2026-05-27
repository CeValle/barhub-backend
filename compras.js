const router = require("express").Router();
const { supabase } = require("./supabase");

// GET /api/compras?semana=YYYY-MM-DD_a_YYYY-MM-DD
router.get("/", async (req, res) => {
  try {
    const { semana } = req.query;
    if (!semana) return res.status(400).json({ ok: false, error: "Falta semana" });
    const { data, error } = await supabase.from("compras").select("*").eq("semana", semana).order("fecha", { ascending: true });
    if (error) throw error;
    res.json({ ok: true, compras: data || [] });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/compras
router.post("/", async (req, res) => {
  try {
    const { semana, fecha, proveedor, descripcion, monto, area } = req.body;
    if (!semana || !proveedor) return res.status(400).json({ ok: false, error: "Faltan campos" });
    const { data, error } = await supabase.from("compras").insert({
      semana, fecha: fecha || null, proveedor, descripcion: descripcion || null,
      monto: +monto || 0, area: area || "compartido", updated_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, compra: data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/compras/:id
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await supabase.from("compras").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
