const express    = require("express");
const router     = express.Router();
const { google } = require("googleapis");
const Anthropic  = require("@anthropic-ai/sdk");

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MESES = {
  enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
  julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12
};
const PAD = n => String(n).padStart(2,"0");

function parsearNombreDetallado(nombre) {
  const n = nombre
    .replace(/\.pdf$/i,"")
    .replace(/^ventas?\s+por\s+grupo\s+detallado?\s*/i,"")
    .replace(/^venta\s+por\s+grupo\s+detallado?\s*/i,"")
    .trim();

  let m = n.match(/^(\d{1,2})-(\d{1,2})\s+(?:de\s+)?(\w+)\s+(\d{4})/i);
  if (m) {
    const mes = MESES[m[3].toLowerCase()];
    if (mes) return { d1:+m[1], m1:mes, d2:+m[2], m2:mes, año:+m[4] };
  }
  m = n.match(/^(\d{1,2})\s+de\s+(\w+)\s*[-–]\s*(\d{1,2})\s+de\s+(\w+)\s+(\d{4})/i);
  if (m) {
    const m1 = MESES[m[2].toLowerCase()], m2 = MESES[m[4].toLowerCase()];
    if (m1 && m2) return { d1:+m[1], m1, d2:+m[3], m2, año:+m[5] };
  }
  m = n.match(/^(\d{1,2})\s+(\w+)\s*[-–]\s*(\d{1,2})\s+(\w+)\s+(\d{4})/i);
  if (m) {
    const m1 = MESES[m[2].toLowerCase()], m2 = MESES[m[4].toLowerCase()];
    if (m1 && m2) return { d1:+m[1], m1, d2:+m[3], m2, año:+m[5] };
  }
  return null;
}

function toSemanaKey(p) {
  if (!p) return null;
  return `${p.año}-${PAD(p.m1)}-${PAD(p.d1)}_a_${p.año}-${PAD(p.m2)}-${PAD(p.d2)}`;
}

function getDriveClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth  = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version:"v3", auth });
}

// Cache en memoria por semana (se limpia al reiniciar el proceso)
const detalleCache = {};

async function leerPDFDetallado(drive, fileId) {
  const resp = await drive.files.get({ fileId, alt:"media" }, { responseType:"arraybuffer" });
  const b64  = Buffer.from(resp.data).toString("base64");

  const msg = await ai.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4000,
    messages:[{ role:"user", content:[
      { type:"document", source:{ type:"base64", media_type:"application/pdf", data:b64 } },
      { type:"text", text:
        "PDF SoftRestaurant — reporte DETALLADO de ventas por grupo (nivel producto).\n" +
        "LAYOUT: cada fila es un PRODUCTO individual bajo un grupo o subgrupo. Los DÍAS van en columnas de izquierda a derecha (Miércoles → Jueves → Viernes → Sábado → Domingo).\n" +
        "INSTRUCCIÓN CRÍTICA: Para la 'venta' de cada producto, SUMA los valores de todas las columnas de día de esa fila. NO uses totales pre-impresos.\n" +
        "El campo 'grupo' debe ser el nombre del grupo/subgrupo al que pertenece el producto (tal como aparece en el PDF).\n" +
        "Responde SOLO JSON array:\n" +
        '[{"producto":"nombre del producto","grupo":"nombre del grupo padre","venta":0}]'
      }
    ]}]
  });

  const texto = msg.content.find(c => c.type === "text")?.text || "[]";
  try {
    return JSON.parse(texto.replace(/```json?|```/g,"").trim());
  } catch(e) {
    console.error("[DETALLE] Error JSON:", e.message, texto.slice(0,200));
    return [];
  }
}

// Normaliza nombre de grupo para matching flexible
const normalize = s => (s||"").replace(/^\d+\s*[-–]\s*/,"").trim().toLowerCase();

// GET /api/ventas-grupo/detalle?semana=2026-05-27_a_2026-05-31&grupo=09 - CERVEZA NACIONAL
router.get("/detalle", async (req, res) => {
  const { semana, grupo } = req.query;
  if (!semana) return res.status(400).json({ ok:false, error:"Parámetro 'semana' requerido" });

  try {
    if (!detalleCache[semana]) {
      console.log(`[DETALLE] Buscando PDF detallado para semana ${semana}...`);
      const drive = getDriveClient();
      const desde = new Date();
      desde.setDate(desde.getDate() - 90);
      const q = `name contains 'detallado' and mimeType='application/pdf' and modifiedTime > '${desde.toISOString()}'`;
      const listRes = await drive.files.list({
        q, fields:"files(id,name,modifiedTime)", orderBy:"modifiedTime desc", pageSize:30
      });
      const pdfs = listRes.data.files || [];
      console.log(`[DETALLE] PDFs encontrados: ${pdfs.map(f=>f.name).join(", ") || "ninguno"}`);

      let fileId = null;
      for (const pdf of pdfs) {
        if (toSemanaKey(parsearNombreDetallado(pdf.name)) === semana) {
          fileId = pdf.id;
          console.log(`[DETALLE] Usando: ${pdf.name}`);
          break;
        }
      }

      if (!fileId) {
        return res.json({ ok:false, error:`PDF detallado no encontrado para semana ${semana}. PDFs disponibles: ${pdfs.map(f=>f.name).join(", ")||"ninguno"}` });
      }

      const items = await leerPDFDetallado(drive, fileId);
      detalleCache[semana] = items;
      console.log(`[DETALLE] Extraídos ${items.length} productos para semana ${semana}`);
    }

    const todos = detalleCache[semana];

    const items = grupo
      ? todos.filter(i => {
          const gi = normalize(i.grupo);
          const gq = normalize(grupo);
          return gi.includes(gq) || gq.includes(gi);
        })
      : todos;

    res.json({
      ok: true,
      items,
      total: items.reduce((a,i) => a + (i.venta||0), 0),
      totalItems: todos.length
    });
  } catch(e) {
    console.error("[DETALLE]", e.message);
    res.status(500).json({ ok:false, error: e.message });
  }
});

module.exports = router;
