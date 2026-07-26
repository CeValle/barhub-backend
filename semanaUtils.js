// Utilidades compartidas de parseo de nombres de PDF y cálculo de claves "semana".
// Extraído de driveSync.js / driveDetalle.js (antes duplicado en ambos archivos)
// para que el modelo de semanas tenga un solo lugar que cambiar.

const MESES = {
  enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
  julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12
};
const PAD = n => String(n).padStart(2,"0");
const FMT = d => `${d.getFullYear()}-${PAD(d.getMonth()+1)}-${PAD(d.getDate())}`;

// Extrae {d1,m1,d2,m2,año} de un nombre de archivo ya despojado de su prefijo
// (ej. "29 de abril - 3 de mayo 2026"). Común a ventas/mesero, asistencias y ventas/grupo.
function extraerFechas(nombreLimpio) {
  const n = (nombreLimpio || "").trim();

  // "06-10 de mayo 2026" o "8-12 abril 2026"
  let m = n.match(/^(\d{1,2})-(\d{1,2})\s+(?:de\s+)?(\w+)\s+(\d{4})/i);
  if (m) {
    const mes = MESES[m[3].toLowerCase()];
    if (mes) return { d1:+m[1], m1:mes, d2:+m[2], m2:mes, año:+m[4] };
  }

  // "29 de abril - 3 de mayo 2026"
  m = n.match(/^(\d{1,2})\s+de\s+(\w+)\s*[-–]\s*(\d{1,2})\s+de\s+(\w+)\s+(\d{4})/i);
  if (m) {
    const m1 = MESES[m[2].toLowerCase()], m2 = MESES[m[4].toLowerCase()];
    if (m1 && m2) return { d1:+m[1], m1, d2:+m[3], m2, año:+m[5] };
  }

  // "26 abril-2 mayo 2026" (sin "de")
  m = n.match(/^(\d{1,2})\s+(\w+)\s*[-–]\s*(\d{1,2})\s+(\w+)\s+(\d{4})/i);
  if (m) {
    const m1 = MESES[m[2].toLowerCase()], m2 = MESES[m[4].toLowerCase()];
    if (m1 && m2) return { d1:+m[1], m1, d2:+m[3], m2, año:+m[5] };
  }

  return null;
}

// Nombres de "Ventas/mesero ..." y "Asistencias ..."
function parsearNombre(nombre) {
  const n = nombre.replace(/\.pdf$/i,"")
    .replace(/^ventas\/mesero\s*/i,"")
    .replace(/^asistencias\s*/i,"")
    .replace(/^ventas?\s+por\s+grupo\s*/i,"").trim();
  return extraerFechas(n);
}

// Nombres de "Ventas por grupo detallado ..."
function parsearNombreDetallado(nombre) {
  const n = nombre.replace(/\.pdf$/i,"")
    .replace(/^ventas?\s+por\s+grupo\s+detallado?\s*/i,"")
    .replace(/^venta\s+por\s+grupo\s+detallado?\s*/i,"")
    .trim();
  return extraerFechas(n);
}

// Ventas/Grupos → clave MIÉ-DOM exacta del PDF
function semanaVentas(p) {
  if (!p) return null;
  return `${p.año}-${PAD(p.m1)}-${PAD(p.d1)}_a_${p.año}-${PAD(p.m2)}-${PAD(p.d2)}`;
}

// Asistencias → clave DOM-SAB
// Ancla: el SÁBADO más cercano al último día del PDF define el fin de semana
// Luego domingo = ese sábado - 6 días
function semanaAsistencias(p) {
  if (!p) return null;
  const finPDF = new Date(p.año, p.m2-1, p.d2);
  const diaSem = finPDF.getDay(); // 0=dom, 6=sab

  const diasAlSab = diaSem === 6 ? 0 : (diaSem === 0 ? 6 : 6 - diaSem);
  const sab = new Date(finPDF); sab.setDate(finPDF.getDate() + diasAlSab);
  const dom = new Date(sab);    dom.setDate(sab.getDate() - 6);
  return `${FMT(dom)}_a_${FMT(sab)}`;
}

