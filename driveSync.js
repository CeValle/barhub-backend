const { google }   = require("googleapis");
const Anthropic    = require("@anthropic-ai/sdk");
const { supabase } = require("./supabase");
const { parsearNombre, semanaVentas, semanaAsistencias, semanaGrupo, splitSemana } = require("./semanaUtils");

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Auth Google Drive ────────────────────────────────────────────────────────
function getDriveClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version:"v3", auth });
}

// ── Buscar PDFs en Drive ─────────────────────────────────────────────────────
async function buscarPDFs(drive, patron, diasAtras = 21) {
  const desde = new Date();
  desde.setDate(desde.getDate() - diasAtras);
  const q = `name contains '${patron}' and mimeType='application/pdf' and modifiedTime > '${desde.toISOString()}'`;
  const res = await drive.files.list({
    q, fields:"files(id,name,modifiedTime)", orderBy:"modifiedTime desc", pageSize:50
  });
  return res.data.files || [];
}

// ── Extraer datos de PDF con Claude ──────────────────────────────────────────
const MAX_TOKENS = { ventas_mesero: 600, ventas_grupo: 2000, asistencias: 400 };

const PROMPTS = {
  ventas_mesero:
    "PDF SoftRestaurant — ventas por mesero. Columnas: MESERO, VENTA, TARJETA (prop_tarjeta), PROPINA (propina en tarjeta), EFECTIVO, COMENSALES.\n" +
    "Responde SOLO JSON array:\n" +
    '[{"nombre":"","venta":0,"prop_tarjeta":0,"propina":0,"efectivo":0,"comensales":0}]',

  ventas_grupo:
    "PDF SoftRestaurant — reporte semanal de ventas por grupo.\n" +
    "LAYOUT: el reporte tiene FILAS (grupos y subgrupos) y COLUMNAS de DÍAS (de izquierda a derecha: Miércoles, Jueves, Viernes, Sábado, Domingo).\n" +
    "INSTRUCCIÓN CRÍTICA: Para el campo 'venta' de cada fila, SUMA todos los valores monetarios de cada columna de día de esa fila. NO uses ningún valor 'Total' pre-impreso en el PDF — calcúlalo tú mismo sumando las columnas.\n" +
    "JERARQUÍA: si una fila aparece indentada bajo otra, es subgrupo. Los grupos principales tienen nivel 0; sus subgrupos están indentados debajo.\n" +
    "Captura el nombre del grupo padre EXACTAMENTE como aparece en el PDF.\n" +
    "Responde SOLO JSON array (sin texto extra):\n" +
    '[{"grupo":"nombre completo","venta":0,"es_subgrupo":false,"grupo_padre":null}]',

  asistencias:
    "PDF SoftRestaurant — asistencia de empleados.\n" +
    "Responde SOLO JSON array:\n" +
    '[{"nombre":"","horas_reales":0,"dias_asistidos":0}]',
};

async function extraerDatos(drive, fileId, tipo) {
  const resp = await drive.files.get({ fileId, alt:"media" }, { responseType:"arraybuffer" });
  const b64  = Buffer.from(resp.data).toString("base64");

  const msg = await ai.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: MAX_TOKENS[tipo] || 800,
    messages:[{ role:"user", content:[
      { type:"document", source:{ type:"base64", media_type:"application/pdf", data:b64 } },
      { type:"text", text: PROMPTS[tipo] }
    ]}]
  });

  const texto = msg.content.find(c => c.type === "text")?.text || "[]";
  try {
    return JSON.parse(texto.replace(/```json?|```/g,"").trim());
  } catch(e) {
    console.error(`[SYNC] Error JSON ${tipo}:`, e.message, "\n", texto.slice(0,200));
    return [];
  }
}

