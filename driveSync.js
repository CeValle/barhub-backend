const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const { supabase } = require("./supabase");

const NOMBRE_MAP = { "benny": "omar" };
const mapNombre = n => { const k=(n||"").toLowerCase().trim(); return NOMBRE_MAP[k]?capitalize(NOMBRE_MAP[k]):capitalize(k); };
const capitalize = s => s.charAt(0).toUpperCase()+s.slice(1);

// ── CONFIGURACIÓN DE EMPLEADOS ────────────────────────────────────────────────
// pagoFijo: monto semanal fijo (no depende de días). null = pago por día x asistencias
const EMPLEADOS_CONFIG = {
  yulisa:  { hrsProg:20, pagoFijo:1500 },
  omar:    { hrsProg:20, pagoFijo:1500 },
  saul:    { hrsProg:20, pagoFijo:1500 },
  alexis:  { hrsProg:46, pagoFijo:null },
  angel:   { hrsProg:46, pagoFijo:null },
  edith:   { hrsProg:46, pagoFijo:null },
  jorge:   { hrsProg:46, pagoFijo:null },
  erick:   { hrsProg:46, pagoFijo:null },
  andrea:  { hrsProg:46, pagoFijo:4000 },  // siempre fijo, sin asistencias
  gerardo: { hrsProg:46, pagoFijo:6000 },  // siempre fijo, sin asistencias
};

function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials, scopes:["https://www.googleapis.com/auth/drive.readonly"] });
  return google.drive({ version:"v3", auth });
}

function detectarTipo(nombre) {
  const n = nombre.toLowerCase();
  if (n.includes("mesero")) return "ventas_mesero";
  if (n.includes("grupo"))  return "ventas_grupo";
  if (n.includes("asistencia")) return "asistencias";
  return null;
}

// Extrae la fecha más alta mencionada en el nombre del archivo
function extraerFechaDesdeNombre(nombre) {
  const n = nombre.toLowerCase();
  const meses = { enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
    julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12 };
  let mes = 0, anio = 0, dia = 0;
  for (const [nm, num] of Object.entries(meses)) {
    if (n.includes(nm)) { mes = num; break; }
  }
  const anioMatch = n.match(/20\d{2}/);
  if (anioMatch) anio = parseInt(anioMatch[0]);
  const diasMatch = n.match(/\d+/g);
  if (diasMatch) {
    const dias = diasMatch.map(Number).filter(d => d >= 1 && d <= 31);
    dia = dias.length > 0 ? Math.max(...dias) : 0;
  }
  if (mes && anio && dia) return new Date(anio, mes-1, dia).getTime();
  return 0;
}

// Retorna SOLO el más reciente por tipo, ordenado por fecha del nombre
async function buscarMasRecientesPorTipo(drive, diasAtras=60) {
  const desde = new Date(); desde.setDate(desde.getDate()-diasAtras);
  const res = await drive.files.list({
    q: `mimeType='application/pdf' and modifiedTime>'${desde.toISOString()}' and trashed=false`,
    fields:"files(id,name,modifiedTime)", pageSize:100,
    includeItemsFromAllDrives:true, supportsAllDrives:true,
  });
  const todos = res.data.files || [];
  console.log(`[SYNC] PDFs en Drive: ${todos.length}`);
  todos.forEach(f => {
    const fn = extraerFechaDesdeNombre(f.name);
    console.log(`  - ${f.name} | fecha: ${fn ? new Date(fn).toLocaleDateString('es-MX') : 'sin fecha'}`);
  });

  const porTipo = {};
  for (const f of todos) {
    const tipo = detectarTipo(f.name);
    if (!tipo) continue;
    const fechaNombre = extraerFechaDesdeNombre(f.name);
    const fechaActual = porTipo[tipo] ? extraerFechaDesdeNombre(porTipo[tipo].name) : 0;
    const esMasReciente = fechaNombre > 0
      ? fechaNombre > fechaActual
      : new Date(f.modifiedTime) > new Date(porTipo[tipo]?.modifiedTime || 0);
    if (!porTipo[tipo] || esMasReciente) porTipo[tipo] = f;
  }

  const sel = Object.values(porTipo);
  console.log(`[SYNC] Seleccionados (1 por tipo): ${sel.length}`);
  sel.forEach(f => console.log(`  * [${detectarTipo(f.name)}] ${f.name}`));
  return sel;
}

