const router = require("express").Router();
const { supabase } = require("./supabase");
const {
  PAD, FMT,
  calcularSemanaActual,
  ventasDeSelector,
  propinasDeVentas,
  semanaProxima,
} = require("./semanaUtils");
const { getNominaSemana, applyEdit } = require("./nomina");
const { usaLogicaNuevaPropinas } = require("./nominaCalc");

// ── Caché en memoria — lista de semanas disponibles (TTL 5 min) ───────────────
const _semsCache = { data: null, ts: 0 };
const SEMS_TTL   = 5 * 60 * 1000;

async function getSemsDisponibles(invalidar = false) {
  const ahora = Date.now();
  if (!invalidar && _semsCache.data && (ahora - _semsCache.ts) < SEMS_TTL) {
    return _semsCache.data;
  }
  const [ra, rm, rg] = await Promise.all([
    supabase.from("asistencias")  .select("semana").order("semana", { ascending: true }),
    supabase.from("ventas_mesero").select("semana").order("semana", { ascending: true }),
    supabase.from("ventas_grupo") .select("semana").order("semana", { ascending: true }),
  ]);
  const result = {
    semsA: [...new Set((ra.data||[]).map(r => r.semana))],
    semsM: [...new Set((rm.data||[]).map(r => r.semana))],
    semsG: [...new Set((rg.data||[]).map(r => r.semana))],
  };
  _semsCache.data = result;
  _semsCache.ts   = ahora;
  return result;
}