// ── Sync principal ───────────────────────────────────────────────────────────
async function syncSemanal(force = false) {
  const drive     = getDriveClient();
  const resultado = { procesados:0, saltados:0, errores:[], semanas:[] };

  // 1. Ventas por mesero (MIÉ-DOM)
  // Busca por "mesero" solo (no "Ventas/mesero") porque el nombre real del
  // archivo varía según quien lo sube: con o sin diagonal, con guion bajo, etc.
  console.log("[SYNC] Buscando ventas/mesero...");
  for (const pdf of await buscarPDFs(drive, "mesero")) {
    try {
      const semana = semanaVentas(parsearNombre(pdf.name));
      if (!semana) { console.log(`[SYNC] Sin fecha: ${pdf.name}`); continue; }
      if (!force) {
        const { count } = await supabase.from("ventas_mesero").select("*",{count:"exact",head:true}).eq("semana",semana);
        if (count > 0) { console.log(`[SYNC] vm:${semana} ya registrado, saltando`); resultado.saltados++; resultado.semanas.push(`vm:${semana}:skip`); continue; }
      }
      console.log(`[SYNC] ${pdf.name} → ${semana}`);
      const datos = await extraerDatos(drive, pdf.id, "ventas_mesero");
      if (!datos.length) continue;
      const { inicio, fin } = splitSemana(semana);
      await supabase.from("ventas_mesero").delete().eq("semana", semana);
      const { error } = await supabase.from("ventas_mesero").insert(
        datos.map(d => ({ semana, semana_inicio:inicio, semana_fin:fin, nombre:d.nombre, venta:+d.venta||0,
          prop_tarjeta:+d.prop_tarjeta||0, propina:+d.propina||0, efectivo:+d.efectivo||0,
          comensales:+d.comensales||0, updated_at:new Date().toISOString() }))
      );
      if (error) throw error;
      resultado.procesados++; resultado.semanas.push(`vm:${semana}`);
      console.log(`[SYNC] ventas_mesero[${semana}]: ${datos.length} meseros`);
    } catch(e) { console.error(`[SYNC] Error ${pdf.name}:`, e.message); resultado.errores.push(pdf.name); }
  }

  // 2. Venta por grupo (sem N MMMM → MIÉ-DOM)
  console.log("[SYNC] Buscando ventas/grupo...");
  for (const pdf of await buscarPDFs(drive, "por grupo")) {
    if (pdf.name.toLowerCase().includes("detallado")) { console.log(`[SYNC] Saltando detallado: ${pdf.name}`); continue; }
    try {
      const semana = semanaGrupo(pdf.name);
      if (!semana) { console.log(`[SYNC] Sin semana: ${pdf.name}`); continue; }
      if (!force) {
        const { count } = await supabase.from("ventas_grupo").select("*",{count:"exact",head:true}).eq("semana",semana);
        if (count > 0) { console.log(`[SYNC] vg:${semana} ya registrado, saltando`); resultado.saltados++; resultado.semanas.push(`vg:${semana}:skip`); continue; }
      }
      console.log(`[SYNC] ${pdf.name} → ${semana}`);
      const datos = await extraerDatos(drive, pdf.id, "ventas_grupo");
      if (!datos.length) continue;
      const { inicio, fin } = splitSemana(semana);
      await supabase.from("ventas_grupo").delete().eq("semana", semana);
      const { error } = await supabase.from("ventas_grupo").insert(
        datos.map(d => ({ semana, semana_inicio:inicio, semana_fin:fin, grupo:d.grupo||d.nombre||"", venta:+d.venta||0,
          es_subgrupo:d.es_subgrupo||false,
          grupo_padre:d.grupo_padre||null, updated_at:new Date().toISOString() }))
      );
      if (error) throw error;
      resultado.procesados++; resultado.semanas.push(`vg:${semana}`);
      console.log(`[SYNC] ventas_grupo[${semana}]: ${datos.length} grupos`);
    } catch(e) { console.error(`[SYNC] Error ${pdf.name}:`, e.message); resultado.errores.push(pdf.name); }
  }

  // 3. Asistencias (DOM-SAB)
  console.log("[SYNC] Buscando asistencias...");
  for (const pdf of await buscarPDFs(drive, "Asistencias")) {
    try {
      const semana = semanaAsistencias(parsearNombre(pdf.name));
      if (!semana) { console.log(`[SYNC] Sin semana: ${pdf.name}`); continue; }
      if (!force) {
        const { count } = await supabase.from("asistencias").select("*",{count:"exact",head:true}).eq("semana",semana);
        if (count > 0) { console.log(`[SYNC] asist:${semana} ya registrado, saltando`); resultado.saltados++; resultado.semanas.push(`asist:${semana}:skip`); continue; }
      }
      console.log(`[SYNC] ${pdf.name} → ${semana}`);
      const datos = await extraerDatos(drive, pdf.id, "asistencias");
      if (!datos.length) continue;
      const { inicio, fin } = splitSemana(semana);
      await supabase.from("asistencias").delete().eq("semana", semana);
      const { error } = await supabase.from("asistencias").insert(
        datos.map(d => ({ semana, semana_inicio:inicio, semana_fin:fin, nombre:d.nombre, horas_reales:+d.horas_reales||0,
          dias_asistidos:+d.dias_asistidos||0, updated_at:new Date().toISOString() }))
      );
      if (error) throw error;
      resultado.procesados++; resultado.semanas.push(`asist:${semana}`);
      console.log(`[SYNC] asistencias[${semana}]: ${datos.length} empleados`);
    } catch(e) { console.error(`[SYNC] Error ${pdf.name}:`, e.message); resultado.errores.push(pdf.name); }
  }

  // Limpiar claves incorrectas antiguas (rangos de 1-2 días)
  for (const t of ["asistencias","ventas_grupo"]) {
    await supabase.from(t).delete().like("semana","_a_2026-04-30");
    await supabase.from(t).delete().like("semana","_a_2026-05-07");
  }

  await supabase.from("sync_log").insert({
    semana: new Date().toISOString().split("T")[0],
    archivos_procesados: resultado.procesados,
    resultados: JSON.stringify(resultado)
  });

  console.log(`[SYNC] Done: ${resultado.procesados} procesados, ${resultado.errores.length} errores`);
  return resultado;
}

module.exports = { syncSemanal };
