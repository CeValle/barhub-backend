const router = require("express").Router();
const { supabase } = require("./supabase");

// Semana domingo→sábado para asistencias/nómina
function calcularSemanaAsistencias() {
  const hoy = new Date();
  const dow = hoy.getDay();
  const d = dow === 0 ? 7 : dow;
  const dom = new Date(hoy); dom.setDate(hoy.getDate()-d);
  const sab = new Date(dom); sab.setDate(dom.getDate()+6);
  const fmt = d => d.toISOString().split("T")[0];
  return `${fmt(dom)}_a_${fmt(sab)}`;
}

// GET /api/dashboard/semana-actual?semana=YYYY-MM-DD_a_YYYY-MM-DD (opcional)
router.get("/semana-actual", async (req, res) => {
  try {
    // Si se pasa semana por query param, usar esa; si no, calcular la actual
    let semana = req.query.semana || calcularSemanaAsistencias();

    // Si no hay datos para la semana solicitada, usar la más reciente con datos
    const check = await supabase.from("asistencias").select("semana").eq("semana",semana).limit(1);
    if (!check.data || check.data.length===0) {
      const latest = await supabase.from("asistencias").select("semana").order("semana",{ascending:false}).limit(1);
      if (latest.data?.length) semana = latest.data[0].semana;
    }

    // Ventas: las 2 semanas más recientes de ventas_mesero
    const todasVentas = await supabase.from("ventas_mesero").select("*").order("semana",{ascending:false});
    const semanasV = [...new Set((todasVentas.data||[]).map(v=>v.semana))].sort().reverse();
    const semanaVentasActual   = semanasV[0] || semana;
    const semanaVentasPropinas = semanasV[1] || semanasV[0] || semana;
    const ventasActual   = (todasVentas.data||[]).filter(v=>v.semana===semanaVentasActual);
    const ventasPropinas = (todasVentas.data||[]).filter(v=>v.semana===semanaVentasPropinas);

    const [gruposRes, asistRes, nominaRes, comidaRes] = await Promise.all([
      supabase.from("ventas_grupo").select("*").eq("semana",semanaVentasActual),
      supabase.from("asistencias").select("*").eq("semana",semana),
      supabase.from("nomina_semanal").select("*").eq("semana",semana),
      supabase.from("comida").select("*").eq("semana",semana),
    ]);

    res.json({
      ok:true, semana, semanaVentasActual, semanaVentasPropinas,
      totalVentas: (gruposRes.data||[]).reduce((a,g)=>a+g.venta,0),
      ventasMesero:         ventasActual,
      ventasMeseroPropinas: ventasPropinas,
      ventasGrupo:  gruposRes.data||[],
      asistencias:  asistRes.data||[],
      nomina:       nominaRes.data||[],
      comida:       comidaRes.data||[],
    });
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

// POST /api/dashboard/comida
router.post("/comida", async (req, res) => {
  try {
    const { semana, nombre, monto } = req.body;
    if (!semana || !nombre) return res.status(400).json({ok:false,error:"Faltan campos"});
    const { error } = await supabase.from("comida").upsert(
      { semana, nombre, monto:monto||0, updated_at:new Date().toISOString() },
      { onConflict:"semana,nombre" }
    );
    if (error) throw error;
    res.json({ok:true});
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

// GET /api/dashboard/asistencias-anio?anio=2026
router.get("/asistencias-anio", async (req, res) => {
  try {
    const anio = req.query.anio || new Date().getFullYear();
    const { data, error } = await supabase
      .from("asistencias")
      .select("*")
      .like("semana", `${anio}%`)
      .order("semana", { ascending: true });
    if (error) throw error;
    const porSemana = {};
    (data||[]).forEach(r => {
      if (!porSemana[r.semana]) porSemana[r.semana] = [];
      porSemana[r.semana].push(r);
    });
    res.json({ ok:true, semanas:Object.keys(porSemana).sort(), porSemana, total:(data||[]).length });
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

// GET /api/dashboard/historico
router.get("/historico", async (req,res) => {
  try {
    const {data} = await supabase.from("resumen_semanal").select("*").order("semana",{ascending:false}).limit(52);
    res.json({ok:true, semanas:data||[]});
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

module.exports = router;
