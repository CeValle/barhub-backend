const router = require("express").Router();
const { supabase } = require("./supabase");

// GET /api/empleados — catálogo completo (activos por defecto)
router.get("/", async (req, res) => {
  try {
    const incluirInactivos = req.query.incluirInactivos === "1";
    let q = supabase.from("empleados").select("*").order("orden");
    if (!incluirInactivos) q = q.eq("activo", true);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ ok: true, empleados: data || [] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/empleados — alta de un nuevo empleado
router.post("/", async (req, res) => {
  try {
    const { nombre, area, dept, salDiario, hrsProg, pagoFijo, adminFijo, enPiso, pisoFlexible, orden } = req.body;
    if (!nombre) return res.status(400).json({ ok: false, error: "Falta nombre" });
    const { data, error } = await supabase.from("empleados").insert({
      nombre,
      area: area || null,
      dept: dept || null,
      sal_diario: salDiario || 0,
      hrs_prog: hrsProg || 0,
      pago_fijo: pagoFijo != null ? pagoFijo : null,
      admin_fijo: !!adminFijo,
      en_piso: !!enPiso,
      piso_flexible: !!pisoFlexible,
      orden: orden || 0,
      updated_at: new Date().toISOString(),
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, empleado: data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PUT /api/empleados/:id — edición de cualquier campo del catálogo
router.put("/:id", async (req, res) => {
  try {
    const { nombre, area, dept, salDiario, hrsProg, pagoFijo, adminFijo, enPiso, pisoFlexible, activo, orden } = req.body;
    const patch = { updated_at: new Date().toISOString() };
    if (nombre       !== undefined) patch.nombre        = nombre;
    if (area         !== undefined) patch.area          = area;
    if (dept         !== undefined) patch.dept          = dept;
    if (salDiario    !== undefined) patch.sal_diario    = salDiario || 0;
    if (hrsProg      !== undefined) patch.hrs_prog      = hrsProg || 0;
    if (pagoFijo     !== undefined) patch.pago_fijo     = pagoFijo;
    if (adminFijo    !== undefined) patch.admin_fijo    = !!adminFijo;
    if (enPiso       !== undefined) patch.en_piso       = !!enPiso;
    if (pisoFlexible !== undefined) patch.piso_flexible = !!pisoFlexible;
    if (activo       !== undefined) patch.activo        = !!activo;
    if (orden        !== undefined) patch.orden         = orden;

    const { data, error } = await supabase.from("empleados").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, empleado: data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/empleados/:id — baja lógica (nunca se borra físicamente:
// preserva el historial de semanas pasadas en asistencias/ventas/nomina_semanal)
router.delete("/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("empleados")
      .update({ activo: false, updated_at: new Date().toISOString() })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ ok: true, empleado: data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
