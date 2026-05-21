const { google }   = require("googleapis");
const Anthropic    = require("@anthropic-ai/sdk");
const { supabase } = require("./supabase");

const MESES={enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12};
const PAD=n=>String(n).padStart(2,"0");
const FMT=d=>`${d.getFullYear()}-${PAD(d.getMonth()+1)}-${PAD(d.getDate())}`;

function getDriveClient(){
  const creds=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth=new google.auth.GoogleAuth({credentials:creds,scopes:["https://www.googleapis.com/auth/drive.readonly"]});
  return google.drive({version:"v3",auth});
}

function parsearNombre(nombre){
  let n=nombre.replace(/\.pdf$/i,"").replace(/^ventas\/mesero\s*/i,"").replace(/^asistencias\s*/i,"").replace(/^venta por grupo\s*/i,"").trim();
  let m=n.match(/^(\d{1,2})-(\d{1,2})\s+(?:de\s+)?(\w+)\s+(\d{4})/i);
  if(m){const mes=MESES[m[3].toLowerCase()];if(mes)return{d1:+m[1],m1:mes,d2:+m[2],m2:mes,año:+m[4]};}
  m=n.match(/^(\d{1,2})\s+de\s+(\w+)\s*[-\u2013]\s*(\d{1,2})\s+de\s+(\w+)\s+(\d{4})/i);
  if(m){const m1=MESES[m[2].toLowerCase()],m2=MESES[m[4].toLowerCase()];if(m1&&m2)return{d1:+m[1],m1,d2:+m[3],m2,año:+m[5]};}
  m=n.match(/^(\d{1,2})\s+(\w+)\s*[-\u2013]\s*(\d{1,2})\s+(\w+)\s+(\d{4})/i);
  if(m){const m1=MESES[m[2].toLowerCase()],m2=MESES[m[4].toLowerCase()];if(m1&&m2)return{d1:+m[1],m1,d2:+m[3],m2,año:+m[5]};}
  return null;
}

function semanaVentas(p){if(!p)return null;return`${p.año}-${PAD(p.m1)}-${PAD(p.d1)}_a_${p.año}-${PAD(p.m2)}-${PAD(p.d2)}`;}

function semanaAsistencias(p){
  if(!p)return null;
  const fin=new Date(p.año,p.m2-1,p.d2),dia=fin.getDay();
  const dSab=dia===6?0:(dia===0?6:6-dia);
  const sab=new Date(fin);sab.setDate(fin.getDate()+dSab);
  const dom=new Date(sab);dom.setDate(sab.getDate()-6);
  return`${FMT(dom)}_a_${FMT(sab)}`;
}

function semanaGrupo(nombre){
  const m=nombre.match(/sem\s*(\d+)\s+(\w+)(?:\s+(\d{4}))?/i);
  if(!m)return null;
  const numSem=+m[1],mes=MESES[m[2].toLowerCase()],año=m[3]?+m[3]:2026;
  if(!mes)return null;
  const p=new Date(año,mes-1,1),dM=(3-p.getDay()+7)%7;
  const pm=new Date(año,mes-1,1+dM);
  const ini=new Date(pm);ini.setDate(pm.getDate()+(numSem-1)*7);
  const fin=new Date(ini);fin.setDate(ini.getDate()+4);
  return`${FMT(ini)}_a_${FMT(fin)}`;
}

async function buscarPDFs(drive,patron,diasAtras=120){
  const desde=new Date();desde.setDate(desde.getDate()-diasAtras);
  const q=`name contains '${patron}' and mimeType='application/pdf' and modifiedTime > '${desde.toISOString()}'`;
  const res=await drive.files.list({q,fields:"files(id,name,modifiedTime)",orderBy:"modifiedTime desc",pageSize:50});
  return res.data.files||[];
}

async function extraerDatos(drive,fileId,tipo){
  const ai=new Anthropic();
  const resp=await drive.files.get({fileId,alt:"media"},{responseType:"arraybuffer"});
  const b64=Buffer.from(resp.data).toString("base64");
  const prompts={
    ventas_mesero:`Extrae datos de ventas por mesero de este PDF SoftRestaurant. SOLO JSON array sin texto adicional:\n[{"nombre":"...","venta":número,"prop_tarjeta":número,"efectivo":número,"comensales":número}]`,
    ventas_grupo:`Extrae ventas por grupo/categoría de este reporte SoftRestaurant. SOLO JSON array sin texto adicional:\n[{"grupo":"...","venta":número,"porcentaje":número}]`,
    asistencias:`Extrae asistencia de empleados de este reporte. SOLO JSON array sin texto adicional:\n[{"nombre":"...","horas_reales":número,"dias_asistidos":número}]`
  };
  const msg=await ai.messages.create({model:"claude-sonnet-4-6",max_tokens:2000,messages:[{role:"user",content:[
    {type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},
    {type:"text",text:prompts[tipo]}
  ]}]});
  const texto=msg.content.find(c=>c.type==="text")?.text||"[]";
  try{return JSON.parse(texto.replace(/```json?|```/g,"").trim());}
  catch(e){console.error("[SYNC] JSON err:",e.message);return[];}
}

