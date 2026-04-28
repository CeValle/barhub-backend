const router       = require("express").Router();
const { supabase } = require("./supabase");

// GET /api/dashboard/semana-actual
router.get("/semana-actual", async (req, res) => {
  try {
    // Calcular semana actual (mié→jue)
    const hoy = new Date();
    const mie = new Date(hoy); mie.setDate(hoy.getDate() - ((hoy.getDay() + 4) % 7 + 1));
    const jue = new Date(mie); jue.setDate(mie.getDate() + 1);
    const fmt = d => d.toISOString().split("T")[0];
    const semana = `${fmt(mie)}_a_${fmt(jue)}`;

    const [ventasRes, gruposRes, asistRes, nominaRes] = await Promise.all([
      supabase.from("ventas_mesero").select("*").eq("semana", semana),
      supabase.from("ventas_grupo").select("*").eq("semana", semana),
      supabase.from("asistencias").select("*").eq("semana", semana),
      supabase.from("nomina_semanal").select("*").eq("semana", semana),
    ]);

    const totalVentas = (gruposRes.data || []).reduce((a,g) => a + g.venta, 0);

    res.json({
      ok: true,
      semana,
      totalVentas,
      ventasMesero: ventasRes.data  || [],
      ventasGrupo:  gruposRes.data  || [],
      asistencias:  asistRes.data   || [],
      nomina:       nominaRes.data  || [],
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/dashboard/historico
router.get("/historico", async (req, res) => {
  try {
    const { data } = await supabase
      .from("resumen_semanal")
      .select("*")
      .order("semana", { ascending: false })
      .limit(12);
    res.json({ ok: true, historico: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
