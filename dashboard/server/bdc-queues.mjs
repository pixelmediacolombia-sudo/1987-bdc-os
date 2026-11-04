import {parsePhoneNumberFromString} from 'libphonenumber-js/max';
import {LOCATION,AGENT,BASE,dayKey,isExcluded} from './bdc-domain.mjs';
// IDs verified in Lucki's native field settings; never reuse across locations.
export const BDC_FIELDS={state:'LoPqik7jHvQqtz05nIWi',next:'hA97WMfmsKHXaDEoAn80',result:'y4FpYdFuVfczIClWooLw',last:'wseqHLTzm9DueAkMkNte',count:'wfPHm7u9yBXeN8qzPavp',cycle:'0mqF6U2ojJ7BcTR8rVgL',processed:'qTGUweg19qRJAc5veMvV'};
const value=(c,k)=>c.customFields?.find(f=>f.id===BDC_FIELDS[k])?.value??'';
// GHL date-only fields use UTC-midnight epoch milliseconds in native edits.
// Preserve the calendar date: converting to Virginia time would shift it back a day.
export function queueDate(value){
 const raw=String(value??'');
 if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return raw;
 if(!/^\d{13}$/.test(raw))return null;
 const date=new Date(Number(raw));
 return Number.isFinite(+date)?date.toISOString().slice(0,10):null;
}
export function buildQueues(contacts,now=new Date()){
 const today=dayKey(now),fresh=[],retry=[],october=[],september=[],review=[];const seen=new Set();
 for(const c of contacts){
  if(!c.id||seen.has(c.id)||c.locationId!==LOCATION||c.assignedTo!==AGENT||isExcluded(c))continue;seen.add(c.id);
  const state=String(value(c,'state')),result=String(value(c,'result')),last=String(value(c,'last')),next=String(value(c,'next'));
  if(c.type&&String(c.type).toLowerCase()!=='lead')continue;
  if(state&&!['NUEVO POR LLAMAR','REINTENTO PROGRAMADO','REVISIÓN'].includes(state))continue;
  const name=[c.firstName,c.lastName].filter(Boolean).join(' ')||c.contactName||c.name||'Contacto';
  const row={id:c.id,name,createdAt:c.dateAdded||null,phone:String(c.phone||''),state,result,last: last||null,next:next||null,attempts:value(c,'count')===''?null:Number(value(c,'count')),cycle:String(value(c,'cycle')),href:`${BASE}/contacts/detail/${encodeURIComponent(c.id)}`,reason:''};
  const blocked=c.dnd===true||['active','enabled'].includes(String(c.dndSettings?.Call?.status).toLowerCase())||result==='NO CONTACTAR';
  if(blocked)continue;
  const parsedPhone=parsePhoneNumberFromString(String(c.phone||''));
  if(!parsedPhone?.isValid()||parsedPhone.country!=='US'){review.push({...row,reason:'Teléfono sin validación de Estados Unidos. No entra al dialer.'});continue}
  if(!state){review.push({...row,state:'SIN CLASIFICAR',reason:'Histórico sin clasificar. Revisar llamadas, respuestas, citas y venta antes de decidir el próximo paso. No se incorpora a llamadas sin aprobar el lote.'});continue}
  if(state==='REVISIÓN'){review.push({...row,reason:'Gestión pausada para revisión de la BDC.'});continue}
  if(state==='NUEVO POR LLAMAR'){
   if(last||result){review.push({...row,reason:'Tiene un resultado previo; revisar el historial antes de tratarlo como nuevo.'});continue}
   const created=Date.parse(c.dateAdded),age=+now-created;
   if(!Number.isFinite(created)||age<0){review.push({...row,reason:'Fecha de ingreso sin verificar.'});continue}
   if(age<=48*60*60*1000)fresh.push({...row,reason:'Nuevo de las últimas 48 horas · primer intento pendiente.'});
   else if(dayKey(created)?.startsWith('2026-10-'))october.push({...row,reason:'Pendiente de octubre · superó las 48 horas sin un intento registrado por el flujo.'});
   else if(dayKey(created)?.startsWith('2026-09-'))september.push({...row,reason:'Reactivación de septiembre · gestión de llamada pendiente.'});
   else review.push({...row,reason:'Ingreso fuera de los meses aprobados para esta campaña.'});
  }else{
   const key=queueDate(next);
   const awaitingResult=result===''&&['REINTENTO DÍA 1','REINTENTO DÍA 2'].includes(row.cycle);
   if(!key||!last||(!['NO CONTESTÓ','OCUPADO'].includes(result)&&!awaitingResult)){review.push({...row,reason:'Falta fecha o resultado verificable para el reintento.'});continue}
   if(key<=today)retry.push({...row,next:key,reason:awaitingResult?'Reintento listo en GHL. Registra el resultado de esta nueva llamada; el historial anterior se conserva.':`${result==='OCUPADO'?'Ocupado':'No contestó'} · ${key<today?'pendiente vencido':'reintento de hoy'}. Comprueba que la acción anterior esté cerrada y que no haya nueva respuesta o cita.`});
  }
 }
 fresh.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
 october.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));september.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));retry.sort((a,b)=>a.next.localeCompare(b.next));
 return {fresh,retry,october,september,review,historicalLoaded:false,updatedAt:now.toISOString(),automationStatus:'published',manualActionsVerified:false};
}
