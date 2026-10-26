import {LOCATION,AGENT,BASE,dayKey,isExcluded} from './bdc-domain.mjs';
// IDs verified in Lucki's native field settings; never reuse across locations.
export const BDC_FIELDS={state:'LoPqik7jHvQqtz05nIWi',next:'hA97WMfmsKHXaDEoAn80',result:'y4FpYdFuVfczIClWooLw',last:'wseqHLTzm9DueAkMkNte',count:'wfPHm7u9yBXeN8qzPavp',cycle:'0mqF6U2ojJ7BcTR8rVgL',processed:'qTGUweg19qRJAc5veMvV'};
const value=(c,k)=>c.customFields?.find(f=>f.id===BDC_FIELDS[k])?.value??'';
export function buildQueues(contacts,now=new Date()){
 const today=dayKey(now),fresh=[],retry=[],review=[];const seen=new Set();
 for(const c of contacts){
  if(!c.id||seen.has(c.id)||c.locationId!==LOCATION||c.assignedTo!==AGENT||isExcluded(c))continue;seen.add(c.id);
  const state=String(value(c,'state')),result=String(value(c,'result')),last=String(value(c,'last')),next=String(value(c,'next'));
  if(c.type&&String(c.type).toLowerCase()!=='lead')continue;
  if(state&&!['NUEVO POR LLAMAR','REINTENTO PROGRAMADO','REVISIÓN'].includes(state))continue;
  const name=[c.firstName,c.lastName].filter(Boolean).join(' ')||c.contactName||c.name||'Contacto';
  const row={id:c.id,name,state,result,last: last||null,next:next||null,attempts:value(c,'count')===''?null:Number(value(c,'count')),cycle:String(value(c,'cycle')),href:`${BASE}/contacts/detail/${encodeURIComponent(c.id)}`,reason:''};
  const blocked=c.dnd===true||['active','enabled'].includes(String(c.dndSettings?.Call?.status).toLowerCase())||result==='NO CONTACTAR';
  if(blocked)continue;
  if(!/^\+[1-9]\d{7,14}$/.test(String(c.phone||''))){review.push({...row,reason:'Revisar teléfono antes de llamar.'});continue}
  if(!state){review.push({...row,state:'SIN CLASIFICAR',reason:'Histórico sin clasificar. Revisar llamadas, respuestas, citas y venta antes de decidir el próximo paso. No se incorpora a llamadas sin aprobar el lote.'});continue}
  if(state==='REVISIÓN'){review.push({...row,reason:'Gestión pausada para revisión de la BDC.'});continue}
  if(state==='NUEVO POR LLAMAR'){
   if(last||result){review.push({...row,reason:'Tiene un resultado previo; revisar el historial antes de tratarlo como nuevo.'});continue}
   fresh.push({...row,reason:'Primer intento pendiente. Revisa el hilo antes de marcar; una casilla vacía no demuestra ausencia de llamadas históricas.'});
  }else{
   const key=/^\d{4}-\d{2}-\d{2}$/.test(next)?next:null;
   if(!key||!last||!['NO CONTESTÓ','OCUPADO'].includes(result)){review.push({...row,reason:'Falta fecha o resultado verificable para el reintento.'});continue}
   if(key<=today)retry.push({...row,reason:`${result==='OCUPADO'?'Ocupado':'No contestó'} · ${key<today?'pendiente vencido':'reintento de hoy'}. Comprueba que la acción anterior esté cerrada y que no haya nueva respuesta o cita.`});
  }
 }
 fresh.sort((a,b)=>a.name.localeCompare(b.name));retry.sort((a,b)=>a.next.localeCompare(b.next));
 return {fresh,retry,review,updatedAt:now.toISOString(),automationStatus:'draft',manualActionsVerified:false};
}
