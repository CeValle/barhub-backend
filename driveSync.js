const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const { supabase } = require("./supabase");

const NOMBRE_MAP = { "benny": "omar" };
const mapNombre = n => { const k=(n||"").toLowerCase().trim(); return NOMBRE_MAP[k]?capitalize(NOMBRE_MAP[k]):capitalize(k); };
const capitalize = s => s.charAt(0).toUpperCase()+s.slice(1);

const EMPLEADOS_CONFIG = {
  yulisa:  { hrsProg:20, pagoFijo:1500 },
  omar:    { hrsProg:20, pagoFijo:1500 },
  saul:    { hrsProg:20, pagoFijo:1500 },
  alexis:  { hrsProg:46, pagoFijo:null },
  angel:   { hrsProg:46, pagoFijo:null },
  edith:   { hrsProg:46, pagoFijo:null },
  jorge:   { hrsProg:46, pagoFijo:null },
  erick:   { hrsProg:46, pagoFijo:null },
  andrea:  { hrsProg:46, pagoFijo:4000, adminFijo:true },
  gerardo: { hrsProg:46, pagoFijo:6000, adminFijo:true },
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

function extraerFechaDesdeNombre(nombre) {
  const n = nombre.toLowerCase();
  const meses = { enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
    julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12 };
  let mes=0, anio=0, dia=0;
  for (const [nm, num] of Object.entries(meses)) {
    if (n.includes(nm)) { mes=num; break; }
  }
  const am = n.match(/20\d{2}/); if (am) anio=parseInt(am[0]);
  const dm = n.match(/\d+/g);
  if (dm) { const dias=dm.map(Number).filter(d=>d>=1&&d<=31); dia=dias.length?Math.max(...dias):0; }
  if (mes&&anio&&dia) return new Date(anio,mes-1,dia).getTime();
  return 0;
}

// Para ventas_mesero devuelve los 2 mas recientes por fecha del nombre
// Para otros tipos devuelve solo el mas reciente
async function buscarArchivosRelevantes(drive, diasAtras=60) {
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
    console.log(`  - ${f.name} | fecha: ${fn?new Date(fn).toLocaleDateString('es-MX'):'sin fecha'}`);
  });

  const porTipo = {};
  for (const f of todos) {
    const tipo = detectarTipo(f.name);
    if (!tipo) continue;
    if (!porTipo[tipo]) porTipo[tipo] = [];
    porTipo[tipo].push(f);
  }

  // Ordenar por fecha del nombre desc
  for (const tipo of Object.keys(porTipo)) {
    porTipo[tipo].sort((a,b) => {
      const fa=extraerFechaDesdeNombre(a.name), fb=extraerFechaDesdeNombre(b.name);
      if (fa&&fb) return fb-fa;
      return new Date(b.modifiedTime)-new Date(a.modifiedTime);
    });
  }

  const seleccionados = [];
  // ventas_mesero: top 2 (actual + anterior para propinas)
  if (porTipo.ventas_mesero) {
    porTipo.ventas_mesero.slice(0,2).forEach((f,i) => {
      seleccionados.push({...f, subtipo: i===0?'ventas_mesero_actual':'ventas_mesero_anterior'});
      console.log(`[SYNC] ventas_mesero [${i===0?'actual':'anterior'}]: ${f.name}`);
    });
  }
  for (const tipo of ['ventas_grupo','asistencias']) {
    if (porTipo[tipo]?.[0]) {
      seleccionados.push({...porTipo[tipo][0], subtipo:tipo});
      console.log(`[SYNC] [${tipo}]: ${porTipo[tipo][0].name}`);
    }
  }
  return seleccionados;
}

async function descargarPDF(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt:"media", supportsAllDrives:true },
    { responseType:"arraybuffer" }
  );
  return Buffer.from(res.data);
}

async function extraerDatosConClaude(pdfBuffer, subtipo) {
  const client = new Anthropic({ apiKey:process.env.ANTHROPIC_API_KEY });
  const b64 = pdfBuffer.toString("base64");
  const prompts = {
    ventas_mesero: `Analiza este reporte de ventas por mesero de SoftRestaurant.
La columna de propinas en tarjeta se llama "PROPINA" en el documento.
Responde SOLO con JSON valido (sin markdown, sin texto adicional):
{"semana":"YYYY-MM-DD_a_YYYY-MM-DD","meseros":[{"nombre":"string","venta":0,"propina":0,"efectivo":0,"comensales":0}],"total_venta":0}
Donde "propina" es el valor exacto de la columna PROPINA del PDF.
Si ves el nombre Benny cambialo por Omar.`,
    ventas_grupo: `Analiza este reporte de ventas por grupo de SoftRestaurant.
Responde SOLO con JSON valido (sin markdown, sin texto adicional):
{"semana":"YYYY-MM-DD_a_YYYY-MM-DD","grupos":[{"grupo":"string","venta":0,"cantidad":0}],"total":0}`,
    asistencias: `Analiza este reporte de asistencias de SoftRestaurant.
Responde SOLO con JSON valido (sin markdown, sin texto adicional):
{"periodo":"YYYY-MM-DD_a_YYYY-MM-DD","empleados":[{"nombre":"string","horas_trabajadas":0,"dias_asistidos":0}]}
Si ves el nombre Benny cambialo por Omar.`,
  };
  const tipoBase = subtipo.replace('_actual','').replace('_anterior','');
  const msg = await client.messages.create({
    model:"claude-sonnet-4-20250514", max_tokens:2000,
    messages:[{role:"user",content:[
      {type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},
      {type:"text",text:prompts[tipoBase]},
    ]}],
  });
  const texto = msg.content.find(b=>b.type==="text")?.text||"";
  const clean = texto.replace(/```json|```/g,"").trim();
  return JSON.parse(clean);
}

