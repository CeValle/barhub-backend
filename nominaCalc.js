// Motor de cálculo de nómina/propinas — puerto server-side de calcNomina()
// (antes solo existía en barhub.html, calculado al vuelo en el navegador).
// Toma el catálogo desde la tabla `empleados` y los overrides persistidos desde
// `nomina_semanal` en vez de arrays hardcodeados y estado de React efímero.

const PCT_MOCHE = 0.045; // % de venta retenido a cada mesero ("moche")
const PCT_TERM  = 0.08;  // % de comisión de terminal descontado de la propina de tarjeta
const SIN_MOCHE = ["mesero de prueba"];

/**
 * @param {object} params
 * @param {object[]} params.empleados      - filas activas de la tabla `empleados`
 * @param {object[]} params.asistencias    - filas de `asistencias` para la semana DOM-SAB
 * @param {object[]} params.ventas         - filas de `ventas_mesero` de la semana de ventas actual (MIÉ-DOM)
 * @param {object[]} params.ventasProp     - filas de `ventas_mesero` de la semana de propinas (MIÉ-DOM anterior)
 * @param {object}   params.overrides      - map nombre_key → fila de `nomina_semanal` (o {})
 * @returns {object[]} una fila por empleado con el cálculo final + overrides aplicados
 */
function calcNomina({ empleados, asistencias, ventas, ventasProp, overrides }) {
  const emps = empleados || [];
  const ov   = overrides || {};
  const piso = emps.filter(e => e.en_piso);

  // ── Moche por mesero (4.5% de venta, salvo overrides y "meseros de prueba") ──
  const mocheMap = {};
  (ventas || []).forEach(m => {
    const k = m.nombre?.toLowerCase();
    if (!k || SIN_MOCHE.includes(k)) return;
    const ovM = ov[k]?.moche_override;
    mocheMap[k] = ovM != null ? ovM : (m.venta || 0) * PCT_MOCHE;
  });

  // ── Propina de tarjeta (−8% comisión terminal). Prefiere la semana de propinas
  // (la semana de ventas ANTERIOR a la actual — así se reportan en los PDFs),
  // cae a la semana de ventas actual si no hay datos de la semana previa. ──
  // propBrutoMap guarda el monto ANTES del −8% (lo que muestra/edita la UI,
  // igual que el cliente original: el override es sobre el bruto reportado en
  // el PDF); propMap es lo que realmente se paga (neto) y lo que se suma al total.
  const propMap = {};
  const propBrutoMap = {};
  const src = (ventasProp && ventasProp.length) ? ventasProp : ventas;
  (src || []).forEach(m => {
    const k = m.nombre?.toLowerCase();
    if (!k) return;
    const ovProp = ov[k]?.prop_tarjeta_override;
    const base = m.propina ?? m.prop_tarjeta ?? 0;
    const bruto = ovProp != null ? ovProp : base;
    propBrutoMap[k] = bruto;
    propMap[k] = bruto * (1 - PCT_TERM);
  });
  // Un override de propina para alguien que no salió en ninguna fuente de ventas
  // igual se aplica (ej. corrección manual de una semana sin PDF).
  Object.entries(ov).forEach(([k, o]) => {
    if (o.prop_tarjeta_override != null && propMap[k] == null) {
      propBrutoMap[k] = o.prop_tarjeta_override;
      propMap[k] = o.prop_tarjeta_override * (1 - PCT_TERM);
    }
  });

  // ── Reparto de "moche" a piso, proporcional a horas efectivas ──
  const totalMoche = Object.values(mocheMap).reduce((a, v) => a + v, 0);
  const pisoHe = {};
  piso.forEach(p => {
    const k = p.nombre_key;
    const a = (asistencias || []).find(x => x.nombre?.toLowerCase() === k);
    const hb = a ? (a.horas_reales || 0) : 0;
    // ≥90% de horas programadas cuenta como jornada completa
    pisoHe[k] = (p.hrs_prog > 0 && hb >= p.hrs_prog * 0.9) ? p.hrs_prog : hb;
  });
  const totalHrsEf = Object.values(pisoHe).reduce((a, v) => a + v, 0);
  const pisoMap = {};
  piso.forEach(p => {
    const k = p.nombre_key;
    const calc = totalHrsEf > 0 ? (pisoHe[k] / totalHrsEf) * totalMoche : 0;
    const ovPP = ov[k]?.prop_piso_override;
    pisoMap[k] = ovPP != null ? ovPP : calc;
  });

  // ── Fila final por empleado ──
  return emps.map(emp => {
    const k = emp.nombre_key;
    const o = ov[k] || {};
    const pagoOverride = o.pago_override != null ? o.pago_override : null;
    const pf = pagoOverride != null ? pagoOverride : emp.pago_fijo;

    const a  = (asistencias || []).find(x => x.nombre?.toLowerCase() === k);
    // enDoc: ¿el empleado aparece en los datos de esta semana, o hay un pago manual
    // que de todos modos debe cobrarse aunque no haya asistencia registrada?
    const enDoc = emp.admin_fijo || !!a || (pagoOverride != null && pagoOverride > 0);

    const hb = (enDoc && !emp.admin_fijo) ? (a?.horas_reales || 0) : 0;
    const hp = emp.hrs_prog || 0;
    const dias = emp.admin_fijo ? 5 : (a?.dias_asistidos || 0);
    const completo = emp.admin_fijo || (hp > 0 && hb >= hp * 0.9);

    let sueldo = 0;
    if (!enDoc && !emp.admin_fijo) sueldo = 0;
    else if (pf != null) sueldo = (emp.admin_fijo || completo) ? pf : Math.round((pf / 7) * dias);
    else sueldo = (emp.sal_diario || 0) * dias;

    const moche = mocheMap[k] || 0;
    const pt    = propMap[k]  || 0;
    const pp    = pisoMap[k]  || 0;
    const cm    = o.comida    || 0;
    const total = sueldo - moche + pt + pp;

    return {
      nombre: emp.nombre, area: emp.area, dept: emp.dept, enPiso: !!emp.en_piso,
      adminFijo: !!emp.admin_fijo,
      pagoFijo: pf, dias, horasReales: completo ? hp : hb, hrsProg: hp,
      sueldo, moche, propTarjeta: pt, propTarjetaBruto: propBrutoMap[k] || 0, propPiso: pp, comida: cm,
      total, totalNeto: Math.max(0, total - cm),
      enDocumento: enDoc,
      overrides: {
        pagoFijo:    o.pago_override         ?? null,
        moche:       o.moche_override        ?? null,
        propTarjeta: o.prop_tarjeta_override ?? null,
        propPiso:    o.prop_piso_override    ?? null,
        comida:      o.comida ?? null,
        nota:        o.nota ?? null,
      },
    };
  });
}

module.exports = { calcNomina, PCT_MOCHE, PCT_TERM, SIN_MOCHE };