// Grupos → sem N MMMM → MIÉ-DOM
function semanaGrupo(nombre) {
  // Patrón 1: "sem N [de] mes [año]"  (ej. "sem 3 de mayo 2026", "sem3 mayo 2026")
  let m = nombre.match(/sem\s*(\d+)\s+(?:de\s+)?(\w+)(?:\s+(\d{4}))?/i);
  if (m) {
    const numSem = +m[1], mes = MESES[m[2].toLowerCase()], año = m[3] ? +m[3] : new Date().getFullYear();
    if (mes) {
      const p = new Date(año, mes-1, 1);
      const dow = p.getDay();
      const diasAlMier = dow <= 3 ? 3 - dow : 10 - dow;
      const primerMier = new Date(año, mes-1, 1 + diasAlMier);
      const mier = new Date(primerMier); mier.setDate(primerMier.getDate() + (numSem-1)*7);
      const sun  = new Date(mier); sun.setDate(mier.getDate() + 4);
      return `${FMT(mier)}_a_${FMT(sun)}`;
    }
  }
  // Patrón 2: rango de fechas igual que ventas_mesero (ej. "27-31 de mayo 2026")
  const p2 = parsearNombre(nombre);
  if (p2) return semanaVentas(p2);
  return null;
}

// Divide una clave "YYYY-MM-DD_a_YYYY-MM-DD" en sus dos fechas ISO, para poblar
// columnas DATE (semana_inicio/semana_fin) sin volver a parsear el nombre del PDF.
function splitSemana(key) {
  if (!key) return { inicio: null, fin: null };
  const [inicio, fin] = key.split("_a_");
  return { inicio: inicio || null, fin: fin || null };
}

// ── Modelo de semana "de negocio" (selector DOM-SAB ↔ ventas/propinas MIÉ-DOM) ──
// Único lugar donde vive este desfase — antes duplicado entre dashboard.js y
// (potencialmente) nomina.js/propinas.js.

// Semana DOM-SAB que contiene hoy.
function calcularSemanaActual() {
  const hoy = new Date(), dow = hoy.getDay(), d = dow === 0 ? 0 : dow;
  const dom = new Date(hoy); dom.setDate(hoy.getDate() - d);
  const sab = new Date(dom); sab.setDate(dom.getDate() + 6);
  return `${FMT(dom)}_a_${FMT(sab)}`;
}

// Selector DOM-SAB → semana de ventas MIÉ-DOM (dom+3 a dom+7)
function ventasDeSelector(selectorKey) {
  const dom  = new Date(selectorKey.split("_a_")[0] + "T12:00:00");
  const mier = new Date(dom); mier.setDate(dom.getDate() + 3);
  const sun  = new Date(dom); sun.setDate(dom.getDate() + 7);
  return `${FMT(mier)}_a_${FMT(sun)}`;
}

// Propinas = semana MIÉ-DOM exactamente anterior a la semana de ventas
function propinasDeVentas(semanaVentasKey) {
  const ini  = new Date(semanaVentasKey.split("_a_")[0] + "T12:00:00");
  const pIni = new Date(ini); pIni.setDate(ini.getDate() - 7);
  const pFin = new Date(pIni); pFin.setDate(pIni.getDate() + 4);
  return `${FMT(pIni)}_a_${FMT(pFin)}`;
}

// Fallback: semana disponible más reciente cuyo fin <= fin del target (solo asistencias)
function semanaProxima(target, disponibles) {
  if (!disponibles?.length) return null;
  const finT = new Date(target.split("_a_")[1] + "T23:59:59");
  const cands = disponibles.filter(s => new Date(s.split("_a_")[1] + "T23:59:59") <= finT);
  return cands.length ? cands[cands.length - 1] : disponibles[disponibles.length - 1];
}

module.exports = {
  MESES, PAD, FMT,
  extraerFechas,
  parsearNombre,
  parsearNombreDetallado,
  semanaVentas,
  semanaAsistencias,
  semanaGrupo,
  splitSemana,
  calcularSemanaActual,
  ventasDeSelector,
  propinasDeVentas,
  semanaProxima,
  toSemanaKey: semanaVentas, // alias usado antes en driveDetalle.js
};
