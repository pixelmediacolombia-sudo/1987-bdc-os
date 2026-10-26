export const LOCATION='cd9Slb2Fk2vNY3l4ukG9';
export const AGENT='bNf6DGx9F0ZWT8pYbIro';
export const ZONE='America/New_York';
export const BASE=`https://app.1987marketing.com/v2/location/${LOCATION}`;
export function dayKey(value){const d=new Date(value);if(!Number.isFinite(+d))return null;return new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(d)}
function zonedMidnight(key){const [y,m,d]=key.split('-').map(Number);const target=Date.UTC(y,m-1,d);let time=target;for(let i=0;i<4;i++){const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:ZONE,year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric',hourCycle:'h23'}).formatToParts(new Date(time)).filter(x=>x.type!=='literal').map(x=>[x.type,+x.value]));const represented=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);const delta=target-represented;time+=delta;if(!delta)break}return new Date(time)}
export function dayBounds(value=new Date()){const key=dayKey(value);const next=new Date(key+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);const nextKey=next.toISOString().slice(0,10);return {key,start:zonedMidnight(key).toISOString(),end:zonedMidnight(nextKey).toISOString()}}
export function isExcluded(contact){if(!contact)return null;const phone=String(contact.phone||'').replace(/\D/g,'').slice(-10);const name=[contact.name,contact.fullName,contact.contactName,contact.firstName,contact.lastName].filter(Boolean).join(' ');const tags=Array.isArray(contact.tags)?contact.tags.join(' '):'';return phone==='5713949733'||/\b(prueba|test|testing|interno|interna|internal|1987)\b/i.test(name+' '+tags)}
export function normalizeTask(t,now=new Date()){
 if(t.locationId!==LOCATION||t.assignedTo!==AGENT||t.deleted||t.completed===true)return null;
 const id=t._id||t.id;if(!id)return null;const c=Array.isArray(t.contactDetails)?t.contactDetails[0]:t.contactDetails;
 const internal=!!c&&!!isExcluded(c);
 const key=dayKey(now),dueKey=t.dueDate?dayKey(t.dueDate):null;
 const title=String(t.title||'Tarea pendiente');const kind=/\bresponder\b/i.test(title)?'RESPONDER':/\brecuperar\b/i.test(title)?'RECUPERAR':/seguimiento|follow.up/i.test(title)?'SEGUIMIENTO':'GESTIÓN';
 const name=[c?.firstName,c?.lastName].filter(Boolean).join(' ')||c?.name||c?.contactName||c?.fullName||'Contacto vinculado';
 return {id,name,title,kind:internal?'INTERNA':kind,internal,body:String(t.body||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim().slice(0,1200),dueDate:t.dueDate||null,dueKey,overdue:!!dueKey&&dueKey<key,today:dueKey===key,initials:name.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase(),contactId:t.contactId||c?.id||null,href:t.contactId?`${BASE}/contacts/detail/${encodeURIComponent(t.contactId)}`:`${BASE}/tasks`};
}
export function countCalls(messages,contacts,now=new Date()){
 const {start,end}=dayBounds(now);const seen=new Set();const rows=[];let excluded=0,unverified=0;
 for(const m of messages){if(m.locationId!==LOCATION||m.userId!==AGENT||m.direction!=='outbound'||!['TYPE_CALL','CALL'].includes(m.messageType))continue;const time=Date.parse(m.dateAdded);if(!(time>=Date.parse(start)&&time<Date.parse(end)))continue;if(/workflow|campaign|voice.?ai|automation/i.test(String(m.source||'')))continue;
 const unique=m.altId||m.meta?.call?.id||m.id;if(!unique){unverified++;continue}if(seen.has(unique))continue;seen.add(unique);
 const contact=contacts.get(m.contactId);const excludedContact=isExcluded(contact);if(excludedContact===null){unverified++;continue}if(excludedContact||String(m.to||'').replace(/\D/g,'').slice(-10)==='5713949733'){excluded++;continue}
 rows.push({id:m.id,contactId:m.contactId,conversationId:m.conversationId,name:contact.name||contact.fullName||[contact.firstName,contact.lastName].filter(Boolean).join(' ')||'Contacto',dateAdded:m.dateAdded,status:m.meta?.call?.status||m.status||'sin resultado',duration:m.meta?.call?.duration??m.meta?.callDuration??null,href:`${BASE}/conversations/conversations/${encodeURIComponent(m.conversationId)}`});
 }
 return {count:unverified?null:rows.length,verifiedCount:rows.length,unverified,excluded,uniqueContacts:new Set(rows.map(x=>x.contactId)).size,rows,answeredHuman:null};
}
export function conversationState(c){const inbound=c.lastMessageDirection==='inbound';const body=String(c.lastMessageBody||'').trim();const noContact=inbound&&/^(stop|unsubscribe|cancelar|baja|no contactar|no me (escribas|escriban|llames|llamen)( m[aá]s)?)[.!\s]*$/i.test(body);const textChannel=['TYPE_WHATSAPP','TYPE_INSTAGRAM','TYPE_FACEBOOK','TYPE_SMS','TYPE_EMAIL','TYPE_WEBCHAT'].includes(c.lastMessageType);const needsReview=inbound&&textChannel&&!c.isLastMessageInternalComment&&!noContact;return {noContact,needsReview,state:noContact?'NO CONTACTAR':needsReview?'ÚLTIMO MENSAJE ENTRANTE':c.lastMessageDirection==='outbound'&&textChannel?'ESPERANDO CLIENTE':'REVISAR GESTIÓN'}}

// Derived work cards, not persisted GHL Tasks. One next action per verified contact.
export function buildConversationFollowups(conversations,tasks,now=new Date()){
 const today=dayKey(now), byContact=new Map();
 for(const c of conversations||[]){
  if(!c.contactId)continue;
  const activity=c.publicMessageAt||c.lastMessageDate;
  const activeToday=dayKey(activity)===today||dayKey(c.createdAt)===today||dayKey(c.latestInternal?.at)===today;
  const due=(tasks||[]).filter(t=>!t.internal&&t.contactId===c.contactId&&t.today);
  if(!activeToday&&!c.needsReview&&!due.length)continue;
  const restricted=c.noContact||c.dnd;
  const newNote=dayKey(c.latestInternal?.at)===today&&Date.parse(c.latestInternal.at)>Date.parse(activity||'');
  const handoff=c.direction==='outbound'&&/(?:asesor[ae].*(?:enviar|escrib|contact|ayud|fotos)|te (?:enviar[aá]|escribir[aá])|devolv.*llamada)/i.test(c.preview||'');
  const kind=restricted||newNote||handoff?'REVISAR':c.needsReview?'RESPONDER':due.length?'SEGUIMIENTO':'ESPERANDO';
  const title=restricted?'Revisar restricción de contacto; no llamar ni escribir.':c.messagesError?'Revisar el hilo en GHL: no se pudieron comprobar los mensajes.':newNote?'Revisar la nota interna nueva y coordinar la acción con la responsable.':handoff?'Atender la entrega a la asesora: comprobar y cumplir lo que el equipo prometió.':c.needsReview?'Revisar y responder el último mensaje del cliente.':due.length?'Revisar el compromiso de hoy y confirmar el siguiente paso.':'El equipo respondió. Esperar al cliente; no enviar otra recuperación ahora.';
  const card={id:'conversation:'+c.contactId,contactId:c.contactId,name:c.name,title,kind,body:c.preview||'',phone:restricted?'':c.phone||'',createdAt:c.createdAt||null,dueDate:activity||null,dueKey:dayKey(activity),overdue:false,today:activeToday,internal:false,initials:c.name.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase(),href:`${BASE}/contacts/detail/${encodeURIComponent(c.contactId)}`,sameContactTasks:1,derived:true,conversationId:c.id};
  const prior=byContact.get(c.contactId);
  if(!prior||Date.parse(card.dueDate)>Date.parse(prior.dueDate))byContact.set(c.contactId,card);
 }
 return [...byContact.values()].sort((a,b)=>Number(b.kind==='RESPONDER')-Number(a.kind==='RESPONDER')||Date.parse(b.dueDate)-Date.parse(a.dueDate));
}
