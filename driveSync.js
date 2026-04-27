const { google }    = require("googleapis");
const Anthropic     = require("@anthropic-ai/sdk");
const { supabase }  = require("./supabase");

// ── MAPEO DE NOMBRES SoftRestaurant → BarHub ──────────────────────────────────
const NOMBRE_MAP = {
  "benny": "omar",
  // Agregar más mapeos aquí si se necesitan
};
const mapNombre = (n) => {
  const key = (n || "").toLowerCase().trim();
  return NOMBRE_MAP[key] ? capitalize(NOMBRE_MAP[key]) : capitalize(key);
};
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ── GOOGLE DRIVE AUTH ─────────────────────────────────────────────────────────
function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

// ── BUSCAR ARCHIVOS EN DRIVE ──────────────────────────────────────────────────
async function buscarArchivosNuevos(drive, folderName, diasAtras = 8) {
  // Fecha límite: hace N días
  const desde = new Date();
  desde.setDate(desde.getDate() - diasAtras);
  const desdeISO = desde.toISOString();

  // Buscar carpeta BarHub/Reportes Soft
  const carpetaRes = await drive.files.list({
    q: `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
  });
  if (!carpetaRes.data.files.length) throw new Error(`Carpeta '${folderName}' no encontrada en Drive`);
  const carpetaId = carpetaRes.data.files[0].id;

  // Buscar PDFs nuevos en toda la carpeta y subcarpetas
  const archivosRes = await drive.files.list({
    q: `'${carpetaId}' in parents and mimeType = 'application/pdf' and modifiedTime > '${desdeISO}' and trashed = false`,
    fields: "files(id, name, modifiedTime, parents)",
    pageSize: 50,
  });
  return archivosRes.data.files;
}

// ── DESCARGAR PDF COMO BUFFER ─────────────────────────────────────────────────
async function descargarPDF(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

// ── EXTRAER DATOS CON CLAUDE ──────────────────────────────────────────────────
async function extraerDatosConClaude(pdfBuffer, tipo) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const b64 = pdfBuffer.toString("base64");

  const prompts = {
    ventas_mesero: `Analiza este reporte de ventas por mesero de SoftRestaurant.
Extrae EXACTAMENTE este JSON (solo JSON, sin texto adicional):
{
  "semana": "YYYY-MM-DD_a_YYYY-MM-DD",
  "meseros": [
    { "nombre": "string", "venta": number, "propTarjeta": number, "efectivo": number, "comensales": number }
  ],
  "total_venta": number
}
IMPORTANTE: Si encuentras el nombre "Benny", cámbialo por "Omar" en el JSON.`,

    ventas_grupo: `Analiza este reporte de ventas por grupo de SoftRestaurant.
Extrae EXACTAMENTE este JSON (solo JSON, sin texto adicional):
{
  "semana": "YYYY-MM-DD_a_YYYY-MM-DD",
  "grupos": [
    { "grupo": "string", "venta": number, "cantidad": number }
  ],
  "total": number
}`,

    asistencias: `Analiza este reporte de asistencias de SoftRestaurant.
Extrae EXACTAMENTE este JSON (solo JSON, sin texto adicional):
{
  "periodo": "YYYY-MM-DD_a_YYYY-MM-DD",
  "empleados": [
    { "nombre": "string", "horas_trabajadas": number, "dias_asistidos": number }
  ]
}
IMPORTANTE: Si encuentras el nombre "Benny", cámbialo por "Omar".`,
  };

  const prompt = prompts[tipo];
  if (!prompt) throw new Error(`Tipo desconocido: ${tipo}`);

  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
        { type: "text", text: prompt },
      ],
    }],
  });

  const texto = msg.content.find(b => b.type === "text")?.text || "";
  const clean = texto.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ── DETECTAR TIPO DE REPORTE POR NOMBRE ──────────────────────────────────────
function detectarTipo(nombre) {
  const n = nombre.toLowerCase();
  if (n.includes("mesero"))     return "ventas_mesero";
  if (n.includes("grupo"))      return "ventas_grupo";
  if (n.includes("asistencia")) return "asistencias";
  return null;
}

// ── GUARDAR EN SUPABASE ───────────────────────────────────────────────────────
async function guardarVentasMesero(datos, semana) {
  for (const m of datos.meseros) {
    const nombre = mapNombre(m.nombre);
    await supabase.from("ventas_mesero").upsert({
      semana,
      nombre,
      venta:        m.venta        || 0,
      prop_tarjeta: m.propTarjeta  || 0,
      efectivo:     m.efectivo     || 0,
      comensales:   m.comensales   || 0,
      updated_at:   new Date().toISOString(),
    }, { onConflict: "semana,nombre" });
  }
  await supabase.from("resumen_semanal").upsert({
    semana,
    total_ventas: datos.total_venta || 0,
    updated_at:   new Date().toISOString(),
  }, { onConflict: "semana" });
}

async function guardarVentasGrupo(datos, semana) {
  for (const g of datos.grupos) {
    await supabase.from("ventas_grupo").upsert({
      semana,
      grupo:      g.grupo    || "Sin grupo",
      venta:      g.venta    || 0,
      cantidad:   g.cantidad || 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: "semana,grupo" });
  }
}

async function guardarAsistencias(datos, semana) {
  for (const e of datos.empleados) {
    const nombre = mapNombre(e.nombre);
    await supabase.from("asistencias").upsert({
      semana,
      nombre,
      horas_reales:   e.horas_trabajadas || 0,
      dias_asistidos: e.dias_asistidos   || 0,
      updated_at:     new Date().toISOString(),
    }, { onConflict: "semana,nombre" });
  }
}

// ── FUNCIÓN PRINCIPAL DE SYNC ─────────────────────────────────────────────────
async function syncSemanal() {
  console.log("[SYNC] Iniciando sincronización Drive → Supabase");
  const drive = getDriveClient();
  const resultados = { procesados: 0, errores: [], archivos: [] };

  // Calcular semana actual (miércoles → jueves)
  const hoy   = new Date();
  const diaSemana = hoy.getDay(); // 5 = viernes
  const mie   = new Date(hoy); mie.setDate(hoy.getDate() - 2); // hace 2 días
  const jue   = new Date(hoy); jue.setDate(hoy.getDate() - 1); // ayer
  const fmt   = (d) => d.toISOString().split("T")[0];
  const semana = `${fmt(mie)}_a_${fmt(jue)}`;
  console.log(`[SYNC] Semana: ${semana}`);

  // Buscar archivos nuevos en Drive
  let archivos = [];
  try {
    archivos = await buscarArchivosNuevos(drive, "BarHub", 8);
    console.log(`[SYNC] Archivos encontrados: ${archivos.length}`);
  } catch (err) {
    console.error("[SYNC] Error buscando archivos:", err.message);
    resultados.errores.push({ paso: "buscar_archivos", error: err.message });
    return resultados;
  }

  // Procesar cada archivo
  for (const archivo of archivos) {
    const tipo = detectarTipo(archivo.name);
    if (!tipo) {
      console.log(`[SYNC] Saltando archivo sin tipo reconocido: ${archivo.name}`);
      continue;
    }
    console.log(`[SYNC] Procesando: ${archivo.name} (${tipo})`);
    try {
      const pdfBuffer = await descargarPDF(drive, archivo.id);
      const datos     = await extraerDatosConClaude(pdfBuffer, tipo);

      if (tipo === "ventas_mesero") await guardarVentasMesero(datos, semana);
      if (tipo === "ventas_grupo")  await guardarVentasGrupo(datos, semana);
      if (tipo === "asistencias")   await guardarAsistencias(datos, semana);

      resultados.procesados++;
      resultados.archivos.push({ nombre: archivo.name, tipo, semana, ok: true });
    } catch (err) {
      console.error(`[SYNC] Error procesando ${archivo.name}:`, err.message);
      resultados.errores.push({ archivo: archivo.name, tipo, error: err.message });
      resultados.archivos.push({ nombre: archivo.name, tipo, ok: false, error: err.message });
    }
  }

  // Log sync en Supabase
  await supabase.from("sync_log").insert({
    semana,
    archivos_procesados: resultados.procesados,
    resultados:          JSON.stringify(resultados),
    created_at:          new Date().toISOString(),
  });

  console.log(`[SYNC] Completado: ${resultados.procesados} archivos procesados, ${resultados.errores.length} errores`);
  return resultados;
}

module.exports = { syncSemanal };
