import{plain}from'./conversation-context.mjs';
import{buildQueues}from'./bdc-queues.mjs';
let queueSnapshot=null;let nextRequestAt=0;let staffEmails=new Set();
import{LOCATION,AGENT,BASE,dayBounds,dayKey,isExcluded,normalizeTask,countCalls,conversationState}from'./bdc-domain.mjs';
const contactsCache=new Map();let userNames=new Map();const threadLookupCache=new Map();let snapshot=null;let pending=null;let agentVerifiedAt=0;
export async function loadDashboard(token,location){
 if(location!==LOCATION)throw Error('location_mismatch');
 if(snapshot&&Date.now()-snapshot.at<12000)return snapshot.data;
 if(pending)return pending;
 pending=load(token).then(data=>{snapshot={at:Date.now(),data};return data}).finally(()=>{pending=null});return pending;
}
async function load(token){
 async function api(path,body){const slot=Math.max(Date.now(),nextRequestAt);nextRequestAt=slot+180;if(slot>Date.now())await new Promise(resolve=>setTimeout(resolve,slot-Date.now()));const r=await fetch('https://services.leadconnectorhq.com'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,Version:'2021-07-28',Accept:'application/json','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(18000)});if(!r.ok){await r.arrayBuffer();throw Error('GHL_'+r.status)}return r.json()}
 if(Date.now()-agentVerifiedAt>1800000){const users=await api('/users/?locationId='+LOCATION);const match=users.users?.filter(u=>u.id===AGENT&&u.roles?.locationIds?.includes(LOCATION));if(match?.length!==1)throw Error('agent_access_not_verified');agentVerifiedAt=Date.now();staffEmails=new Set(users.users.map(u=>String(u.email||'').toLowerCase()).filter(Boolean));userNames=new Map(users.users.map(u=>[u.id,u.name||[u.firstName,u.lastName].filter(Boolean).join(' ')]))}
 const now=new Date(),bounds=dayBounds(now),issues=[];
 const contact=async id=>{const cached=contactsCache.get(id);if(cached&&Date.now()-cached.at<60000)return cached.data;const j=await api('/contacts/'+encodeURIComponent(id));if(j.contact?.locationId!==LOCATION)throw Error('contact_location_mismatch');const c=j.contact;contactsCache.set(id,{at:Date.now(),data:c});return c};
 const fetchTasks=async()=>{const tasks=[];let complete=false;for(let page=0;page<20;page++){const r=await api('/locations/'+LOCATION+'/tasks/search',{assignedTo:[AGENT],completed:false,limit:100,skip:page*100});if(!Array.isArray(r.tasks))throw Error('tasks_schema_invalid');tasks.push(...r.tasks);if(r.tasks.length<100){complete=true;break}}if(!complete)throw Error('tasks_pagination_incomplete');return tasks};
 const fetchConversations=async()=>{const rows=[];let after=null,complete=false;const cursors=new Set();for(let page=0;page<20;page++){const q=new URLSearchParams({locationId:LOCATION,limit:'100',sort:'desc',sortBy:'last_message_date'});if(after)q.set('startAfterDate',String(after));const r=await api('/conversations/search?'+q);if(!Array.isArray(r.conversations))throw Error('conversations_schema_invalid');rows.push(...r.conversations);if(rows.length>=r.total||r.conversations.length<100){complete=true;break}after=r.conversations.at(-1)?.lastMessageDate;if(!after||cursors.has(after))break;cursors.add(after)}if(!complete)throw Error('conversations_pagination_incomplete');return rows};
 const fetchCalls=async()=>{const rows=[];let cursor=null,complete=false;const cursors=new Set();for(let page=0;page<20;page++){const q=new URLSearchParams({locationId:LOCATION,channel:'Call',limit:'100',sortOrder:'desc',startDate:bounds.start,endDate:bounds.end});if(cursor)q.set('cursor',cursor);const r=await api('/conversations/messages/export?'+q);if(!Array.isArray(r.messages))throw Error('calls_schema_invalid');rows.push(...r.messages);if(!r.nextCursor){complete=true;break}cursor=r.nextCursor;if(cursors.has(cursor))break;cursors.add(cursor)}if(!complete)throw Error('calls_pagination_incomplete');const ids=[...new Set(rows.filter(m=>m.userId===AGENT&&m.locationId===LOCATION&&m.direction==='outbound').map(m=>m.contactId).filter(Boolean))];const contacts=new Map();for(let i=0;i<ids.length;i+=6){await Promise.all(ids.slice(i,i+6).map(async id=>{try{contacts.set(id,await contact(id))}catch{}}))}return countCalls(rows,contacts,now)};
 const fetchQueues=async()=>{if(queueSnapshot&&Date.now()-queueSnapshot.at<60000)return queueSnapshot.data;const rows=[],seen=new Set();let afterId=null,after=null,complete=false;for(let page=0;page<30;page++){const q=new URLSearchParams({locationId:LOCATION,limit:'100'});if(afterId){q.set('startAfterId',afterId);q.set('startAfter',String(after))}const r=await api('/contacts/?'+q);if(!Array.isArray(r.contacts))throw Error('queue_contacts_schema_invalid');rows.push(...r.contacts);if(r.contacts.length<100){complete=true;break}const id=r.meta?.startAfterId,time=r.meta?.startAfter;if(!id||!time||seen.has(id))break;seen.add(id);afterId=id;after=time}if(!complete)throw Error('queue_contacts_pagination_incomplete');const data=buildQueues(rows,now);queueSnapshot={at:Date.now(),data};return data};
 const results=await Promise.allSettled([fetchTasks(),fetchConversations(),fetchCalls(),fetchQueues()]);let tasks=null,conversations=null,calls=null,queues=null;
 if(results[3].status==='fulfilled')queues=results[3].value;else issues.push('Listas de llamadas: '+results[3].reason.message);
 if(results[0].status==='fulfilled'){
  const byId=new Map();const list=results[0].value;
  for(let i=0;i<list.length;i+=6)await Promise.all(list.slice(i,i+6).map(async t=>{if(t.contactId){try{const c=await contact(t.contactId);t.contactDetails={...c,name:[c.firstName,c.lastName].filter(Boolean).join(' ')};}catch{issues.push('No se pudo ampliar el nombre de un contacto.')}}}));
  for(const t of list){const n=normalizeTask(t,now);if(n)byId.set(n.id,n)}
  tasks=[...byId.values()].sort((a,b)=>(a.internal-b.internal)||((a.dueDate?Date.parse(a.dueDate):Infinity)-(b.dueDate?Date.parse(b.dueDate):Infinity)));
  const contactCounts=new Map();tasks.forEach(t=>{if(t.contactId)contactCounts.set(t.contactId,(contactCounts.get(t.contactId)||0)+1)});tasks=tasks.map(t=>({...t,sameContactTasks:contactCounts.get(t.contactId)||1}));
 }else issues.push('Tareas: '+results[0].reason.message);
 if(results[1].status==='fulfilled'){
 const source=results[1].value.filter(c=>c.locationId===LOCATION),eligible=[];
 for(let i=0;i<source.length;i+=6)await Promise.all(source.slice(i,i+6).map(async c=>{try{const owners=Array.isArray(c.assignedTo)?c.assignedTo:c.assignedTo?[c.assignedTo]:[];if(owners.length&&!owners.includes(AGENT))return;const co=await contact(c.contactId);if(co.email&&staffEmails.has(String(co.email).toLowerCase()))return;if(owners.includes(AGENT)||(!owners.length&&co.assignedTo===AGENT)){if(!isExcluded(co))eligible.push({...c,phone:co.phone||'',createdAt:co.dateAdded||null})}}catch{issues.push('No se pudo verificar la asignación de un contacto.')}}));
 const map=new Map();for(const c of eligible){if(isExcluded(c))continue;const direction=c.lastMessageDirection;const type=c.lastMessageType;const classification=conversationState(c);const {needsReview,noContact,state}=classification;map.set(c.id,{id:c.id,contactId:c.contactId,name:c.fullName||c.contactName||'Contacto',phone:c.phone,createdAt:c.createdAt,preview:String(c.lastMessageBody||'Sin texto disponible').slice(0,600),channel:type?.replace('TYPE_','')||'Otro',direction,unread:Math.max(0,Number(c.unreadCount)||0),needsReview,noContact,state,lastMessageDate:c.lastMessageDate||null,href:`${BASE}/conversations/conversations/${encodeURIComponent(c.id)}`})}conversations=[...map.values()].sort((a,b)=>Number(b.needsReview)-Number(a.needsReview)||Number(b.unread>0)-Number(a.unread>0)||Number(b.lastMessageDate)-Number(a.lastMessageDate));
 }else issues.push('Conversaciones: '+results[1].reason.message);
 // Resolve only contacts of Johanna's existing tasks; do not reassign or include another agent's thread.
 if(tasks&&conversations){
 const missing=tasks.filter(t=>!t.internal&&t.contactId&&!conversations.some(c=>c.contactId===t.contactId));
 await Promise.all(missing.map(async t=>{try{let lookup=threadLookupCache.get(t.contactId);if(!lookup||Date.now()-lookup.at>60000){const q=new URLSearchParams({locationId:LOCATION,contactId:t.contactId,limit:'20'});const r=await api('/conversations/search?'+q);if(!Array.isArray(r.conversations))throw Error('thread_lookup');lookup={at:Date.now(),rows:r.conversations.filter(c=>c.locationId===LOCATION&&c.contactId===t.contactId)};threadLookupCache.set(t.contactId,lookup)}
 const own=lookup.rows.find(c=>Array.isArray(c.assignedTo)?c.assignedTo.includes(AGENT):c.assignedTo===AGENT);
 if(own){const classification=conversationState(own);conversations.push({id:own.id,contactId:own.contactId,name:own.fullName||own.contactName||t.name,preview:String(own.lastMessageBody||'Sin texto disponible').slice(0,600),channel:own.lastMessageType?.replace('TYPE_','')||'Otro',direction:own.lastMessageDirection,unread:Math.max(0,Number(own.unreadCount)||0),...classification,lastMessageDate:own.lastMessageDate||null,href:`${BASE}/conversations/conversations/${encodeURIComponent(own.id)}`});return}
 const ids=lookup.rows.flatMap(c=>Array.isArray(c.assignedTo)?c.assignedTo:c.assignedTo?[c.assignedTo]:[]);const owners=[...new Set(ids.map(id=>userNames.get(id)||'otra persona'))];t.threadIssue=lookup.rows.length?(owners.length?'La conversación está asignada a '+owners.join(', ')+'. Coordinar la gestión antes de contactar.':'La conversación no tiene responsable asignado. Revisar quién atenderá el hilo antes de contactar.'):'Revisar el contacto: no se encontró una conversación vinculada verificable en Lucki. La tarea original no demuestra qué pidió el cliente.';
 }catch{t.threadIssue='No se pudo consultar el hilo de este contacto. Revisar la conversación en GHL antes de contactar.'}}));
 }
 // Read recent messages directly: internal comments do not always change search metadata.
 if(conversations){
  for(let i=0;i<conversations.length;i+=6)await Promise.all(conversations.slice(i,i+6).map(async c=>{try{
   const j=await api('/conversations/'+encodeURIComponent(c.id)+'/messages?limit=20');
   if(!Array.isArray(j.messages?.messages))throw Error('recent_messages_schema');
   const messages=j.messages.messages.filter(m=>m.conversationId===c.id&&m.contactId===c.contactId&&m.locationId===LOCATION).sort((a,b)=>Date.parse(b.dateAdded)-Date.parse(a.dateAdded));
   const internal=m=>!!m.isInternal||!!m.isInternalComment||m.messageType==='TYPE_INTERNAL_COMMENT';
   const latest=messages.find(m=>!internal(m)&&!String(m.messageType||'').startsWith('TYPE_ACTIVITY_'));
   const note=messages.find(internal);
   c.latestInternal=note?{text:plain(note.body).slice(0,300),at:note.dateAdded}:null;
   c.historyRevision=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(messages.map(m=>[m.id,m.dateAdded,m.body,m.status,internal(m)])))))).map(n=>n.toString(16).padStart(2,'0')).join('');
   c.messagesCheckedAt=new Date().toISOString();
   if(latest){c.publicMessageAt=latest.dateAdded;c.preview=plain(latest.body).slice(0,600)||'Mensaje sin texto';c.direction=latest.direction;c.channel=String(latest.messageType||'').replace('TYPE_','');Object.assign(c,conversationState({lastMessageDirection:latest.direction,lastMessageBody:latest.body,lastMessageType:latest.messageType}));}
   c.lastMessageDate=messages[0]?.dateAdded||c.lastMessageDate;
   const co=await contact(c.contactId);c.phone=co.phone||'';c.createdAt=co.dateAdded||null;
  }catch(e){c.messagesError=true;issues.push('Algunos mensajes recientes no pudieron comprobarse'+(/^GHL_[0-9]{3}$/.test(e.message)?' ('+e.message+')':'')+'.')}}));
  conversations.sort((a,b)=>Number(new Date(b.lastMessageDate))-Number(new Date(a.lastMessageDate)));
  for(const t of tasks||[]){const c=conversations.find(c=>c.contactId===t.contactId);if(c){t.phone=c.phone;t.createdAt=c.createdAt;}}
 }
 if(results[2].status==='fulfilled')calls=results[2].value;else issues.push('Llamadas: '+results[2].reason.message);
 if(calls?.unverified)issues.push('Hay llamadas sin contacto verificado; la meta no se presenta como completa.');
 const weekday=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short'}).format(now);
 return {status:issues.length?'partial':'connected',agent:{name:'Johanna Gallo Londoño',id:AGENT},location:{name:'Lucki Mazda of Woodbridge',id:LOCATION},dateKey:dayKey(now),timezone:'America/New_York',workingDay:weekday!=='Sun',goal:50,updatedAt:now.toISOString(),refreshSeconds:20,tasks,conversations,calls,queues,manualActions:{status:'unsupported',count:null,href:BASE+'/conversations/manual_actions',note:'El conteo de Manual Actions no está disponible mediante la conexión pública verificada. Abre la cola de GHL.'},issues:[...new Set(issues)],ai:{status:'automatic',note:'Contextos y prioridades con IA automáticos mientras el panel está visible.'}};
}
