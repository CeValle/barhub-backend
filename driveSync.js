const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");
const { supabase } = require("./supabase");

const NOMBRE_MAP = { "benny": "omar" };
const mapNombre = (n) => { const k=(n||"").toLowerCase().trim(); return NOMBRE_MAP[k]?capitalize(NOMBRE_MAP[k]):capitalize(k); };
const capitalize = (s) => s.charAt(0).toUpperCase()+s.slice(1);

function getDriveClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials, scopes:["https://www.googleapis.com/auth/drive.readonly"] });
  return google.drive({ version:"v3", auth });
}

async function buscarArchivosNuevos(drive, folderName, diasAtras=30) {
  const desde = new Date(); desde.setDate(desde.getDate()-diasAtras);
  const desdeISO = desde.toISOString();
  const res = await drive.files.list({
    q: `mimeType='application/pdf' and modifiedTime>'${desdeISO}' and trashed=false`,
    fields:"files(id,name,modifiedTime,parents)", pageSize:50,
    includeItemsFromAllDrives:true, supportsAllDrives:true,
  });
  const archivos = res.data.files||[];
  console.log(`[SYNC] PDFs en Drive: ${archivos.length}`);
  archivos.forEach(f=>console.log(`  - ${f.name}`));
  return archivos;
}

async function descargarPDF(drive, fileId) {
  const res = await drive.files.get({ fileId, alt:"media", supportsAllDrives:true },{ responseType:"arraybuffer" });
  return Buffer.from(res.data);
}

async function extraerDatosConClaude(pdfBuffer, tipo) {
  const client = new Anthropic({ apiKey:process.env.ANTHROPIC_API_KEY });
  const b64 = pdfBuffer.toString("base64");
  const prompts = {
    ventas_mesero: 'Analiza este reporte de ventas por mesero de SoftRestaurant. Extrae EXACTAMENTE este JSON (solo JSON): {"semana":"YYYY-MM-DD_a_YYYY-MM-DD","meseros":[{"nombre":"string","venta":0,"propTarjeta":0,"efectivo":0,"comensales":0}],"total_venta":0} Si ves Benny cambialo por Omar.',
    ventas_grupo: 'Analiza reporte ventas por grupo SoftRestaurant. JSON exacto: {"semana":"YYYY-MM-DD_a_YYYY-MM-DD","grupos":[{"grupo":"string","venta":0,"cantidad":0}],"total":0}',
    asistencias: 'Analiza reporte asistencias SoftRestaurant. JSON exacto: {"periodo":"YYYY-MM-DD_a_YYYY-MM-DD","empleados":[{"nombre":"string","horas_trabajadas":0,"dias_asistidos":0}]} Si ves Benny cambialo por Omar.',
  };
  if(!prompts[tipo]) throw new Error("Tipo desconocido: "+tipo);
  const msg = await client.messages.create({ model:"claude-sonnet-4-20250514", max_tokens:2000, messages:[{role:"user",content:[
    {type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},
    {type:"text",text:prompts[tipo]},
  ]}]});
  const texto = msg.content.find(b=>b.type==="text")?.text||"";
  return JSON.parse(texto.replace(/```json|```/g,"").trim());
}

function detectarTipo(nombre) {
  const n=nombre.toLowerCase();
  if(n.includes("mesero")) return "ventas_mesero";
  if(n.includes("grupo"))  return "ventas_grupo";
  if(n.includes("asistencia")) return "asistencias";
  return null;
}

async function guardarVentasMesero(datos,semana){
  for(const m of datos.meseros){
    await supabase.from("ventas_mesero").upsert({semana,nombre:mapNombre(m.nombre),venta:m.venta||0,prop_tarjeta:m.propTarjeta||0,efectivo:m.efectivo||0,comensales:m.comensales||0,updated_at:new Date().toISOString()},{onConflict:"semana,nombre"});
  }
  await supabase.from("resumen_semanal").upsert({semana,total_ventas:datos.total_venta||0,updated_at:new Date().toISOString()},{onConflict:"semana"});
}
async function guardarVentasGrupo(datos,semana){
  for(const g of datos.grupos) await supabase.from("ventas_grupo").upsert({semana,grupo:g.grupo||"Sin grupo",venta:g.venta||0,cantidad:g.cantidad||0,updated_at:new Date().toISOString()},{onConflict:"semana,grupo"});
}
async function guardarAsistencias(datos,semana){
  for(const e of datos.empleados) await supabase.from("asistencias").upsert({semana,nombre:mapNombre(e.nombre),horas_reales:e.horas_trabajadas||0,dias_asistidos:e.dias_asistidos||0,updated_at:new Date().toISOString()},{onConflict:"semana,nombre"});
}

async function syncSemanal() {
  console.log("[SYNC] Iniciando...");
  const drive = getDriveClient();
  const resultados = {procesados:0,errores:[],archivos:[]};
  const hoy=new Date();
  const mie=new Date(hoy); mie.setDate(hoy.getDate()-((hoy.getDay()+4)%7+1));
  const jue=new Date(mie); jue.setDate(mie.getDate()+1);
  const fmt=d=>d.toISOString().split("T")[0];
  const semana=`${fmt(mie)}_a_${fmt(jue)}`;
  console.log("[SYNC] Semana:",semana);
  let archivos=[];
  try { archivos=await buscarArchivosNuevos(drive,"BarHub",30); }
  catch(err){ console.error("[SYNC] Error buscar:",err.message); resultados.errores.push({error:err.message}); return resultados; }
  for(const archivo of archivos){
    const tipo=detectarTipo(archivo.name);
    if(!tipo){console.log("[SYNC] Saltando:",archivo.name);continue;}
    console.log("[SYNC] Procesando:",archivo.name,tipo);
    try{
      const buf=await descargarPDF(drive,archivo.id);
      const datos=await extraerDatosConClaude(buf,tipo);
      if(tipo==="ventas_mesero") await guardarVentasMesero(datos,semana);
      if(tipo==="ventas_grupo")  await guardarVentasGrupo(datos,semana);
      if(tipo==="asistencias")   await guardarAsistencias(datos,semana);
      resultados.procesados++;
      resultados.archivos.push({nombre:archivo.name,tipo,semana,ok:true});
    }catch(err){
      console.error("[SYNC] Error:",archivo.name,err.message);
      resultados.errores.push({archivo:archivo.name,error:err.message});
      resultados.archivos.push({nombre:archivo.name,tipo,ok:false,error:err.message});
    }
  }
  await supabase.from("sync_log").insert({semana,archivos_procesados:resultados.procesados,resultados:JSON.stringify(resultados),created_at:new Date().toISOString()});
  console.log("[SYNC] Done:",resultados.procesados,"procesados");
  return resultados;
}

module.exports = { syncSemanal };
