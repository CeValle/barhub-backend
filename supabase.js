const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");

// Node 18 no trae WebSocket nativo (llega hasta Node 22+), y el cliente
// Realtime de supabase-js lo exige al construirse aunque no usemos canales
// realtime — sin esto, createClient() lanza y tumba el proceso al arrancar.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: WebSocket } }
);

module.exports = { supabase };
