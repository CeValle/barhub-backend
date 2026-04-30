const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const { supabase } = require("./supabase");

const NOMBRE_MAP = { "benny": "omar" };
const mapNombre = n => { const k=(n||"").toLowerCase().trim(); return NOMBRE_MAP[k]?capitalize(NOMBRE_MAP[k]):capitalize(k); };
const capitalize = s => s.charAt(0).toUpperCase()+s.slice(1);

// Horas programadas: Yulisa/Omar/Saul = 20h | todos los demas = 46h
const HRS_PROG = {
  yulisa:20, omar:20, saul:20,
  alexis:46, angel:46, edith:46, jorge:46, erick:46, andrea:46, gerardo:46
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

// Retorna SOLO EL MAS RECIENTE por tipo (max 3 archivos procesados por sync)
async function buscarMasRecientesPorTipo(drive, diasAtras=30) {
  const desde = new Date(); desde.setDate(desde.getDate()-diasAtras);
  const res = await drive.files.list({
    q: `mimeType='application/pdf' and modifiedTime>'${desde.toISOString()}' and trashed=false`,
    fields:"files(id,name,modifiedTime,parents)", pageSize:50,
    includeItemsFromAllDrives:true, supportsAllDrives:true,
    orderBy:"modifiedTime desc",
  });
  const todos = res.data.files || [];
  console.log(`[SYNC] PDFs encontrados: ${todos.length}`);
  todos.forEach(f => console.log(`  - ${f.name} (${f.modifiedTime.slice(0,10)})`));

  const porTipo = {};
  for (const f of todos) {
    const tipo = detectarTipo(f.name);
    if (!tipo) { console.log(`[SYNC] Sin tipo: ${f.name}`); continue; }
    if (!porTipo[tipo] || new Date(f.modifiedTime) > new Date(porTipo[tipo].modifiedTime)) {
      porTipo[tipo] = f;
    }
  }
  const seleccionados = Object.values(porTipo);
  console.log(`[SYNC] Seleccionados (1 por tipo): ${seleccionados.length}`);
  seleccionados.forEach(f => console.log(`  * [${detectarTipo(f.name)}] ${f.name}`));
  return seleccionados;
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
    ventas_mesero: 'Analiza este reporte de ventas por mesero de SoftRestaurant. Responde SOLO con JSON valido (sin markdown, sin texto): {"semana":"YYYY-MM-DD_a_YYYY-MM-DD","meseros":[{"nombre":"string","venta":0,"propTarjeta":0,"efectivo":0,"comensales":0}],"total_venta":0} Si ves Benny cambialo por Omar.',
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

async function guardarVentasMesero(datos, semana) {
  for (const m of datos.meseros) {
    await supabase.from("ventas_mesero").upsert({
      semana, nombre:mapNombre(m.nombre), venta:m.venta||0,
      prop_tarjeta:m.propTarjeta||0, efectivo:m.efectivo||0,
      comensales:m.comensales||0, updated_at:new Date().toISOString(),
    },{ onConflict:"semana,nombre" });
  }
  await supabase.from("resumen_semanal").upsert({
    semana, total_ventas:datos.total_venta||0, updated_at:new Date().toISOString(),
  },{ onConflict:"semana" });
}

async function guardarVentasGrupo(datos, semana) {
  for (const g of datos.grupos) {
    await supabase.from("ventas_grupo").upsert({
      semana, grupo:g.grupo||"Sin grupo", venta:g.venta||0,
      cantidad:g.cantidad||0, updated_at:new Date().toISOString(),
    },{ onConflict:"semana,grupo" });
  }
}

async function guardarAsistencias(datos, semana) {
  for (const e of datos.empleados) {
    const nombre = mapNombre(e.nombre);
    const hrsProg = HRS_PROG[nombre.toLowerCase()] || 0;
    const hrsBruto = e.horas_trabajadas || 0;

    // Regla 90%: si asistio >= 90% de las horas programadas -> pagar sueldo completo
    let horasReales = hrsBruto;
    if (hrsProg > 0 && hrsBruto >= hrsProg * 0.90) {
      const pct = ((hrsBruto/hrsProg)*100).toFixed(1);
      console.log(`[SYNC] ${nombre}: ${hrsBruto}h = ${pct}% de ${hrsProg}h -> COMPLETO`);
      horasReales = hrsProg;
    } else if (hrsProg > 0) {
      const pct = ((hrsBruto/hrsProg)*100).toFixed(1);
      console.log(`[SYNC] ${nombre}: ${hrsBruto}h = ${pct}% de ${hrsProg}h -> PARCIAL`);
    }

    await supabase.from("asistencias").upsert({
      semana, nombre, horas_reales:horasReales,
      dias_asistidos:e.dias_asistidos||0, updated_at:new Date().toISOString(),
    },{ onConflict:"semana,nombre" });
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
    archivos = await buscarMasRecientesPorTipo(drive, 30);
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

module.exports = { syncSemanal };