// GET /api/dashboard/semana-actual?semana=YYYY-MM-DD_a_YYYY-MM-DD
router.get("/semana-actual", async (req, res) => {
  try {
    const semanaParam = req.query.semana;
    const semana = semanaParam || calcularSemanaActual();

    // Semanas disponibles en Supabase (cacheadas 5 min)
    const { semsA, semsM, semsG } = await getSemsDisponibles();

    // ── Asistencias: exacta o la más reciente disponible (con fallback)
    const semanaAsist = semsA.includes(semana)
      ? semana
      : (semanaProxima(semana, semsA) || null);

    // ── Ventas actuales: WED-SUN derivado del selector. SIN fallback.
    // Si no hay PDF para esa semana → vacío.
    const semanaVentasIdeal  = ventasDeSelector(semana);
    const semanaVentasActual = semsM.includes(semanaVentasIdeal) ? semanaVentasIdeal : null;

    // ── Propinas: desde PROPINAS_LOGICA_NUEVA_DESDE se toman de la misma semana
    // de ventas actual (sin desfase); antes de esa fecha, de la semana WED-SUN
    // anterior — ambas SIN fallback (vacío si no hay PDF sincronizado).
    const semanaVentasPropinas = semanaVentasActual
      ? (usaLogicaNuevaPropinas(semanaVentasActual)
          ? semanaVentasActual
          : (semsM.includes(propinasDeVentas(semanaVentasActual))
              ? propinasDeVentas(semanaVentasActual)
              : null))
      : null;

    // ── Grupos: misma semana WED-SUN que ventas actuales. SIN fallback.
    const semanaGrupos = semanaVentasActual && semsG.includes(semanaVentasActual)
      ? semanaVentasActual
      : null;

    // Extraer año/mes del selector para gastos fijos
    const [selIni] = semana.split("_a_");
    const selDate  = new Date(selIni + "T12:00:00");
    const selAño   = selDate.getFullYear();
    const selMes   = selDate.getMonth() + 1;

    // ── Fetch paralelo con semanas calculadas ─────────────────────────────
    // Nómina/propinas ya no viven aquí — ver /api/nomina y /api/propinas.
    // `comidaRes` es compat con la UI actual (lee el override de comida guardado
    // en nomina_semanal para pintar comidaMap; ver POST /comida más abajo).
    const [asistRes, vmAct, vmProp, vgRes, comprasRes, gastosRes, comidaRes] = await Promise.all([
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
      supabase.from("compras").select("*").eq("semana", semana).order("fecha"),
      supabase.from("gastos_fijos").select("*").eq("año", selAño).eq("mes", selMes).order("concepto"),
      semanaAsist
        ? supabase.from("nomina_semanal").select("nombre_key, comida").eq("semana", semanaAsist)
        : Promise.resolve({ data: [] }),
    ]);

    const grupos = vgRes.data || [];
    const totalVentas = grupos
      .filter(g => !g.es_subgrupo)
      .reduce((a, g) => a + (Number(g.venta)||0), 0)
      || (vmAct.data||[]).reduce((a, m) => a + (Number(m.venta)||0), 0);

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
      compras:              comprasRes.data || [],
      gastosFijos:          gastosRes.data  || [],
      gastosMes:            { año: selAño, mes: selMes },
      comida:               (comidaRes.data || []).map(r => ({ nombre: r.nombre_key, monto: r.comida })),
    });

  } catch(e) {
    console.error("[DASHBOARD] Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/dashboard/semanas-disponibles?anio=2026&mes=7
// Todas las semanas (selector DOM-SAB) cuyo domingo cae en ese mes/año — misma
// regla de pertenencia a mes usada en toda la app — con los rangos reales de
// ventas/propinas ya resueltos, y si cada tipo de dato realmente tiene PDF sincronizado.
router.get("/semanas-disponibles", async (req, res) => {
  try {
    const anio = +req.query.anio || new Date().getFullYear();
    const mes  = +req.query.mes  || (new Date().getMonth() + 1);

    const { semsA, semsM, semsG } = await getSemsDisponibles();

    const semanas = [];
    let d = new Date(anio, mes - 1, 1, 12, 0, 0);
    while (d.getDay() !== 0) d.setDate(d.getDate() + 1); // primer domingo del mes
    while (d.getMonth() === mes - 1 && d.getFullYear() === anio) {
      const dom = new Date(d);
      const sab = new Date(dom); sab.setDate(dom.getDate() + 6);
      const selectorKey  = `${FMT(dom)}_a_${FMT(sab)}`;
      const ventasKey    = ventasDeSelector(selectorKey);
      const propinasKey  = usaLogicaNuevaPropinas(ventasKey) ? ventasKey : propinasDeVentas(ventasKey);
      const [vIni, vFin] = ventasKey.split("_a_");
      const [pIni, pFin] = propinasKey.split("_a_");
      semanas.push({
        selectorKey,
        domSab:        { inicio: FMT(dom), fin: FMT(sab) },
        ventasWedSun:  { inicio: vIni, fin: vFin },
        propinasWedSun:{ inicio: pIni, fin: pFin },
        tieneAsistencias: semsA.includes(selectorKey),
        tieneVentas:      semsM.includes(ventasKey),
        tieneGrupos:      semsG.includes(ventasKey),
      });
      d.setDate(d.getDate() + 7);
    }

    res.json({ ok: true, anio, mes, semanas });
  } catch(e) {
    console.error("[SEMANAS-DISPONIBLES] Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Compat: el frontend actual todavía guarda "comida" aquí (tabla `comida`,
// ya eliminada). Redirige al override persistido en `nomina_semanal` para no
// romper la UI en vivo mientras se actualiza el cliente para usar
// PUT /api/nomina/:semana/:nombre directamente.
router.post("/comida", async (req, res) => {
  try {
    const { semana, nombre, monto } = req.body;
    if (!semana || !nombre) return res.status(400).json({ ok:false, error:"Faltan campos" });
    await applyEdit(semana, nombre, { comida: monto || 0 });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post("/asistencia", async (req, res) => {
  try {
    const { semana, nombre, dias_asistidos, horas_reales } = req.body;
    if (!semana || !nombre) return res.status(400).json({ok:false, error:"Faltan campos"});
    await supabase.from("asistencias").delete().eq("semana", semana).eq("nombre", nombre);
    const { error } = await supabase.from("asistencias").insert({
      semana, nombre,
      dias_asistidos: dias_asistidos||0,
      horas_reales:   horas_reales||0,
      updated_at:     new Date().toISOString()
    });
    if (error) throw error;
    invalidarSemanas();
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

// Calcula todas las semanas (selector DOM-SAB) cuyo domingo cae en el mes dado,
// con su clave de ventas correspondiente (vía ventasDeSelector — mismo mapeo
// que usa el resto del dashboard, incluye el cutoff a DOM-SAB nuevo formato).
// Devuelve [{ventasKey, selectorKey}]
function semanasEnMes(año, mes) {
  const result = [];
  let d = new Date(año, mes - 1, 1, 12, 0, 0);
  while (d.getDay() !== 0) d.setDate(d.getDate() + 1); // primer domingo del mes
  while (d.getMonth() === mes - 1 && d.getFullYear() === año) {
    const dom = new Date(d);
    const sab = new Date(dom); sab.setDate(dom.getDate() + 6);
    const selectorKey = `${FMT(dom)}_a_${FMT(sab)}`;
    result.push({
      ventasKey:   ventasDeSelector(selectorKey),
      selectorKey,
    });
    d.setDate(d.getDate() + 7);
  }
  return result;
}

// GET /api/dashboard/balance-mensual?año=2026&mes=5
router.get("/balance-mensual", async (req, res) => {
  try {
    const año = +req.query.año || new Date().getFullYear();
    const mes  = +req.query.mes  || (new Date().getMonth() + 1);

    const semanas      = semanasEnMes(año, mes);
    const ventasKeys    = semanas.map(s => s.ventasKey);
    const selectorKeys  = semanas.map(s => s.selectorKey);

    // getNominaSemana ya trae, por semana, el catálogo de empleados + asistencias +
    // ventas + overrides corridos por el motor real (nominaCalc) — reemplaza la
    // lectura directa de nomina_semanal (que ahora solo guarda overrides, no snapshots).
    const [vmRes, vgRes, cpRes, gfRes, nominaPorSemana] = await Promise.all([
      supabase.from("ventas_mesero").select("*").in("semana", ventasKeys),
      supabase.from("ventas_grupo") .select("*").in("semana", ventasKeys),
      supabase.from("compras")      .select("*").in("semana", selectorKeys),
      supabase.from("gastos_fijos") .select("*").eq("año", año).eq("mes", mes).order("concepto"),
      Promise.all(selectorKeys.map(k => getNominaSemana(k))),
    ]);

    const semanasData = semanas.map(({ ventasKey, selectorKey }, i) => ({
      ventasKey,
      selectorKey,
      ventasMesero: (vmRes.data || []).filter(r => r.semana === ventasKey),
      ventasGrupo:  (vgRes.data || []).filter(r => r.semana === ventasKey),
      asistencias:  nominaPorSemana[i].asistencias,
      nomina:       nominaPorSemana[i].rows,
      compras:      (cpRes.data || []).filter(r => r.semana === selectorKey),
    }));

    res.json({ ok: true, semanas: semanasData, gastosFijos: gfRes.data || [], año, mes });
  } catch(e) {
    console.error("[BALANCE-MES] Error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/historico", async (req, res) => {
  try {
    const { data } = await supabase.from("resumen_semanal")
      .select("*").order("semana", { ascending: false }).limit(52);
    res.json({ ok:true, semanas: data||[] });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

function invalidarSemanas() { _semsCache.ts = 0; }

module.exports = router;
module.exports.invalidarSemanas = invalidarSemanas;
