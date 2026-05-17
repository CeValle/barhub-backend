const router = require("express").Router();
const { supabase } = require("./supabase");

function calcularSemanaActual() {
  const hoy = new Date();
  const dow  = hoy.getDay();
  const d    = dow === 0 ? 7 : dow;
  const dom  = new Date(hoy); dom.setDate(hoy.getDate() - d);
  const sab  = new Date(dom); sab.setDate(dom.getDate() + 6);
  const fmt  = x => x.toISOString().split("T")[0];
  return `${fmt(dom)}_a_${fmt(sab)}`;
}

// Fecha del sábado de una semana "YYYY-MM-DD_a_YYYY-MM-DD"
function semanaFin(key) {
  return new Date(key.split("_a_")[1] + "T23:59:59");
}

// Semana más cercana cuyo fin <= fin del target (la más reciente que no supera al target)
function semanaProxima(target, disponibles) {
  if (!disponibles || !disponibles.length) return null;
  const finTarget = semanaFin(target);
  const candidatas = disponibles.filter(s => semanaFin(s) <= finTarget);
  if (candidatas.length) return candidatas[candidatas.length - 1];
  return disponibles[0];
}

// GET /api/dashboard/semana-actual?semana=YYYY-MM-DD_a_YYYY-MM-DD
router.get("/semana-actual", async (req, res) => {
  try {
    const semanaParam = req.query.semana;
    let semana = semanaParam || calcularSemanaActual();

    // Sin param → fallback a semana más reciente con datos
    if (!semanaParam) {
      const chk = await supabase.from("asistencias")
        .select("semana").eq("semana", semana).limit(1);
      if (!chk.data?.length) {
        const lat = await supabase.from("asistencias")
          .select("semana").order("semana", { ascending: false }).limit(1);
        if (lat.data?.length) semana = lat.data[0].semana;
      }
    }

    // ── Todas las semanas disponibles ──────────────────────────────────────
    const [asistSems, vmSems, vgSems] = await Promise.all([
      supabase.from("asistencias").select("semana").order("semana", { ascending: true }),
      supabase.from("ventas_mesero").select("semana").order("semana", { ascending: true }),
      supabase.from("ventas_grupo").select("semana").order("semana", { ascending: true }),
    ]);

    const semanasAsist = [...new Set((asistSems.data||[]).map(r => r.semana))];
    const semanasVM    = [...new Set((vmSems.data||[]).map(r => r.semana))];
    const semanasVG    = [...new Set((vgSems.data||[]).map(r => r.semana))];

    // Semana más cercana para cada tipo de dato
    const semanaAsist          = semanaParam
      ? (semanaProxima(semana, semanasAsist) || semanasAsist[semanasAsist.length-1])
      : semana;
    const semanaVentasActual   = semanaProxima(semana, semanasVM) || semanasVM[semanasVM.length-1];
    const idxSVA               = semanasVM.indexOf(semanaVentasActual);
    const semanaVentasPropinas = idxSVA > 0 ? semanasVM[idxSVA - 1] : semanaVentasActual;
    const semanaGrupos         = semanaProxima(semana, semanasVG) || semanasVG[semanasVG.length-1];

    // ── Fetch paralelo ─────────────────────────────────────────────────────
    const [vmAct, vmProp, vgRes, asistRes, nominaRes, comidaRes] = await Promise.all([
      supabase.from("ventas_mesero").select("*").eq("semana", semanaVentasActual),
      supabase.from("ventas_mesero").select("*").eq("semana", semanaVentasPropinas),
      supabase.from("ventas_grupo").select("*").eq("semana", semanaGrupos),
      supabase.from("asistencias").select("*").eq("semana", semanaAsist),
      supabase.from("nomina_semanal").select("*").eq("semana", semanaAsist),
      supabase.from("comida").select("*").eq("semana", semanaAsist),
    ]);

    res.json({
      ok: true,
      semana:               semana,           // semana pedida por el selector
      semanaAsist,                            // semana real de asistencias
      semanaVentasActual,
      semanaVentasPropinas,
      semanaGrupos,
      totalVentas:          (vgRes.data||[]).reduce((a,g) => a + (g.venta||0), 0),
      ventasMesero:         vmAct.data  || [],
      ventasMeseroPropinas: vmProp.data || [],
      ventasGrupo:          vgRes.data  || [],
      asistencias:          asistRes.data  || [],
      nomina:               nominaRes.data || [],
      comida:               comidaRes.data || [],
    });

  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/dashboard/comida
router.post("/comida", async (req, res) => {
  try {
    const { semana, nombre, monto } = req.body;
    if (!semana || !nombre) return res.status(400).json({ ok:false, error:"Faltan campos" });
    const { error } = await supabase.from("comida").upsert(
      { semana, nombre, monto: monto || 0, updated_at: new Date().toISOString() },
      { onConflict: "semana,nombre" }
    );
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/dashboard/asistencias-anio?anio=2026
router.get("/asistencias-anio", async (req, res) => {
  try {
    const anio = req.query.anio || new Date().getFullYear();
    const { data, error } = await supabase.from("asistencias")
      .select("*").like("semana", `${anio}%`).order("semana", { ascending: true });
    if (error) throw error;
    const porSemana = {};
    (data||[]).forEach(r => {
      if (!porSemana[r.semana]) porSemana[r.semana] = [];
      porSemana[r.semana].push(r);
    });
    res.json({ ok:true, semanas:Object.keys(porSemana).sort(), porSemana, total:(data||[]).length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get("/historico", async (req, res) => {
  try {
    const { data } = await supabase.from("resumen_semanal")
      .select("*").order("semana", { ascending: false }).limit(52);
    res.json({ ok:true, semanas: data || [] });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