async function limpiarSemana(tabla, semana) {
  const {error} = await supabase.from(tabla).delete().eq("semana", semana);
  if (error) console.error(`[SYNC] Error limpiando ${tabla}:`, error.message);
  else console.log(`[SYNC] Limpiada ${tabla} semana ${semana}`);
}

async function guardarVentasMesero(datos) {
  const semana = datos.semana;
  await limpiarSemana("ventas_mesero", semana);
  for (const m of datos.meseros) {
    const propina = m.propina ?? m.prop_tarjeta ?? 0;
    await supabase.from("ventas_mesero").insert({
      semana, nombre:mapNombre(m.nombre),
      venta:m.venta||0, prop_tarjeta:propina,
      efectivo:m.efectivo||0, comensales:m.comensales||0,
      updated_at:new Date().toISOString(),
    });
  }
  await supabase.from("resumen_semanal").upsert({
    semana, total_ventas:datos.total_venta||0, updated_at:new Date().toISOString(),
  },{ onConflict:"semana" });
  console.log(`[SYNC] ventas_mesero guardado en semana ${semana}`);
}

async function guardarVentasGrupo(datos, semana) {
  await limpiarSemana("ventas_grupo", semana);
  for (const g of datos.grupos) {
    await supabase.from("ventas_grupo").insert({
      semana, grupo:g.grupo||"Sin grupo", venta:g.venta||0,
      cantidad:g.cantidad||0, updated_at:new Date().toISOString(),
    });
  }
}

async function guardarAsistencias(datos, semana) {
  await limpiarSemana("asistencias", semana);
  for (const e of datos.empleados) {
    const nombre = mapNombre(e.nombre);
    const cfg = EMPLEADOS_CONFIG[nombre.toLowerCase()];
    const hrsProg = cfg?.hrsProg || 0;
    const hrsBruto = e.horas_trabajadas || 0;
    let horasReales = hrsBruto;
    if (hrsProg > 0 && hrsBruto >= hrsProg * 0.90) {
      console.log(`[SYNC] ${nombre}: ${hrsBruto}h >= 90% de ${hrsProg}h → COMPLETO`);
      horasReales = hrsProg;
    }
    await supabase.from("asistencias").insert({
      semana, nombre, horas_reales:horasReales,
      dias_asistidos:e.dias_asistidos||0, updated_at:new Date().toISOString(),
    });
  }
  // Insertar adminFijo aunque no aparezcan en el PDF
  for (const [nombre, cfg] of Object.entries(EMPLEADOS_CONFIG)) {
    if (cfg.adminFijo) {
      const nomCap = capitalize(nombre);
      const yaExiste = datos.empleados.some(e=>mapNombre(e.nombre).toLowerCase()===nombre);
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
  let diasAtrasAMie=(dow+4)%7; if(diasAtrasAMie===0) diasAtrasAMie=7;
  const mie=new Date(hoy); mie.setDate(hoy.getDate()-diasAtrasAMie);
  const jue=new Date(mie); jue.setDate(mie.getDate()+1);
  const fmt=d=>d.toISOString().split("T")[0];
  const semanaActual=`${fmt(mie)}_a_${fmt(jue)}`;
  console.log("[SYNC] Semana calculada:", semanaActual);

  let archivos=[];
  try { archivos=await buscarArchivosRelevantes(drive, 60); }
  catch(err) { resultados.errores.push({error:err.message}); return resultados; }

  for (const archivo of archivos) {
    const {subtipo}=archivo;
    const tipoBase=subtipo.replace('_actual','').replace('_anterior','');
    console.log(`[SYNC] Procesando: ${archivo.name} [${subtipo}]`);
    try {
      const buf=await descargarPDF(drive, archivo.id);
      const datos=await extraerDatosConClaude(buf, subtipo);
      if (tipoBase==="ventas_mesero") await guardarVentasMesero(datos);
      if (tipoBase==="ventas_grupo")  await guardarVentasGrupo(datos, semanaActual);
      if (tipoBase==="asistencias")   await guardarAsistencias(datos, semanaActual);
      resultados.procesados++;
      resultados.archivos.push({nombre:archivo.name, subtipo, semana:datos.semana||semanaActual, ok:true});
    } catch(err) {
      console.error(`[SYNC] Error en ${archivo.name}:`, err.message);
      resultados.errores.push({archivo:archivo.name, error:err.message});
      resultados.archivos.push({nombre:archivo.name, subtipo, ok:false, error:err.message});
    }
  }

  await supabase.from("sync_log").insert({
    semana:semanaActual, archivos_procesados:resultados.procesados,
    resultados:JSON.stringify(resultados), created_at:new Date().toISOString(),
  });
  console.log(`[SYNC] Done: ${resultados.procesados} procesados`);
  return resultados;
}

module.exports = { syncSemanal, EMPLEADOS_CONFIG };
