const router = require("express").Router();
const { supabase } = require("./supabase");

function calcularSemana() {
  const hoy = new Date(), dow = hoy.getDay(), d = dow===0?7:dow;
  const dom = new Date(hoy); dom.setDate(hoy.getDate()-d);
  const sab = new Date(dom); sab.setDate(dom.getDate()+6);
  const f = x => x.toISOString().split("T")[0];
  return f(dom)+"_a_"+f(sab);
}

router.get("/semana-actual", async (req, res) => {
  try {
    const sp = req.query.semana;
    let semana = sp || calcularSemana();
    if (!sp) {
      const chk = await supabase.from("asistencias").select("semana").eq("semana",semana).limit(1);
      if (!chk.data||!chk.data.length) {
        const lat = await supabase.from("asistencias").select("semana").order("semana",{ascending:false}).limit(1);
        if (lat.data?.length) semana = lat.data[0].semana;
      }
    }
    const tv = await supabase.from("ventas_mesero").select("*").order("semana",{ascending:false});
    const sv = [...new Set((tv.data||[]).map(v=>v.semana))].sort().reverse();
    const sva=sv[0]||semana, svp=sv[1]||sv[0]||semana;
    const gl = await supabase.from("ventas_grupo").select("semana").order("semana",{ascending:false}).limit(1);
    const sg = gl.data?.[0]?.semana||sva;
    const [gr,ar,nr,cr] = await Promise.all([
      supabase.from("ventas_grupo").select("*").eq("semana",sg),
      supabase.from("asistencias").select("*").eq("semana",semana),
      supabase.from("nomina_semanal").select("*").eq("semana",semana),
      supabase.from("comida").select("*").eq("semana",semana),
    ]);
    res.json({ok:true,semana,semanaVentasActual:sva,semanaVentasPropinas:svp,semanaGrupos:sg,
      totalVentas:(gr.data||[]).reduce((a,g)=>a+g.venta,0),
      ventasMesero:(tv.data||[]).filter(v=>v.semana===sva),
      ventasMeseroPropinas:(tv.data||[]).filter(v=>v.semana===svp),
      ventasGrupo:gr.data||[],asistencias:ar.data||[],nomina:nr.data||[],comida:cr.data||[]});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

router.post("/comida", async (req,res) => {
  try {
    const {semana,nombre,monto}=req.body;
    if(!semana||!nombre) return res.status(400).json({ok:false,error:"Faltan campos"});
    const {error}=await supabase.from("comida").upsert({semana,nombre,monto:monto||0,updated_at:new Date().toISOString()},{onConflict:"semana,nombre"});
    if(error) throw error;
    res.json({ok:true});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

router.get("/asistencias-anio", async (req,res) => {
  try {
    const anio=req.query.anio||new Date().getFullYear();
    const {data,error}=await supabase.from("asistencias").select("*").like("semana",anio+"%").order("semana",{ascending:true});
    if(error) throw error;
    const ps={};(data||[]).forEach(r=>{if(!ps[r.semana])ps[r.semana]=[];ps[r.semana].push(r);});
    res.json({ok:true,semanas:Object.keys(ps).sort(),porSemana:ps,total:(data||[]).length});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

router.get("/historico",async(req,res)=>{
  try{
    const {data}=await supabase.from("resumen_semanal").select("*").order("semana",{ascending:false}).limit(52);
    res.json({ok:true,semanas:data||[]});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

module.exports = router;
