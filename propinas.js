const router       = require("express").Router();
const { supabase } = require("../services/supabase");

const PCT_MOCHE    = 0.045;
const PCT_TERMINAL = 0.08;

// Empleados de piso que RECIBEN reparto (Filosofía B)
// NO incluye Angel, Saul, ni Gerente (ellos pagan el moche)
const PISO = [
  { nombre:"Yulisa", area:"Caja",   hrsProg:20 },
  { nombre:"Alexis", area:"Barra",  hrsProg:46 },
  { nombre:"Omar",   area:"Barra",  hrsProg:20 },
  { nombre:"Edith",  area:"Cocina", hrsProg:46 },
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
      moche:        v.venta * PCT_MOCHE,
    }));

    // Total moche a repartir a piso
    const totalMoche = (ventas || []).reduce((a,v) => a + v.venta * PCT_MOCHE, 0);

    // Reparto a piso — Filosofía B
    const reparto = PISO.map(p => {
      const asist  = asistencias?.find(a => a.nombre.toLowerCase() === p.nombre.toLowerCase());
      const hrsReal = asist?.horas_reales || p.hrsProg; // default: asistencia completa
      const cuota  = TOTAL_HRS_PROG > 0 ? (p.hrsProg / TOTAL_HRS_PROG) * totalMoche : 0;
      const ajuste = p.hrsProg > 0 ? cuota * (hrsReal / p.hrsProg) : 0;
      return {
        nombre:   p.nombre,
        area:     p.area,
        hrsProg:  p.hrsProg,
        hrsReal,
        cuota,
        ajuste,
        perdido:  cuota - ajuste,
      };
    });
    const totalRepartido = reparto.reduce((a,p) => a + p.ajuste, 0);
    const sobrante       = totalMoche - totalRepartido;

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
