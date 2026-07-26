const router = require("express").Router();
const { getNominaSemana, applyEdit } = require("./nomina");

// GET /api/propinas/:semana
router.get("/:semana", async (req, res) => {
  try {
    const { semana } = req.params;
    const { rows, ventas, semanaVentas, semanaPropinas, logicaNueva } = await getNominaSemana(semana);

    // Propinas por tarjeta: todo empleado con venta registrada esa semana (meseros,
    // pero también cualquiera que haya facturado), con moche y propina ya calculados.
    const conVenta = new Set((ventas || []).map(v => v.nombre?.toLowerCase()));
    const propTarjeta = rows
      .filter(r => conVenta.has(r.nombre.toLowerCase()))
      .map(r => ({
        nombre: r.nombre,
        moche: r.moche,
        propTarjeta: r.propTarjeta,
        propTarjetaBruto: r.propTarjetaBruto,
        overrides: { moche: r.overrides.moche, propTarjeta: r.overrides.propTarjeta },
      }));

    // Reparto a piso: empleados marcados en_piso en el catálogo.
    const piso = rows.filter(r => r.enPiso).map(r => ({
      nombre: r.nombre, area: r.area,
      hrsProg: r.hrsProg, hrsReal: r.horasReales, ajuste: r.propPiso,
      overrides: { propPiso: r.overrides.propPiso },
    }));
    const totalMoche      = rows.reduce((a, r) => a + (r.moche || 0), 0);
    const totalRepartido  = piso.reduce((a, r) => a + (r.ajuste || 0), 0);

    res.json({
      ok: true, semana, semanaVentas, semanaPropinas, logicaNueva,
      propTarjeta,
      reparto: { totalMoche, totalRepartido, sobrante: totalMoche - totalRepartido, empleados: piso },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PUT /api/propinas/:semana/:nombre — mismo motor y las mismas tablas que /api/nomina
router.put("/:semana/:nombre", async (req, res) => {
  try {
    const { semana, nombre } = req.params;
    await applyEdit(semana, nombre, req.body);
    const { rows, semanaVentas, semanaPropinas, logicaNueva } = await getNominaSemana(semana);
    const nombre_key = nombre.toLowerCase().trim();
    const fila = rows.find(r => r.nombre.toLowerCase().trim() === nombre_key) || null;
    res.json({ ok: true, semana, semanaVentas, semanaPropinas, logicaNueva, row: fila });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