async function descargarPDF(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt:"media", supportsAllDrives:true },
    { responseType:"arraybuffer" }
  );
  return Buffer.from(res.data);
}

async function extraerDatosConClaude(pdfBuffer, tipo) {
  const client = new Anthropic({ apiKey:process.env.ANTHROPIC_API_KEY });
  const b64 = pdfBuffer.toString("base64");
  const prompts = {
    ventas_mesero: 'Analiza este reporte de ventas por mesero de SoftRestaurant. Responde SOLO con JSON valido (sin markdown, sin texto): {"semana":"YYYY-MM-DD_a_YYYY-MM-DD","meseros":[{"nombre":"string","venta":0,"prop_tarjeta":0,"efectivo":0,"comensales":0}],"total_venta":0} Si ves Benny cambialo por Omar.',
    ventas_grupo:  'Analiza este reporte de ventas por grupo de SoftRestaurant. Responde SOLO con JSON valido (sin markdown, sin texto): {"semana":"YYYY-MM-DD_a_YYYY-MM-DD","grupos":[{"grupo":"string","venta":0,"cantidad":0}],"total":0}',
    asistencias:   'Analiza este reporte de asistencias de SoftRestaurant. Responde SOLO con JSON valido (sin markdown, sin texto): {"periodo":"YYYY-MM-DD_a_YYYY-MM-DD","empleados":[{"nombre":"string","horas_trabajadas":0,"dias_asistidos":0}]} Si ves Benny cambialo por Omar.',
  };
  const msg = await client.messages.create({
    model:"claude-sonnet-4-20250514", max_tokens:2000,
    messages:[{role:"user",content:[
      {type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},
      {type:"text",text:prompts[tipo]},
    ]}],
  });
  const texto = msg.content.find(b=>b.type==="text")?.text||"";
  const clean = texto.replace(/```json|```/g,"").trim();
  return JSON.parse(clean);
}

// ── FIX OPCIÓN A: DELETE antes de INSERT ──────────────────────────────────────
async function limpiarSemana(semana, tipo) {
  const tabla = tipo === "ventas_mesero" ? "ventas_mesero"
              : tipo === "ventas_grupo"  ? "ventas_grupo"
              : "asistencias";
  const { error } = await supabase.from(tabla).delete().eq("semana", semana);
  if (error) console.error(`[SYNC] Error limpiando ${tabla}:`, error.message);
  else console.log(`[SYNC] Limpiada tabla ${tabla} para semana ${semana}`);
}

async function guardarVentasMesero(datos, semana) {
  await limpiarSemana(semana, "ventas_mesero");
  for (const m of datos.meseros) {
    await supabase.from("ventas_mesero").insert({
      semana, nombre:mapNombre(m.nombre), venta:m.venta||0,
      prop_tarjeta:m.prop_tarjeta??m.propTarjeta??0, efectivo:m.efectivo||0,
      comensales:m.comensales||0, updated_at:new Date().toISOString(),
    });
  }
  await supabase.from("resumen_semanal").upsert({
    semana, total_ventas:datos.total_venta||0, updated_at:new Date().toISOString(),
  },{ onConflict:"semana" });
}

async function guardarVentasGrupo(datos, semana) {
  await limpiarSemana(semana, "ventas_grupo");
  for (const g of datos.grupos) {
    await supabase.from("ventas_grupo").insert({
      semana, grupo:g.grupo||"Sin grupo", venta:g.venta||0,
      cantidad:g.cantidad||0, updated_at:new Date().toISOString(),
    });
  }
}

