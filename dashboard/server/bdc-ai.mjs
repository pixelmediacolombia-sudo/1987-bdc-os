import {z} from 'zod';
export const focusSchema=z.object({summary:z.string().min(1).max(350),priorities:z.array(z.object({title:z.string().min(1).max(100),action:z.string().min(1).max(350),target:z.enum(['tasks','inbox','calls'])})).min(1).max(3)});
export function focusFacts(d){
 const external=d.tasks?.filter(t=>!t.internal);
 return {date:d.dateKey,timezone:d.timezone,workingDay:d.workingDay,goal:d.goal,
 calls:d.calls?{count:d.calls.count,uniqueContacts:d.calls.uniqueContacts,unverified:d.calls.unverified}:null,
 tasks:external?{pending:external.length,overdue:external.filter(t=>t.overdue).length,today:external.filter(t=>t.today).length,withoutDate:external.filter(t=>!t.dueDate).length}:null,
 conversations:d.conversations?{assigned:d.conversations.length,needsReview:d.conversations.filter(c=>c.needsReview&&!c.noContact).length,noContact:d.conversations.filter(c=>c.noContact).length,waitingForCustomer:d.conversations.filter(c=>!c.noContact&&c.state==='ESPERANDO CLIENTE').length}:null,
 partial:d.status==='partial',manualQueueCountAvailable:false};
}
const schema={type:'object',additionalProperties:false,required:['summary','priorities'],properties:{summary:{type:'string'},priorities:{type:'array',minItems:1,maxItems:3,items:{type:'object',additionalProperties:false,required:['title','action','target'],properties:{title:{type:'string'},action:{type:'string'},target:{type:'string',enum:['tasks','inbox','calls']}}}}}};
let cache=null,inFlight=null,lastAttempt=0;
export async function generateFocus(key,d,request=fetch){
 const facts=focusFacts(d),fingerprint=JSON.stringify(facts);
 if(cache&&cache.fingerprint===fingerprint)return {...cache.data,cached:true};
 if(inFlight)return inFlight;
 if(Date.now()-lastAttempt<60000)throw Error('cooldown');
 lastAttempt=Date.now();
 inFlight=(async()=>{
  const r=await request('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-5.4-mini',store:false,reasoning:{effort:'none'},max_output_tokens:750,instructions:'Eres el asistente interno BDC de Lucki Mazda. Usa lenguaje natural para la agente: nunca menciones nombres de campos como needsReview, noContact o workingDay; di por revisar, no contactar y día laboral. En español cordial y breve, genera hasta 3 prioridades a partir exclusivamente de los conteos adjuntos. Son una foto del momento. No inventes clientes, cifras, disponibilidad, citas ni acciones ejecutadas. Null significa desconocido. Solo sugieres revisión humana; no llamas ni envías mensajes. No hay datos individuales ni historial completo: no califiques leads ni indiques a quién contactar. No confundas tarea vencida con obligación de contactar: primero verificar vigencia, cita, responsable, DND y solicitudes de no contacto. Conversación entrante requiere revisar si el equipo debe respuesta; esperar al cliente no autoriza recuperación. Si hay noContact, recordar respetarlo. Completed no demuestra respuesta humana. No conoces cuántos leads son elegibles ni Manual Actions: jamás sugieras repetir llamadas para llenar 50, ni prometer cola alimentada. Domingo es descanso: no exijas alcanzar 50 hoy. Si workingDay es true, meta de 50 intentos reales; tareas no cuentan. Prioridades con target tasks/inbox/calls para abrir cada sección. No prometas automatizaciones activas. Responde el JSON del esquema.',input:JSON.stringify(facts),text:{format:{type:'json_schema',name:'bdc_focus',strict:true,schema}}}),signal:AbortSignal.timeout(30000)});
  const result=await r.json();if(!r.ok){const code=result.error?.code;throw Error(code==='insufficient_quota'?'quota':r.status===401?'credential':r.status===429?'rate_limit':'provider_unavailable')}
  if(result.status!=='completed')throw Error('incomplete');
  const text=result.output?.flatMap(o=>o.type==='message'?o.content??[]:[]).filter(c=>c.type==='output_text').map(c=>c.text).join('');
  const parsed=focusSchema.parse(JSON.parse(text));const data={...parsed,generatedAt:new Date().toISOString(),sourceUpdatedAt:d.updatedAt,model:result.model||'gpt-5.4-mini'};
  cache={fingerprint,at:Date.now(),data};return {...data,cached:false};
 })().finally(()=>{inFlight=null});return inFlight;
}
