const router = require("express").Router();
const { supabase } = require("./supabase");

function calcularSemana() {
  const hoy = new Date();
  const dow = hoy.getDay();
  let diasAtras = (dow+4)%7; if(diasAtras===0) diasAtras=7;
  const mie = new Date(hoy); mie.setDate(hoy.getDate()-diasAtras);
  const jue = new Date(mie); jue.setDate(mie.getDate()+1);
  const fmt = d => d.toISOString().split("T")[0];
  return `${fmt(mie)}_a_${fmt(jue)}`;
}

router.get("/semana-actual", async (req, res) => {
  try {
    let semana = calcularSemana();

    // Si no hay datos en la semana calculada, usar la más reciente con datos
    const check = await supabase.from("asistencias").select("semana").eq("semana",semana).limit(1);
    if (!check.data || check.data.length===0) {
      const latest = await supabase.from("asistencias").select("semana").order("semana",{ascending:false}).limit(1);
      if (latest.data?.length) semana = latest.data[0].semana;
    }

    // Las 2 semanas de ventas_mesero más recientes (actual + anterior para propinas)
    const todasVentas = await supabase.from("ventas_mesero")
      .select("*").order("semana",{ascending:false});
    
    // Agrupar por semana, tomar las 2 más recientes
    const semanas = [...new Set((todasVentas.data||[]).map(v=>v.semana))].sort().reverse();
    const semanaVentasActual  = semanas[0] || semana;
    const semanaVentasPropinas = semanas[1] || semanas[0] || semana;

    const ventasActual   = (todasVentas.data||[]).filter(v=>v.semana===semanaVentasActual);
    const ventasPropinas = (todasVentas.data||[]).filter(v=>v.semana===semanaVentasPropinas);

    const [gruposRes, asistRes, nominaRes] = await Promise.all([
      supabase.from("ventas_grupo").select("*").eq("semana",semana),
      supabase.from("asistencias").select("*").eq("semana",semana),
      supabase.from("nomina_semanal").select("*").eq("semana",semana),
    ]);

    const totalVentas = (gruposRes.data||[]).reduce((a,g)=>a+g.venta,0);

    res.json({
      ok:true, semana,
      totalVentas,
      ventasMesero:        ventasActual,    // semana actual — para moche
      ventasMeseroPropinas: ventasPropinas, // semana anterior — para propinas en tarjeta
      semanaVentasActual,
      semanaVentasPropinas,
      ventasGrupo:  gruposRes.data||[],
      asistencias:  asistRes.data||[],
      nomina:       nominaRes.data||[],
    });
  } catch(err) {
    res.status(500).json({ok:false,error:err.message});
  }
});

router.get("/historico", async (req,res) => {
  try {
    const {data} = await supabase.from("resumen_semanal").select("*").order("semana",{ascending:false}).limit(12);
    res.json({ok:true, semanas:data||[]});
  } catch(err) {
    res.status(500).json({ok:false,error:err.message});
  }
});

module.exports = router;
