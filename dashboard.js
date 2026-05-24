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

// Selector DOM-SAB → semana WED-SUN de ventas (dom+3 a dom+7)
function ventasDeSelector(selectorKey) {
  const dom  = new Date(selectorKey.split("_a_")[0] + "T12:00:00");
  const mier = new Date(dom); mier.setDate(dom.getDate() + 3);
  const sun  = new Date(dom); sun.setDate(dom.getDate() + 7);
  return `${FMT(mier)}_a_${FMT(sun)}`;
}

// Propinas = semana WED-SUN exactamente anterior a la semana de ventas
function propinasDeVentas(semanaVentas) {
  const ini  = new Date(semanaVentas.split("_a_")[0] + "T12:00:00");
  const pIni = new Date(ini); pIni.setDate(ini.getDate() - 7);
  const pFin = new Date(pIni); pFin.setDate(pIni.getDate() + 4);
  return `${FMT(pIni)}_a_${FMT(pFin)}`;
}

// Fallback: semana más reciente cuyo fin <= fin del target (solo para asistencias)
function semanaProxima(target, disponibles) {
  if (!disponibles?.length) return null;
  const finT = new Date(target.split("_a_")[1] + "T23:59:59");
  const cands = disponibles.filter(s => new Date(s.split("_a_")[1] + "T23:59:59") <= finT);
  return cands.length ? cands[cands.length - 1] : disponibles[disponibles.length - 1];
}

// GET /api/dashboard/semana-actual?semana=YYYY-MM-DD_a_YYYY-MM-DD
router.get("/semana-actual", async (req, res) => {
  try {
    const semanaParam = req.query.semana;
    const semana = semanaParam || calcularSemanaActual();

    // Semanas disponibles en Supabase
    const [ra, rm, rg] = await Promise.all([
      supabase.from("asistencias").select("semana").order("semana", { ascending: true }),
      supabase.from("ventas_mesero").select("semana").order("semana", { ascending: true }),
      supabase.from("ventas_grupo").select("semana").order("semana", { ascending: true }),
    ]);

    const semsA = [...new Set((ra.data||[]).map(r => r.semana))];
    const semsM = [...new Set((rm.data||[]).map(r => r.semana))];
    const semsG = [...new Set((rg.data||[]).map(r => r.semana))];

    // ── Asistencias: exacta o la más reciente disponible (con fallback)
    const semanaAsist = semsA.includes(semana)
      ? semana
      : (semanaProxima(semana, semsA) || null);

    // ── Ventas actuales: WED-SUN derivado del selector. SIN fallback.
    // Si no hay PDF para esa semana → vacío.
    const semanaVentasIdeal  = ventasDeSelector(semana);
    const semanaVentasActual = semsM.includes(semanaVentasIdeal) ? semanaVentasIdeal : null;

    // ── Propinas: semana WED-SUN anterior a ventas actuales. SIN fallback.
    // Si no hay ventas actuales o no hay PDF de la semana anterior → vacío.
    const semanaVentasPropinas = semanaVentasActual
      ? (semsM.includes(propinasDeVentas(semanaVentasActual))
          ? propinasDeVentas(semanaVentasActual)
          : null)
      : null;

    // ── Grupos: misma semana WED-SUN que ventas actuales. SIN fallback.
    const semanaGrupos = semanaVentasActual && semsG.includes(semanaVentasActual)
      ? semanaVentasActual
      : null;

    // ── Fetch paralelo con semanas calculadas ─────────────────────────────
    const [asistRes, vmAct, vmProp, vgRes, nominaRes, comidaRes] = await Promise.all([
      semanaAsist
        ? supabase.from("asistencias").select("*").eq("semana", semanaAsist)
        : Promise.resolve({ data: [] }),
      semanaVentasActual
        ? supabase.from("ventas_mesero").select("*").eq("semana", semanaVentasActual)
        : Promise.resolve({ data: [] }),
      semanaVentasPropinas
        ? supabase.from("ventas_mesero").select("*").eq("semana", semanaVentasPropinas)
        : Promise.resolve({ data: [] }),
      semanaGrupos
        ? supabase.from("ventas_grupo").select("*").eq("semana", semanaGrupos)
        : Promise.resolve({ data: [] }),
      semanaAsist
        ? supabase.from("nomina_semanal").select("*").eq("semana", semanaAsist)
        : Promise.resolve({ data: [] }),
      semanaAsist
        ? supabase.from("comida").select("*").eq("semana", semanaAsist)
        : Promise.resolve({ data: [] }),
    ]);

    const grupos = vgRes.data || [];
    const totalVentas = grupos
      .filter(g => !g.es_subgrupo)
      .reduce((a, g) => a + (Number(g.venta)||0), 0);

    res.json({
      ok: true,
      semana,
      semanaAsist:          semanaAsist || semana,
      semanaVentasActual:   semanaVentasActual || semanaVentasIdeal,
      semanaVentasPropinas: semanaVentasPropinas,
      semanaGrupos:         semanaGrupos,
      totalVentas,
      ventasMesero:         vmAct.data  || [],
      ventasMeseroPropinas: vmProp.data || [],
      ventasGrupo:          grupos,
      asistencias:          asistRes.data  || [],
      nomina:               nominaRes.data || [],
      comida:               comidaRes.data || [],
    });

  } catch(e) {
    console.error("[DASHBOARD] Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
    res.json({ ok:true, semanas: data||[] });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