async function syncSemanal(){
  const drive=getDriveClient();
  const resultado={procesados:0,errores:[],semanas:[]};

  for(const pdf of await buscarPDFs(drive,"Ventas/mesero")){
    try{
      const semana=semanaVentas(parsearNombre(pdf.name));
      if(!semana){console.log("[SYNC] Sin fecha:",pdf.name);continue;}
      console.log(`[SYNC] ${pdf.name} → ${semana}`);
      const datos=await extraerDatos(drive,pdf.id,"ventas_mesero");
      if(!datos.length){console.log("[SYNC] Sin datos:",pdf.name);continue;}
      await supabase.from("ventas_mesero").delete().eq("semana",semana);
      const{error}=await supabase.from("ventas_mesero").insert(datos.map(d=>({semana,nombre:d.nombre,venta:+d.venta||0,prop_tarjeta:+d.prop_tarjeta||0,efectivo:+d.efectivo||0,comensales:+d.comensales||0,updated_at:new Date().toISOString()})));
      if(error)throw error;
      resultado.procesados++;resultado.semanas.push("vm:"+semana);
      console.log(`[SYNC] vm[${semana}]: ${datos.length} meseros`);
    }catch(e){console.error("[SYNC] Error",pdf.name,e.message);resultado.errores.push(pdf.name);}
  }

  for(const pdf of await buscarPDFs(drive,"Venta por grupo")){
    try{
      const semana=semanaGrupo(pdf.name);
      if(!semana){console.log("[SYNC] Sin semana:",pdf.name);continue;}
      console.log(`[SYNC] ${pdf.name} → ${semana}`);
      const datos=await extraerDatos(drive,pdf.id,"ventas_grupo");
      if(!datos.length){console.log("[SYNC] Sin datos:",pdf.name);continue;}
      await supabase.from("ventas_grupo").delete().eq("semana",semana);
      const{error}=await supabase.from("ventas_grupo").insert(datos.map(d=>({semana,grupo:d.grupo||d.nombre||"",venta:+d.venta||0,porcentaje:+d.porcentaje||0,updated_at:new Date().toISOString()})));
      if(error)throw error;
      resultado.procesados++;resultado.semanas.push("vg:"+semana);
      console.log(`[SYNC] vg[${semana}]: ${datos.length} grupos`);
    }catch(e){console.error("[SYNC] Error",pdf.name,e.message);resultado.errores.push(pdf.name);}
  }

  for(const pdf of await buscarPDFs(drive,"Asistencias")){
    try{
      const semana=semanaAsistencias(parsearNombre(pdf.name));
      if(!semana){console.log("[SYNC] Sin semana:",pdf.name);continue;}
      console.log(`[SYNC] ${pdf.name} → ${semana}`);
      const datos=await extraerDatos(drive,pdf.id,"asistencias");
      if(!datos.length){console.log("[SYNC] Sin datos:",pdf.name);continue;}
      await supabase.from("asistencias").delete().eq("semana",semana);
      const{error}=await supabase.from("asistencias").insert(datos.map(d=>({semana,nombre:d.nombre,horas_reales:+d.horas_reales||0,dias_asistidos:+d.dias_asistidos||0,updated_at:new Date().toISOString()})));
      if(error)throw error;
      resultado.procesados++;resultado.semanas.push("asist:"+semana);
      console.log(`[SYNC] asist[${semana}]: ${datos.length} empleados`);
    }catch(e){console.error("[SYNC] Error",pdf.name,e.message);resultado.errores.push(pdf.name);}
  }

  for(const t of["asistencias","ventas_grupo"]){
    await supabase.from(t).delete().like("semana","%-04-29_a_2026-04-30");
    await supabase.from(t).delete().like("semana","%-05-06_a_2026-05-07");
  }

  await supabase.from("sync_log").insert({semana:new Date().toISOString().split("T")[0],archivos_procesados:resultado.procesados,resultados:JSON.stringify(resultado)});
  console.log(`[SYNC] Done: ${resultado.procesados} procesados, ${resultado.errores.length} errores`);
  return resultado;
}

module.exports={syncSemanal};