async function guardarAsistencias(datos, semana) {
  await limpiarSemana(semana, "asistencias");
  for (const e of datos.empleados) {
    const nombre = mapNombre(e.nombre);
    const cfg = EMPLEADOS_CONFIG[nombre.toLowerCase()];
    const hrsProg = cfg?.hrsProg || 0;
    const hrsBruto = e.horas_trabajadas || 0;
    // Regla 90%: si asistió >= 90% de hrs programadas -> contar como completo
    let horasReales = hrsBruto;
    if (hrsProg > 0 && hrsBruto >= hrsProg * 0.90) {
      console.log(`[SYNC] ${nombre}: ${hrsBruto}h >= 90% de ${hrsProg}h -> COMPLETO`);
      horasReales = hrsProg;
    }
    await supabase.from("asistencias").insert({
      semana, nombre, horas_reales:horasReales,
      dias_asistidos:e.dias_asistidos||0, updated_at:new Date().toISOString(),
    });
  }
  // Insertar empleados de pago fijo sin asistencias (siempre se pagan igual)
  for (const [nombre, cfg] of Object.entries(EMPLEADOS_CONFIG)) {
    if (cfg.pagoFijo && ['andrea','gerardo'].includes(nombre)) {
      const nomCap = capitalize(nombre);
      // Solo insertar si no fue incluido en el PDF
      const yaExiste = datos.empleados.some(e => mapNombre(e.nombre).toLowerCase() === nombre);
      if (!yaExiste) {
        await supabase.from("asistencias").insert({
          semana, nombre:nomCap, horas_reales:cfg.hrsProg,
          dias_asistidos:5, updated_at:new Date().toISOString(),
        });
      }
    }
  }
}

async function syncSemanal() {
  console.log("[SYNC] Iniciando...");
  const drive = getDriveClient();
  const resultados = { procesados:0, errores:[], archivos:[] };

  const hoy = new Date();
  const dow = hoy.getDay();
  let diasAtrasAMie = (dow + 4) % 7;
  if (diasAtrasAMie === 0) diasAtrasAMie = 7;
  const mie = new Date(hoy); mie.setDate(hoy.getDate()-diasAtrasAMie);
  const jue = new Date(mie); jue.setDate(mie.getDate()+1);
  const fmt = d => d.toISOString().split("T")[0];
  const semana = `${fmt(mie)}_a_${fmt(jue)}`;
  console.log("[SYNC] Semana:", semana);

  let archivos = [];
  try {
    archivos = await buscarMasRecientesPorTipo(drive, 60);
  } catch(err) {
    console.error("[SYNC] Error buscando:", err.message);
    resultados.errores.push({ error:err.message });
    return resultados;
  }

  for (const archivo of archivos) {
    const tipo = detectarTipo(archivo.name);
    console.log(`[SYNC] Procesando: ${archivo.name} -> ${tipo}`);
    try {
      const buf = await descargarPDF(drive, archivo.id);
      const datos = await extraerDatosConClaude(buf, tipo);
      if (tipo==="ventas_mesero") await guardarVentasMesero(datos, semana);
      if (tipo==="ventas_grupo")  await guardarVentasGrupo(datos, semana);
      if (tipo==="asistencias")   await guardarAsistencias(datos, semana);
      resultados.procesados++;
      resultados.archivos.push({ nombre:archivo.name, tipo, semana, ok:true });
    } catch(err) {
      console.error(`[SYNC] Error en ${archivo.name}:`, err.message);
      resultados.errores.push({ archivo:archivo.name, error:err.message });
      resultados.archivos.push({ nombre:archivo.name, tipo, ok:false, error:err.message });
    }
  }

  await supabase.from("sync_log").insert({
    semana, archivos_procesados:resultados.procesados,
    resultados:JSON.stringify(resultados), created_at:new Date().toISOString(),
  });
  console.log(`[SYNC] Done: ${resultados.procesados} procesados, ${resultados.errores.length} errores`);
  return resultados;
}

module.exports = { syncSemanal, EMPLEADOS_CONFIG };
