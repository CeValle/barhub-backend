const router       = require("express").Router();
const { supabase } = require("./supabase");

const PCT_MOCHE    = 0.045;
const PCT_TERMINAL = 0.08;
const SIN_MOCHE    = ["mesero de prueba"];

// Empleados de piso que RECIBEN reparto (Filosofía B)
// NO incluye Angel, Saul, ni Gerente (ellos pagan el moche)
const PISO = [
  { nombre:"Yulisa", area:"Caja",   hrsProg:20 },
  { nombre:"Omar",   area:"Barra",   hrsProg:20 },
  { nombre:"Erick",  area:"Comodín", hrsProg:20, flexible:true },
  { nombre:"Edith",  area:"Cocina",  hrsProg:46 },
  { nombre:"Jorge",  area:"Cocina", hrsProg:46 },
];
const TOTAL_HRS_PROG = PISO.reduce((a,p) => a + p.hrsProg, 0); // 178h

// GET /api/propinas/:semana
router.get("/:semana", async (req, res) => {
  try {
    const { semana } = req.params;

    const { data: ventas } = await supabase
      .from("ventas_mesero")
      .select("*")
      .eq("semana", semana);

    const { data: asistencias } = await supabase
      .from("asistencias")
      .select("*")
      .eq("semana", semana);

    // Propinas tarjeta por mesero (−8%)
    const propTarjeta = (ventas || []).map(v => ({
      nombre:       v.nombre,
      venta:        v.venta,
      propBruta:    v.prop_tarjeta,
      comision8pct: v.prop_tarjeta * PCT_TERMINAL,
      propNeta:     v.prop_tarjeta * (1 - PCT_TERMINAL),
      moche:        SIN_MOCHE.includes(v.nombre?.toLowerCase()) ? 0 : v.venta * PCT_MOCHE,
    }));

    // Total moche a repartir a piso (excluye meseros de prueba)
    const totalMoche = (ventas || []).reduce((a,v) => {
      if (SIN_MOCHE.includes(v.nombre?.toLowerCase())) return a;
      return a + v.venta * PCT_MOCHE;
    }, 0);

    // Reparto a piso — distribución completa (sin sobrante)
    const repartoBase = PISO.map(p => {
      const asist   = asistencias?.find(a => a.nombre.toLowerCase() === p.nombre.toLowerCase());
      // flexible (comodín): sin registro = no asistió → 0h; regular: sin registro = asistencia completa
      const hrsReal = p.flexible ? (asist?.horas_reales || 0) : (asist?.horas_reales || p.hrsProg);
      return { ...p, hrsReal };
    });
    const totalHrsReales = repartoBase.reduce((a, p) => a + p.hrsReal, 0);
    const reparto = repartoBase.map(p => ({
      nombre:  p.nombre,
      area:    p.area,
      hrsProg: p.hrsProg,
      hrsReal: p.hrsReal,
      ajuste:  totalHrsReales > 0 ? (p.hrsReal / totalHrsReales) * totalMoche : 0,
    }));
    const totalRepartido = reparto.reduce((a, p) => a + p.ajuste, 0);
    const sobrante       = 0;

    res.json({
      ok: true,
      semana,
      propTarjeta,
      reparto: {
        totalMoche,
        totalRepartido,
        sobrante,
        empleados: reparto,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
