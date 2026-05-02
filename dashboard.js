const router = require("express").Router();
const { supabase } = require("./supabase");

function calcularSemana() {
  const hoy = new Date();
  const dow = hoy.getDay();
  let diasAtras = (dow + 4) % 7;
  if (diasAtras === 0) diasAtras = 7;
  const mie = new Date(hoy); mie.setDate(hoy.getDate() - diasAtras);
  const jue = new Date(mie); jue.setDate(mie.getDate() + 1);
  const fmt = d => d.toISOString().split("T")[0];
  return `${fmt(mie)}_a_${fmt(jue)}`;
}

router.get("/semana-actual", async (req, res) => {
  try {
    let semana = calcularSemana();
    const check = await supabase.from("ventas_mesero").select("semana").eq("semana", semana).limit(1);
    if (!check.data || check.data.length === 0) {
      const latest = await supabase.from("ventas_mesero").select("semana").order("semana", { ascending: false }).limit(1);
      if (latest.data && latest.data.length > 0) semana = latest.data[0].semana;
    }
    const [ventasRes, gruposRes, asistRes, nominaRes] = await Promise.all([
      supabase.from("ventas_mesero").select("*").eq("semana", semana),
      supabase.from("ventas_grupo").select("*").eq("semana", semana),
      supabase.from("asistencias").select("*").eq("semana", semana),
      supabase.from("nomina_semanal").select("*").eq("semana", semana),
    ]);
    const totalVentas = (gruposRes.data || []).reduce((a,g) => a + g.venta, 0);
    res.json({
      ok: true, semana, totalVentas,
      ventasMesero: ventasRes.data || [],
      ventasGrupo:  gruposRes.data || [],
      asistencias:  asistRes.data  || [],
      nomina:       nominaRes.data || [],
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/historico", async (req, res) => {
  try {
    const { data } = await supabase.from("resumen_semanal").select("*").order("semana", { ascending: false }).limit(12);
    res.json({ ok: true, semanas: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
