const { google }   = require("googleapis");
const Anthropic    = require("@anthropic-ai/sdk");
const { supabase } = require("./supabase");

// ── Constantes ───────────────────────────────────────────────────────────────
const MESES = {
  enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
  julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12
};
const PAD = n => String(n).padStart(2,"0");
const FMT = d => `${d.getFullYear()}-${PAD(d.getMonth()+1)}-${PAD(d.getDate())}`;

// ── Auth Google Drive ────────────────────────────────────────────────────────
function getDriveClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version:"v3", auth });
}

// ── Parser de nombres de archivo ─────────────────────────────────────────────
function parsearNombre(nombre) {
  let n = nombre.replace(/\.pdf$/i,"")
    .replace(/^ventas\/mesero\s*/i,"")
    .replace(/^asistencias\s*/i,"")
    .replace(/^venta por grupo\s*/i,"").trim();

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

  // Encontrar el sábado: si ya es sábado lo usa, si es domingo suma 6, si otro suma los días que faltan al sábado
  const diasAlSab = diaSem === 6 ? 0 : (diaSem === 0 ? 6 : 6 - diaSem);
  const sab = new Date(finPDF); sab.setDate(finPDF.getDate() + diasAlSab);
  const dom = new Date(sab);    dom.setDate(sab.getDate() - 6);
  return `${FMT(dom)}_a_${FMT(sab)}`;
}

// Grupos → sem N MMMM → MIÉ-DOM
function semanaGrupo(nombre) {
  const m = nombre.match(/sem\s*(\d+)\s+(\w+)(?:\s+(\d{4}))?/i);
  if (!m) return null;
  const numSem = +m[1], mes = MESES[m[2].toLowerCase()], año = m[3] ? +m[3] : 2026;
  if (!mes) return null;
  // Primer miércoles del mes (dow=3), luego + (N-1)*7
  const p = new Date(año, mes-1, 1);
  const dow = p.getDay();
  const diasAlMier = dow <= 3 ? 3 - dow : 10 - dow;
  const primerMier = new Date(año, mes-1, 1 + diasAlMier);
  const mier = new Date(primerMier); mier.setDate(primerMier.getDate() + (numSem-1)*7);
  const sun  = new Date(mier); sun.setDate(mier.getDate() + 4);
  return `${FMT(mier)}_a_${FMT(sun)}`;
}

// ── Buscar PDFs en Drive ─────────────────────────────────────────────────────
async function buscarPDFs(drive, patron, diasAtras = 120) {
  const desde = new Date();
  desde.setDate(desde.getDate() - diasAtras);
  const q = `name contains '${patron}' and mimeType='application/pdf' and modifiedTime > '${desde.toISOString()}'`;
  const res = await drive.files.list({
    q, fields:"files(id,name,modifiedTime)", orderBy:"modifiedTime desc", pageSize:50
  });
  return res.data.files || [];
}

