const router = require("express").Router();
const { supabase } = require("./supabase");
const { calcNomina, usaLogicaNuevaPropinas } = require("./nominaCalc");
const { ventasDeSelector, propinasDeVentas } = require("./semanaUtils");

// Reúne todos los datos de una semana (selector DOM-SAB) y corre el motor de cálculo.
// Compartido por las rutas de /api/nomina, /api/propinas y por el balance mensual
// del dashboard — un solo lugar que sabe cómo armar una semana de nómina.
async function getNominaSemana(semanaSelector) {
  const semanaVentas   = ventasDeSelector(semanaSelector);
  const semanaPropinas = propinasDeVentas(semanaVentas);

  const [empRes, asistRes, ventasRes, ventasPropRes, ovRes] = await Promise.all([
    supabase.from("empleados").select("*").eq("activo", true).order("orden"),
    supabase.from("asistencias").select("*").eq("semana", semanaSelector),
    supabase.from("ventas_mesero").select("*").eq("semana", semanaVentas),
    supabase.from("ventas_mesero").select("*").eq("semana", semanaPropinas),
    supabase.from("nomina_semanal").select("*").eq("semana", semanaSelector),
  ]);

  const overrides = {};
  (ovRes.data || []).forEach(r => { overrides[r.nombre_key] = r; });

  const empleados   = empRes.data       || [];
  const asistencias = asistRes.data     || [];
  const ventas      = ventasRes.data    || [];
  const ventasProp  = ventasPropRes.data|| [];

  const rows = calcNomina({ empleados, asistencias, ventas, ventasProp, overrides, semanaVentas });
  const logicaNueva = usaLogicaNuevaPropinas(semanaVentas);

  return { rows, empleados, asistencias, ventas, ventasProp, semana: semanaSelector, semanaVentas, semanaPropinas, logicaNueva };
}

// Persiste una edición de cualquier campo para un empleado en una semana.
// dias/horas → tabla `asistencias` (reemplaza el registro, igual que antes).
// pagoFijo/moche/propTarjeta/propPiso/comida/nota → tabla `nomina_semanal` (overrides).
// Un valor `null` explícito limpia ese override y vuelve al cálculo por defecto.
async function applyEdit(semana, nombre, body) {
  const b = body || {};
  const nombre_key = nombre.toLowerCase().trim();

  if (b.dias !== undefined || b.horas !== undefined) {
    const { data: existing } = await supabase.from("asistencias").select("*")
      .eq("semana", semana).eq("nombre", nombre).limit(1);
    const prev = (existing && existing[0]) || {};
    await supabase.from("asistencias").delete().eq("semana", semana).eq("nombre", nombre);
    const { error } = await supabase.from("asistencias").insert({
      semana, nombre,
      dias_asistidos: b.dias  !== undefined ? (b.dias  || 0) : (prev.dias_asistidos || 0),
      horas_reales:   b.horas !== undefined ? (b.horas || 0) : (prev.horas_reales   || 0),
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  const overrideFields = ["pagoFijo", "moche", "propTarjeta", "propPiso", "comida", "nota"];
  if (overrideFields.some(f => b[f] !== undefined)) {
    const { data: existingOv } = await supabase.from("nomina_semanal").select("*")
      .eq("semana", semana).eq("nombre_key", nombre_key).limit(1);
    const prevOv = (existingOv && existingOv[0]) || {};
    const row = {
      semana, nombre_key,
      pago_override:         b.pagoFijo    !== undefined ? b.pagoFijo    : (prevOv.pago_override         ?? null),
      moche_override:        b.moche       !== undefined ? b.moche       : (prevOv.moche_override        ?? null),
      prop_tarjeta_override: b.propTarjeta !== undefined ? b.propTarjeta : (prevOv.prop_tarjeta_override ?? null),
      prop_piso_override:    b.propPiso    !== undefined ? b.propPiso    : (prevOv.prop_piso_override    ?? null),
      comida:                b.comida      !== undefined ? (b.comida || 0) : (prevOv.comida ?? 0),
      nota:                  b.nota        !== undefined ? b.nota        : (prevOv.nota ?? null),
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("nomina_semanal").upsert(row, { onConflict: "semana,nombre_key" });
    if (error) throw error;
  }
}

function totalizar(rows) {
  return rows.reduce((acc, r) => ({
    sueldo:      acc.sueldo      + (r.sueldo      || 0),
    moche:       acc.moche       + (r.moche       || 0),
    propTarjeta: acc.propTarjeta + (r.propTarjeta || 0),
    propPiso:    acc.propPiso    + (r.propPiso    || 0),
    comida:      acc.comida      + (r.comida      || 0),
    total:       acc.total       + (r.total       || 0),
    totalNeto:   acc.totalNeto   + (r.totalNeto   || 0),
  }), { sueldo:0, moche:0, propTarjeta:0, propPiso:0, comida:0, total:0, totalNeto:0 });
}

// GET /api/nomina/:semana
router.get("/:semana", async (req, res) => {
  try {
    const { semana } = req.params;
    const { rows, semanaVentas, semanaPropinas, logicaNueva } = await getNominaSemana(semana);
    res.json({ ok: true, semana, semanaVentas, semanaPropinas, logicaNueva, rows, totales: totalizar(rows) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PUT /api/nomina/:semana/:nombre
router.put("/:semana/:nombre", async (req, res) => {
  try {
    const { semana, nombre } = req.params;
    await applyEdit(semana, nombre, req.body);
    const { rows, semanaVentas, semanaPropinas, logicaNueva } = await getNominaSemana(semana);
    const nombre_key = nombre.toLowerCase().trim();
    const fila = rows.find(r => r.nombre.toLowerCase().trim() === nombre_key) || null;
    res.json({ ok: true, semana, semanaVentas, semanaPropinas, logicaNueva, row: fila, totales: totalizar(rows) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
module.exports.getNominaSemana = getNominaSemana;
module.exports.applyEdit = applyEdit;
module.exports.totalizar = totalizar;
