const router  = require("express").Router();
const { supabase } = require("./supabase");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// GET /api/compras?semana=YYYY-MM-DD_a_YYYY-MM-DD
router.get("/", async (req, res) => {
  try {
    const { semana } = req.query;
    if (!semana) return res.status(400).json({ ok: false, error: "Falta semana" });
    const { data, error } = await supabase.from("compras").select("*").eq("semana", semana).order("fecha", { ascending: true });
    if (error) throw error;
    res.json({ ok: true, compras: data || [] });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/compras/foto  — extrae datos del ticket con Claude Vision
router.post("/foto", async (req, res) => {
  try {
    const { imagen, mediaType } = req.body;
    if (!imagen) return res.status(400).json({ ok: false, error: "Falta imagen" });

    const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    const type = validTypes.includes(mediaType) ? mediaType : "image/jpeg";

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: type, data: imagen } },
          { type: "text", text: `Analiza este ticket o recibo de compra de un restaurante en Mexicali, México. Extrae los datos en JSON con este formato exacto (sin texto adicional):
{
  "proveedor": "nombre del proveedor o tienda",
  "monto": número total en pesos MXN (solo el número),
  "fecha": "YYYY-MM-DD",
  "descripcion": "descripción breve de 1 línea",
  "area": "bar" | "cocina" | "compartido",
  "items": [{"nombre": "...", "cantidad": 0, "precio": 0}]
}
Reglas para área: bebidas/licores/cerveza/hielo/energizantes/mixología → "bar"; alimentos/verduras/carnes/abarrotes/mariscos → "cocina"; limpieza/gas/mantenimiento/papelería/servicios → "compartido".
Si no puedes leer algún campo usa null. Responde SOLO el JSON.` }
        ]
      }]
    });

    const raw = msg.content[0].text.trim();
    const json = raw.startsWith("{") ? raw : raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return res.status(422).json({ ok: false, error: "No se encontró JSON en la respuesta" });

    const data = JSON.parse(json);
    res.json({ ok: true, data });
  } catch(e) {
    console.error("[compras/foto]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/compras
router.post("/", async (req, res) => {
  try {
    const { semana, fecha, proveedor, descripcion, monto, area, estado_pago, plazo_dias } = req.body;
    if (!semana || !proveedor) return res.status(400).json({ ok: false, error: "Faltan campos" });
    const { data, error } = await supabase.from("compras").insert({
      semana, fecha: fecha || null, proveedor, descripcion: descripcion || null,
      monto: +monto || 0, area: area || "compartido",
      estado_pago: estado_pago || "pagado",
      plazo_dias: estado_pago === "credito" ? (+plazo_dias || 30) : null,
      updated_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, compra: data });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/compras/:id
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await supabase.from("compras").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