// ── Extraer datos de PDF con Claude ──────────────────────────────────────────
async function extraerDatos(drive, fileId, tipo) {
  const ai   = new Anthropic();
  const resp = await drive.files.get({ fileId, alt:"media" }, { responseType:"arraybuffer" });
  const b64  = Buffer.from(resp.data).toString("base64");

  const prompts = {
    ventas_mesero: `Extrae datos de ventas por mesero de este PDF SoftRestaurant.
Columnas del PDF: MESERO, VENTA, TARJETA, PROPINA, EFECTIVO, COMENSALES.
- prop_tarjeta = columna TARJETA (monto pagado con tarjeta)
- propina = columna PROPINA (propina en tarjeta, campo separado de TARJETA)
Devuelve SOLO JSON array sin texto adicional:
[{"nombre":"...","venta":número,"prop_tarjeta":número,"propina":número,"efectivo":número,"comensales":número}]`,
    ventas_grupo: `Extrae las ventas por grupo de este reporte SoftRestaurant.
La estructura tiene grupos principales y subgrupos. Devuelve TODOS según esta jerarquía exacta:
SOLO JSON array sin texto adicional:
[{"grupo":"Alimentos","venta":número,"es_subgrupo":false,"grupo_padre":null},
{"grupo":"Extras","venta":número,"es_subgrupo":true,"grupo_padre":"Alimentos"},
{"grupo":"Chun kun","venta":número,"es_subgrupo":true,"grupo_padre":"Alimentos"},
{"grupo":"Hamburguesas","venta":número,"es_subgrupo":true,"grupo_padre":"Alimentos"},
{"grupo":"Pizzas","venta":número,"es_subgrupo":true,"grupo_padre":"Alimentos"},
{"grupo":"Alitas","venta":número,"es_subgrupo":true,"grupo_padre":"Alimentos"},
{"grupo":"Boneless","venta":número,"es_subgrupo":true,"grupo_padre":"Alimentos"},
{"grupo":"Costillas","venta":número,"es_subgrupo":true,"grupo_padre":"Alimentos"},
{"grupo":"Hotdog","venta":número,"es_subgrupo":true,"grupo_padre":"Alimentos"},
{"grupo":"Nachos","venta":número,"es_subgrupo":true,"grupo_padre":"Alimentos"},
{"grupo":"Papas","venta":número,"es_subgrupo":true,"grupo_padre":"Alimentos"},
{"grupo":"Bebidas","venta":número,"es_subgrupo":false,"grupo_padre":null},
{"grupo":"Bebidas s/alcohol","venta":número,"es_subgrupo":true,"grupo_padre":"Bebidas"},
{"grupo":"Cartones","venta":número,"es_subgrupo":false,"grupo_padre":null},
{"grupo":"Cerveza","venta":número,"es_subgrupo":false,"grupo_padre":null},
{"grupo":"Cerveza Artesanal","venta":número,"es_subgrupo":true,"grupo_padre":"Cerveza"},
{"grupo":"Cerveza Importada","venta":número,"es_subgrupo":true,"grupo_padre":"Cerveza"},
{"grupo":"Cerveza Nacional","venta":número,"es_subgrupo":true,"grupo_padre":"Cerveza"},
{"grupo":"Cubetas","venta":número,"es_subgrupo":true,"grupo_padre":"Cerveza"},
{"grupo":"Bull","venta":número,"es_subgrupo":true,"grupo_padre":"Cerveza"},
{"grupo":"Litros/Mezcladores","venta":número,"es_subgrupo":false,"grupo_padre":null},
{"grupo":"Mixologia","venta":número,"es_subgrupo":false,"grupo_padre":null},
{"grupo":"Fuertes","venta":número,"es_subgrupo":true,"grupo_padre":"Mixologia"},
{"grupo":"Refrescantes","venta":número,"es_subgrupo":true,"grupo_padre":"Mixologia"},
{"grupo":"Especialidades","venta":número,"es_subgrupo":true,"grupo_padre":"Mixologia"},
{"grupo":"Shots","venta":número,"es_subgrupo":true,"grupo_padre":"Mixologia"},
{"grupo":"Seltzers","venta":número,"es_subgrupo":false,"grupo_padre":null}]`,
    asistencias: `Extrae la asistencia de empleados de este reporte.
Devuelve SOLO un JSON array sin texto adicional:
[{"nombre":"...","horas_reales":número,"dias_asistidos":número}]`
  };

  const msg = await ai.messages.create({
    model:"claude-sonnet-4-6", max_tokens:2000,
    messages:[{ role:"user", content:[
      { type:"document", source:{ type:"base64", media_type:"application/pdf", data:b64 } },
      { type:"text", text:prompts[tipo] }
    ]}]
  });

  const texto = msg.content.find(c=>c.type==="text")?.text || "[]";
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
  console.log("[SYNC] Buscando ventas/mesero...");
  for (const pdf of await buscarPDFs(drive, "Ventas/mesero")) {
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
      await supabase.from("ventas_mesero").delete().eq("semana", semana);
      const { error } = await supabase.from("ventas_mesero").insert(
        datos.map(d => ({ semana, nombre:d.nombre, venta:+d.venta||0,
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
  for (const pdf of await buscarPDFs(drive, "Venta por grupo")) {
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
      await supabase.from("ventas_grupo").delete().eq("semana", semana);
      const { error } = await supabase.from("ventas_grupo").insert(
        datos.map(d => ({ semana, grupo:d.grupo||d.nombre||"", venta:+d.venta||0,
          porcentaje:+d.porcentaje||0, es_subgrupo:d.es_subgrupo||false,
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
      await supabase.from("asistencias").delete().eq("semana", semana);
      const { error } = await supabase.from("asistencias").insert(
        datos.map(d => ({ semana, nombre:d.nombre, horas_reales:+d.horas_reales||0,
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
