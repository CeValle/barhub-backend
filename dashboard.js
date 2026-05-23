const router = require("express").Router();
const { supabase } = require("./supabase");

const PAD = n => String(n).padStart(2,"0");
const FMT = d => `${d.getFullYear()}-${PAD(d.getMonth()+1)}-${PAD(d.getDate())}`;

// Semana DOM-SAB actual
function calcularSemanaActual() {
  const hoy = new Date(), dow = hoy.getDay(), d = dow === 0 ? 7 : dow;
  const dom = new Date(hoy); dom.setDate(hoy.getDate() - d);
  const sab = new Date(dom); sab.setDate(dom.getDate() + 6);
  return `${FMT(dom)}_a_${FMT(sab)}`;
}

// DOM-SAB selector → WED-SUN de ventas (dom+3 a dom+7)
function ventasDeSelector(selectorKey) {
  const dom  = new Date(selectorKey.split("_a_")[0] + "T12:00:00");
  const mier = new Date(dom); mier.setDate(dom.getDate() + 3);
  const sun  = new Date(dom); sun.setDate(dom.getDate() + 7);
  return `${FMT(mier)}_a_${FMT(sun)}`;
}

// Propinas = semana WED-SUN anterior a la de ventas
function propinasDeVentas(semanaVentas) {
  const ini  = new Date(semanaVentas.split("_a_")[0] + "T12:00:00");
  const pIni = new Date(ini); pIni.setDate(ini.getDate() - 7);
  const pFin = new Date(pIni); pFin.setDate(pIni.getDate() + 4);
  return `${FMT(pIni)}_a_${FMT(pFin)}`;
}

// Semana más reciente disponible cuyo fin <= fin del target
function semanaProxima(target, disponibles) {
  if (!disponibles?.length) return null;
  const finTarget = new Date(target.split("_a_")[1] + "T23:59:59");
  const cands = disponibles.filter(s => new Date(s.split("_a_")[1] + "T23:59:59") <= finTarget);
  if (cands.length) return cands[cands.length - 1];
  return disponibles[disponibles.length - 1]; // más reciente si ninguna aplica
}

// GET /api/dashboard/semana-actual?semana=YYYY-MM-DD_a_YYYY-MM-DD
router.get("/semana-actual", async (req, res) => {
  try {
    const semanaParam = req.query.semana;
    const semana = semanaParam || calcularSemanaActual();

    // ── Obtener todas las semanas disponibles ─────────────────────────────
    const [asistSems, vmSems, vgSems] = await Promise.all([
      supabase.from("asistencias").select("semana").order("semana", { ascending: true }),
      supabase.from("ventas_mesero").select("semana").order("semana", { ascending: true }),
      supabase.from("ventas_grupo").select("semana").order("semana", { ascending: true }),
    ]);

    const semsAsist = [...new Set((asistSems.data||[]).map(r => r.semana))];
    const semsVM    = [...new Set((vmSems.data||[]).map(r => r.semana))];
    const semsVG    = [...new Set((vgSems.data||[]).map(r => r.semana))];

    // ── Asistencias: exacta, si no la más cercana disponible ──────────────
    const semanaAsist = semsAsist.includes(semana)
      ? semana
      : (semanaProxima(semana, semsAsist) || semsAsist[semsAsist.length - 1]);

    // ── Ventas: WED-SUN derivado del selector DOM-SAB ────────────────────
    const semanaVentasIdeal = ventasDeSelector(semana);
    const semanaVentasActual = semsVM.includes(semanaVentasIdeal)
      ? semanaVentasIdeal
      : (semanaProxima(semana, semsVM) || semsVM[semsVM.length - 1]);

    // ── Propinas: semana WED-SUN anterior a ventas actuales ───────────────
    const semanaVentasPropinas = propinasDeVentas(semanaVentasActual);

    // ── Grupos: misma clave WED-SUN que ventas ────────────────────────────
    const semanaGruposIdeal = semanaVentasIdeal;
    const semanaGrupos = semsVG.includes(semanaGruposIdeal)
      ? semanaGruposIdeal
      : (semanaProxima(semana, semsVG) || semsVG[semsVG.length - 1]);

    // ── Fetch paralelo ────────────────────────────────────────────────────
    const [asistRes, vmAct, vmProp, vgRes, nominaRes, comidaRes] = await Promise.all([
      supabase.from("asistencias").select("*").eq("semana", semanaAsist),
      supabase.from("ventas_mesero").select("*").eq("semana", semanaVentasActual),
      supabase.from("ventas_mesero").select("*").eq("semana", semanaVentasPropinas),
      supabase.from("ventas_grupo").select("*").eq("semana", semanaGrupos),
      supabase.from("nomina_semanal").select("*").eq("semana", semanaAsist),
      supabase.from("comida").select("*").eq("semana", semanaAsist),
    ]);

    res.json({
      ok: true,
      semana,
      semanaAsist,
      semanaVentasActual,
      semanaVentasPropinas,
      semanaGrupos,
      totalVentas:          (vgRes.data||[]).filter(g=>!g.es_subgrupo).reduce((a,g) => a + (g.venta||0), 0),
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
      { semana, nombre, monto: monto||0, updated_at: new Date().toISOString() },
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
    const ps = {};
    (data||[]).forEach(r => {
      if (!ps[r.semana]) ps[r.semana] = [];
      ps[r.semana].push(r);
    });
    res.json({ ok:true, semanas:Object.keys(ps).sort(), porSemana:ps, total:(data||[]).length });
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
