const router   = require("express").Router();
const { supabase } = require("./supabase");

const PCT_MOCHE    = 0.045;
const PCT_TERMINAL = 0.08;

// Empleados base con sueldos diarios reales (AbrilSem2(26))
const EMPLEADOS = [
  { nombre:"Yulisa",  puesto:"Cajero",  area:"Caja",    salDiario:1000, hrsProg:20 },
  { nombre:"Alexis",  puesto:"Barra",   area:"Barra",   salDiario:700,  hrsProg:46 },
  { nombre:"Omar",    puesto:"Barra",   area:"Barra",   salDiario:750,  hrsProg:20 },
  { nombre:"Angel",   puesto:"Mesero",  area:"Mesero",  salDiario:560,  hrsProg:0  },
  { nombre:"Saul",    puesto:"Mesero",  area:"Mesero",  salDiario:750,  hrsProg:0  },
  { nombre:"Edith",   puesto:"Cocina",  area:"Cocina",  salDiario:680,  hrsProg:46 },
  { nombre:"Jorge",   puesto:"Cocina",  area:"Cocina",  salDiario:680,  hrsProg:46 },
  { nombre:"Erick",   puesto:"Comodín", area:"Comodín", salDiario:500,  hrsProg:0  },
  { nombre:"Andrea",  puesto:"Admin",   area:"Admin",   salDiario:800,  hrsProg:0  },
  { nombre:"Gerardo", puesto:"Admin",   area:"Admin",   salDiario:1200, hrsProg:0  },
];

// GET /api/nomina/:semana — calcula nómina completa para una semana
router.get("/:semana", async (req, res) => {
  try {
    const { semana } = req.params;

    // Datos de asistencias desde Supabase
    const { data: asistencias } = await supabase
      .from("asistencias")
      .select("*")
      .eq("semana", semana);

    // Datos de ventas de meseros
    const { data: ventas } = await supabase
      .from("ventas_mesero")
      .select("*")
      .eq("semana", semana);

    // Calcular nómina por empleado
    const nomina = EMPLEADOS.map(emp => {
      const asist  = asistencias?.find(a => a.nombre.toLowerCase() === emp.nombre.toLowerCase());
      const venta  = ventas?.find(v => v.nombre.toLowerCase() === emp.nombre.toLowerCase());
      const dias   = asist?.dias_asistidos || 0;
      const sueldo = emp.salDiario * dias;
      const moche  = venta ? venta.venta * PCT_MOCHE : 0;
      const propTarjeta = venta ? venta.prop_tarjeta * (1 - PCT_TERMINAL) : 0;

      return {
        nombre:       emp.nombre,
        puesto:       emp.puesto,
        area:         emp.area,
        salDiario:    emp.salDiario,
        dias,
        sueldo,
        moche,
        propTarjeta,
        total:        sueldo - moche + propTarjeta,
      };
    });

    res.json({ ok: true, semana, nomina });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
