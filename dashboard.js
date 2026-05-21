const router = require("express").Router();
const { supabase } = require("./supabase");

const PAD = n => String(n).padStart(2,"0");
const FMT = d => `${d.getFullYear()}-${PAD(d.getMonth()+1)}-${PAD(d.getDate())}`;

// Calcula la semana DOM-SAB actual
function calcularSemanaActual() {
  const hoy = new Date();
  const dow  = hoy.getDay();
  const d    = dow === 0 ? 7 : dow;
  const dom  = new Date(hoy); dom.setDate(hoy.getDate() - d);
  const sab  = new Date(dom); sab.setDate(dom.getDate() + 6);
  return `${FMT(dom)}_a_${FMT(sab)}`;
}

// Dado un selector DOM-SAB → semana WED-SUN de ventas (dom+3 a dom+7)
function semanaVentasDesdeSelector(selectorKey) {
  const dom  = new Date(selectorKey.split("_a_")[0] + "T12:00:00");
  const mier = new Date(dom); mier.setDate(dom.getDate() + 3);
  const sun  = new Date(dom); sun.setDate(dom.getDate() + 7);
  return `${FMT(mier)}_a_${FMT(sun)}`;
}

// Semana WED-SUN de propinas = 7 días antes de la semana de ventas actual
function semanaPropinasDesde(semanaVentas) {
  const ini  = new Date(semanaVentas.split("_a_")[0] + "T12:00:00");
  const pIni = new Date(ini); pIni.setDate(ini.getDate() - 7);
  const pFin = new Date(pIni); pFin.setDate(pIni.getDate() + 4);
  return `${FMT(pIni)}_a_${FMT(pFin)}`;
}

// Fallback: si no hay dato exacto, busca el más cercano disponible
function semanaProxima(target, disponibles) {
  if (!disponibles?.length) return null;
  const finTarget = new Date(target.split("_a_")[1] + "T23:59:59");
  const cands = disponibles.filter(s => new Date(s.split("_a_")[1] + "T23:59:59") <= finTarget);
  return cands.length ? cands[cands.length - 1] : disponibles[0];
}

// GET /api/dashboard/semana-actual?semana=YYYY-MM-DD_a_YYYY-MM-DD
router.get("/semana-actual", async (req, res) => {
  try {
    const semanaParam = req.query.semana;
    let semana = semanaParam || calcularSemanaActual();

    // Sin param → fallback al DOM-SAB con datos
    if (!semanaParam) {
      const chk = await supabase.from("asistencias")
        .select("semana").eq("semana", semana).limit(1);
      if (!chk.data?.length) {
        const lat = await supabase.from("asistencias")
          .select("semana").order("semana", { ascending: false }).limit(1);
        if (lat.data?.length) semana = lat.data[0].semana;
      }
    }

    // Semana WED-SUN de ventas y propinas derivada directamente del selector DOM-SAB
    const semanaVentasActual   = semanaVentasDesdeSelector(semana);
    const semanaVentasPropinas = semanaPropinasDesde(semanaVentasActual);

    // Para grupos usamos la misma clave WED-SUN que ventas
    const semanaGrupos = semanaVentasActual;

    // Asistencias: semana exacta (DOM-SAB)
    const semanaAsist = semana;

    // Fetch paralelo
    const [vmAct, vmProp, vgRes, asistRes, nominaRes, comidaRes] = await Promise.all([
      supabase.from("ventas_mesero").select("*").eq("semana", semanaVentasActual),
      supabase.from("ventas_mesero").select("*").eq("semana", semanaVentasPropinas),
      supabase.from("ventas_grupo").select("*").eq("semana", semanaGrupos),
      supabase.from("asistencias").select("*").eq("semana", semanaAsist),
      supabase.from("nomina_semanal").select("*").eq("semana", semanaAsist),
      supabase.from("comida").select("*").eq("semana", semanaAsist),
    ]);

    // Si no hay ventas exactas, buscar la más cercana como fallback
    let ventasMesero = vmAct.data || [];
    let ventasPropinas = vmProp.data || [];
    let ventasGrupo = vgRes.data || [];

    if (!ventasMesero.length) {
      const all = await supabase.from("ventas_mesero").select("semana").order("semana", {ascending:true});
      const sems = [...new Set((all.data||[]).map(v=>v.semana))];
      const fb = semanaProxima(semana, sems);
      if (fb && fb !== semanaVentasActual) {
        const r = await supabase.from("ventas_mesero").select("*").eq("semana", fb);
        ventasMesero = r.data || [];
      }
    }
    if (!ventasGrupo.length) {
      const all = await supabase.from("ventas_grupo").select("semana").order("semana", {ascending:true});
      const sems = [...new Set((all.data||[]).map(v=>v.semana))];
      const fb = semanaProxima(semana, sems);
      if (fb && fb !== semanaGrupos) {
        const r = await supabase.from("ventas_grupo").select("*").eq("semana", fb);
        ventasGrupo = r.data || [];
      }
    }

    res.json({
      ok: true,
      semana,
      semanaVentasActual,
      semanaVentasPropinas,
      semanaGrupos,
      totalVentas:          ventasGrupo.reduce((a,g) => a + (g.venta||0), 0),
      ventasMesero,
      ventasMeseroPropinas: ventasPropinas,
      ventasGrupo,
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
