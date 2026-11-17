// Only server-verified receipts and the existing mirror registry establish linkage.
function calendarVersion(e){return JSON.stringify([e.id,e.title,new Date(e.start).toISOString(),new Date(e.end).toISOString(),e.location||'',Boolean(e.cancelled)]);}
function managedCalendarEvents(state,requests=[]){
 const get=k=>JSON.parse(state?.tables.settings.find(r=>r.key===k)?.json||'null');
 const events=new Map(Object.entries(get('calendar-managed-events')||{}));
 const calendar=get('calendar');
 for(const link of get('google-calendar-sync')?.links||[]){
  if(link.suppressed)continue;
  for(const e of calendar?.events||[])if(e.provider==='google'&&(e.id===link.googleId||e.recurringId===link.googleId)&&!e.allDay&&!e.recurrence?.length){
   if(!events.has(e.id))events.set(e.id,{...e,originalStart:e.start,taskId:'calendar:'+e.id,sourceKey:'outlook:'+link.sourceId,sourceId:link.sourceId});
  }
 }
 for(const r of [...requests].sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')))){
  if(!r.calendarResult?.verified||!r.text?.startsWith('BOARD_DECISION '))continue;
  let d;try{d=JSON.parse(r.text.slice(15));}catch{continue;}
  const e=r.calendarResult.event;if(!e?.id)continue;
  if(d.kind==='calendar'&&d.choice==='confirm')events.set(e.id,{...e,managedAt:r.calendarResult.verifiedAt,taskId:d.taskId,sourceKey:d.sourceKey||d.proposal?.sourceKey||''});
  else if(d.kind==='calendar-event'){
   const prior=events.get(d.eventId);if(!prior||calendarVersion(prior)!==d.expectedVersion)continue;
   events.set(e.id,{...prior,...e,managedAt:r.calendarResult.verifiedAt,cancelled:d.choice==='cancel'});
  }
 }
 for(const [id,e] of events){const fresh=calendar?.events?.find(x=>x.provider==='google'&&x.id===id);if(!e.cancelled&&fresh&&Date.parse(calendar.checkedAt)>Date.parse(e.managedAt||0))events.set(id,{...e,...fresh});}
 return [...events.values()];
}
function applyCalendarReceipts(state,requests=[]){
 const events=managedCalendarEvents(state,requests),row=state.tables.settings.find(r=>r.key==='calendar');
 if(row){const value=JSON.parse(row.json);for(const e of events){value.events=(value.events||[]).filter(x=>!(x.provider==='google'&&x.id===e.id)&&!(e.cancelled&&e.sourceId&&x.provider==='outlook'&&(x.id===e.sourceId||x.recurringId===e.sourceId)&&Date.parse(x.start)===Date.parse(e.originalStart||e.start)));if(!e.cancelled)value.events.push({...e,provider:'google'});}row.json=JSON.stringify(value);}
 return events;
}

function createCalendarManager({documentRoot,getState,getRequests,api,onSaved}){
 const root=documentRoot.getElementById('calendar-manager');if(!root)return {render(){},reset(){}};
 let cancelling='',message='',error='',busy=false,draft=null,epoch=0;
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const local=s=>new Date(Date.parse(s)+8*3600000).toISOString().slice(0,16);
 const events=()=>managedCalendarEvents(getState(),getRequests()).filter(e=>!e.cancelled&&Date.parse(e.end)>Date.now()).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
 function render(){
  root.innerHTML='<details><summary>Manage linked calendar events</summary><p>Changes sync immediately to Google Calendar. Times are Hong Kong time. Only linked individual events can be changed.</p>'+(message?'<p role="status">'+esc(message)+'</p>':'')+(error?'<p role="alert" class="error">'+esc(error)+'</p>':'')+events().map(e=>{const x=draft?.id===e.id?draft:e;return '<details class="task"><summary>'+esc(e.title)+' · '+esc(local(e.start).replace('T',' '))+'</summary><div class="task-body" data-calendar-editor="'+esc(e.id)+'"><label>Title<input data-calendar-field="title" maxlength="300" value="'+esc(x.title)+'"></label><label>Start (HKT)<input type="datetime-local" data-calendar-field="start" value="'+esc(x.startLocal||local(x.start))+'"></label><label>End (HKT)<input type="datetime-local" data-calendar-field="end" value="'+esc(x.endLocal||local(x.end))+'"></label><label>Location<input data-calendar-field="location" maxlength="500" value="'+esc(x.location||'')+'"></label><button data-calendar-action="update" data-event="'+esc(e.id)+'"'+(busy?' disabled':'')+'>Save calendar changes</button><button data-calendar-action="ask-cancel" data-event="'+esc(e.id)+'"'+(busy?' disabled':'')+'>Cancel event…</button>'+(cancelling===e.id?'<div role="alert"><p>Cancel “'+esc(e.title)+'” on '+esc(local(e.start).replace('T',' '))+' HKT in your Google Calendar? This removes this event only.</p><button data-calendar-action="cancel" data-event="'+esc(e.id)+'"'+(busy?' disabled':'')+'>Yes, cancel this event</button><button data-calendar-action="keep" data-event="'+esc(e.id)+'">Keep event</button></div>':'')+'</div></details>';}).join('')+(!events().length?'<p>No upcoming linked events.</p>':'')+'</details>';
 }
 root.addEventListener('click',async event=>{
  const b=event.target.closest?.('[data-calendar-action]');if(!b||busy)return;
  const e=events().find(x=>x.id===b.dataset.event);if(!e)return;
  const choice=b.dataset.calendarAction;
  if(choice==='ask-cancel'||choice==='keep'){cancelling=choice==='ask-cancel'?e.id:'';render();root.querySelector('details').open=true;const editor=[...root.querySelectorAll('[data-calendar-editor]')].find(x=>x.dataset.calendarEditor===e.id);if(editor)editor.parentElement.open=true;return;}
  if(choice==='cancel'&&cancelling!==e.id)return;
  const container=b.closest('[data-calendar-editor]'),fields=Object.fromEntries([...container.querySelectorAll('[data-calendar-field]')].map(x=>[x.dataset.calendarField,x.value]));
  let proposal;
  try{if(choice==='update'){proposal={title:fields.title.trim(),start:new Date(fields.start+':00+08:00').toISOString(),end:new Date(fields.end+':00+08:00').toISOString(),location:fields.location.trim()};if(!proposal.title||Date.parse(proposal.end)<=Date.parse(proposal.start))throw Error();}}catch{error='Enter a title and valid start/end times.';render();return;}
  const attempt=epoch;draft={id:e.id,title:fields.title,location:fields.location,startLocal:fields.start,endLocal:fields.end};busy=true;b.disabled=true;b.textContent='Saving…';error='';message='';
  try{const result=await api({action:'calendar-change',id:crypto.randomUUID(),eventId:e.id,expectedVersion:calendarVersion(e),choice,proposal,cancelConfirmed:choice==='cancel'});if(attempt!==epoch)return;onSaved(result.request,result.calendarResult);if(result.calendarError)throw Error(result.calendarError);if(!result.calendarResult?.verified)throw Error('Calendar update is not yet verified. Retry to check the saved result.');message=choice==='cancel'?'Cancelled in your calendar and verified.':'Calendar changes saved and verified.';draft=null;cancelling='';}catch(e){if(attempt===epoch)error=e.message;}finally{if(attempt===epoch){busy=false;render();root.querySelector('details').open=true;}}
 });
 return {render,reset(){epoch++;cancelling='';message='';error='';draft=null;busy=false;root.replaceChildren();}};
}

// A deterministic view of durable owner commands, never a second task store.
function projectDecisionState(state,requests=[]){
 if(!state)return state;const next=structuredClone(state);
 const tasks=new Map(next.tables.tasks.map(r=>[r.id,{row:r,task:JSON.parse(r.json)}]));
 const settings=key=>{const row=next.tables.settings.find(r=>r.key===key);return row?{row,value:JSON.parse(row.json)}:null;};
 for(const request of [...requests].sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')))){
  if(!request.text?.startsWith('BOARD_DECISION '))continue;
  let d;try{d=JSON.parse(request.text.slice(15));}catch{continue;}
  const entry=tasks.get(d.taskId),t=entry?.task;if(!t||t.deletedAt||t.revision!==d.revision||d.title&&d.title!==t.title||d.sourceKey&&d.sourceKey!==t.source?.key)continue;
  let changed=false;
  if(d.kind==='calendar'&&d.choice==='confirm'&&request.calendarResult?.verified&&t.status==='review'){
   const event=request.calendarResult.event,p=d.proposal;
   if(p&&event?.id&&event.title===p.title&&Date.parse(event.start)===Date.parse(p.start)&&Date.parse(event.end)===Date.parse(p.end)&&(event.location||'')===(p.location||'')){
    t.status='done';t.completedAt=request.calendarResult.verifiedAt;changed=true;
    const calendar=settings('calendar');if(calendar){calendar.value.events=(calendar.value.events||[]).filter(e=>e.id!==event.id).concat({...event,provider:'google'});calendar.row.json=JSON.stringify(calendar.value);}
   }
  }
  if(d.choice==='ignore'&&['review','todo','waiting'].includes(t.status)){t.status='cancelled';t.ignoredAt=request.createdAt;changed=true;}
  else if(d.choice==='accept'&&t.status==='review'&&d.kind!=='calendar'){t.status=t.opportunity?'todo':t.source?.proposedStatus||'todo';if(t.opportunity)t.longTerm=true;changed=true;}
  else if((d.kind==='work'&&d.choice==='complete'||d.kind==='completion'&&d.choice==='confirm')&&['todo','waiting'].includes(t.status)){t.status='done';t.completedAt=request.createdAt;t.steps=(t.steps||[]).map(s=>({...s,done:true}));changed=true;}
  if(d.kind==='completion'){
   const f=settings('completion-feedback');if(f){for(const item of f.value)if(item.id===d.feedbackId&&item.status==='pending')item.status=d.choice==='keep'?'kept':'confirmed';f.row.json=JSON.stringify(f.value);}
  }
  if(changed){t.revision++;t.updatedAt=request.createdAt||t.updatedAt;entry.row.json=JSON.stringify(t);}
 }
 applyCalendarReceipts(next,requests);
 return next;
}
function createDecisionBoard({getState,endpoint,onChange,documentRoot=document,fetcher=fetch}){
 const $=id=>documentRoot.getElementById(id);let token='',requests=[],error='',notice='',epoch=0;const busy=new Set();
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const snapshot=()=>projectDecisionState(getState(),requests);
 const tasks=()=>snapshot()?.tables.tasks.map(r=>JSON.parse(r.json))||[];
 const setting=key=>{const r=getState()?.tables.settings.find(x=>x.key===key);return r?JSON.parse(r.json):null;};
 const pending=id=>requests.find(r=>r.taskId===id&&r.status==='pending'&&r.kind==='calendar'&&r.choice==='confirm'&&!r.calendarResult?.verified);
 const ignored=id=>requests.some(r=>r.taskId===id&&r.choice==='ignore'&&(r.status==='pending'||r.currentTaskStatus==='cancelled'));
 async function api(data){const r=await fetcher(endpoint.replace(/\/$/,'')+'/board',{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,sessionToken:token})});const value=await r.json();if(!r.ok)throw Error(value.error||'Could not save your choice.');return value;}
 const calendarManager=createCalendarManager({documentRoot,getState:()=>getState(),getRequests:()=>requests,api,onSaved:(request,result)=>{const old=requests.find(r=>r.id===request.id);if(old){if(result)old.calendarResult=result;}else requests.push({...request,calendarResult:result});render();onChange?.();}});
 const source=t=>/^https:\/\//.test(t.source?.url||t.link||'')?'<a target="_blank" rel="noopener noreferrer" href="'+esc(t.source?.url||t.link)+'">View source ↗</a>':'';
 const buttons=(t,kind,choices,feedbackId='')=>pending(t.id)?'<p class="queued">Confirmed · calendar update not yet completed</p><button data-decision="confirm" data-kind="calendar" data-task="'+esc(t.id)+'" data-revision="'+t.revision+'">Retry calendar update</button>':'<div class="decision-actions">'+choices.map(([choice,label])=>'<button data-decision="'+choice+'" data-task="'+esc(t.id)+'" data-revision="'+t.revision+'" data-kind="'+kind+'" data-feedback="'+esc(feedbackId)+'">'+label+'</button>').join('')+'</div>';
 const date=(label,value)=>'<div><dt>'+label+'</dt><dd>'+esc(value||'Not confirmed')+'</dd></div>';
 function render(){
  if(!getState())return;
  calendarManager.render();
  const list=tasks().filter(t=>!t.deletedAt),proposals=setting('meeting-proposals')||{};
  const decisions=list.filter(t=>t.status==='review'&&!t.opportunity&&(proposals[t.id]||t.importance==='high'||t.priority==='high'||/^Decide whether/i.test(t.title)||(effectiveDueDate(t)&&effectiveDueDate(t)<=addDays(today(),7)))).sort((a,b)=>Number(Boolean(proposals[b.id]))-Number(Boolean(proposals[a.id]))||((a.dueDate||'9999').localeCompare(b.dueDate||'9999'))||String(b.updatedAt).localeCompare(a.updatedAt));
  const projectedFeedback=snapshot()?.tables.settings.find(x=>x.key==='completion-feedback');
  const feedback=(projectedFeedback?JSON.parse(projectedFeedback.json):[]).filter(f=>f.status==='pending').map(f=>({f,t:list.find(t=>t.id===f.taskId&&['todo','waiting'].includes(t.status))})).filter(x=>x.t);
  $('decisions').innerHTML=decisions.map(t=>{const p=proposals[t.id],kind=p?'calendar':'task';return '<article class="decision-card"><p class="card-kind">'+(p?'Calendar check':'For your decision')+'</p><h3>'+esc(t.title.replace(/^Check calendar entry: /,''))+'</h3><p>'+esc(p?.question||t.notes||t.source?.excerpt||'Would you like to take this forward?')+'</p>'+(p?'<dl>'+date('When',p.start?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Hong_Kong',dateStyle:'medium',timeStyle:'short'}).format(new Date(p.start))+' HKT':'')+date('Until',p.end?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Hong_Kong',timeStyle:'short'}).format(new Date(p.end)):'')+date('Where',p.location)+'</dl><label for="answer-'+esc(t.id)+'">Details or correction'+(!p.confirmed?' (required)':' (optional)')+'</label><textarea id="answer-'+esc(t.id)+'" maxlength="1000" rows="2" placeholder="Confirm missing details or correct the proposal"></textarea>':'')+source(t)+buttons(t,kind,p?[['confirm','Confirm details'],['ignore','Ignore']]:[['accept','Accept'],['ignore','Ignore']])+'</article>';}).join('')+feedback.map(({t,f})=>'<article class="decision-card"><p class="card-kind">Completion check</p><h3>'+esc(t.title)+'</h3><p>'+esc(f.reason||f.excerpt)+'</p>'+source(t)+buttons(t,'completion',[['confirm','Completed'],['keep','Keep open']],f.id)+'</article>').join('');
  $('decisions-empty').hidden=Boolean(decisions.length+feedback.length);
  const opportunities=list.filter(t=>t.status==='review'&&t.opportunity&&t.opportunity.recommendation!=='skip'&&t.opportunity.eligibilityStatus!=='ineligible').sort((a,b)=>(a.internalDueDate||a.externalDueDate||a.dueDate||'9999').localeCompare(b.internalDueDate||b.externalDueDate||b.dueDate||'9999'));
  $('opportunities').innerHTML=opportunities.map(t=>'<article class="decision-card opportunity-card"><p class="card-kind">'+esc(t.opportunity.type)+' · '+(t.opportunity.recommendation==='consider'?'Worth considering':'Possible fit')+'</p><h3>'+esc(t.title)+'</h3><dl>'+date('Why it fits',t.opportunity.fit)+date('Eligibility',t.opportunity.eligibility)+date('Preparation',t.opportunity.effort)+date('Internal deadline',t.internalDueDate)+date('External deadline',t.externalDueDate||t.dueDate)+'</dl>'+source(t)+buttons(t,'task',[['accept','Pursue'],['ignore','Ignore']])+'</article>').join('');
  $('opportunities-empty').hidden=Boolean(opportunities.length);
  $('decision-count').textContent=decisions.length+feedback.length;$('opportunity-count').textContent=opportunities.length;
  const calendarPending=requests.filter(r=>r.status==='pending'&&r.kind==='calendar'&&r.choice==='confirm'&&!r.calendarResult?.verified),notes=requests.filter(r=>r.status==='pending'&&r.kind==='note'),recent=requests.filter(r=>r.status==='done').slice(-5).reverse();
  $('request-status').innerHTML=(error?'<p class="error" role="alert">'+esc(error)+'</p>':'')+(notice?'<p role="status">'+esc(notice)+'</p>':'')+(calendarPending.length?'<p class="queued">'+calendarPending.length+' confirmed calendar '+(calendarPending.length===1?'update has':'updates have')+' not yet been written to your calendar.</p>':'')+(notes.length?'<p class="queued">Note saved for your next review.</p>':'')+(recent.length?'<details><summary>Recent results</summary>'+recent.map(r=>'<p>'+esc(r.reply)+'</p>').join('')+'</details>':'');
 }
 documentRoot.addEventListener('click',async event=>{const b=event.target.closest?.('[data-decision]');if(!b||!getState()||busy.has(b.dataset.task))return;busy.add(b.dataset.task);b.disabled=true;b.textContent='Saving…';error='';notice='';const attempt=epoch;try{const task=tasks().find(t=>t.id===b.dataset.task);if(!task)throw Error('Please refresh.');const id=crypto.randomUUID(),answer=pending(task.id)?JSON.parse(pending(task.id).text.slice(15)).answer||'':$('answer-'+task.id)?.value.trim()||'',d={kind:b.dataset.kind,taskId:task.id,revision:Number(b.dataset.revision),choice:b.dataset.decision,feedbackId:b.dataset.feedback,...(b.dataset.kind==='calendar'?{proposal:setting('meeting-proposals')?.[task.id]}:{}),title:task.title,sourceKey:task.source?.key||''};const value=await api({action:'submit',id,...d,answer});if(attempt!==epoch)return;if(!requests.some(r=>r.id===value.id))requests.push({calendarResult:value.calendarResult,id:value.id,text:'BOARD_DECISION '+JSON.stringify(d),taskId:task.id,kind:d.kind,choice:d.choice,status:'pending',createdAt:new Date().toISOString()});const existing= requests.find(r=>r.id===value.id);if(existing&&value.calendarResult)existing.calendarResult=value.calendarResult;if(value.calendarError)error=value.calendarError;notice=value.calendarResult?.verified?'Added to your calendar and verified.':d.kind==='calendar'&&d.choice==='confirm'?'Details confirmed. Calendar update not yet completed.':d.choice==='ignore'?'Ignored and saved.':d.choice==='accept'?'Added to your work and saved.':d.choice==='keep'?'Kept open and saved.':'Completed and saved.';render();onChange?.();}catch(e){if(attempt===epoch){error=e.message;render();onChange?.();}}finally{busy.delete(b.dataset.task);b.disabled=false;}});
 $('note-form')?.addEventListener('submit',async event=>{event.preventDefault();const text=$('work-note').value.trim();if(!text)return;const b=$('save-note');b.disabled=true;try{const value=await api({action:'note',id:crypto.randomUUID(),text});$('work-note').value='';requests.push({id:value.id,choice:'note',kind:'note',status:'pending'});error='';}catch(e){error=e.message;}finally{b.disabled=false;render();}});
 return {render,ignored,pending,snapshot,reset(){calendarManager.reset();epoch++;token='';requests=[];error='';notice='';busy.clear();if($('work-note'))$('work-note').value='';},async start(sessionToken){const attempt=++epoch;token=sessionToken;try{const value=await api({action:'status'});if(attempt!==epoch)return;requests=value.requests;error='';}catch(e){if(attempt!==epoch)return;error=e.message;}render();onChange?.();}};
}

// Read-only suggestions. No task dates, statuses or calendar entries are changed.
const timelineMinuteOf = text => Number(text.slice(0,2))*60+Number(text.slice(3));
const timelineClock = n => `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
function decisionNeeded(task,{day,now=new Date(),assessment={},proposal,queued=false}={}) {
  if(queued)return true;
  if(task.deletedAt||['done','cancelled'].includes(task.status))return false;
  const due=[task.dueDate,task.internalDueDate,task.externalDueDate].filter(Boolean).sort()[0]||'';
  if(task.opportunity){
    if(task.opportunity.recommendation==='skip'||task.opportunity.eligibilityStatus==='ineligible')return false;
    if(task.opportunity.recommendation==='consider')return true;
    return !!due&&due>=day&&due<=new Date(Date.parse(day+'T12:00:00Z')+2*86400000).toISOString().slice(0,10);
  }
  if(task.importance==='high'||task.priority==='high'||assessment.important)return true;
  if(due&&due<=new Date(Date.parse(day+'T12:00:00Z')+2*86400000).toISOString().slice(0,10))return true;
  if(proposal){const delta=Date.parse(proposal.start)-Number(now);return proposal.confirmed===true&&delta>=0&&delta<=2*86400000;}
  return false;
}
function suggestedTimeline({day, now, preferences:p, events, candidates, focus, focusSlot, focusMinutes, off=false}) {
  const rank=t=>t.assessment.weight??(({overdue:250,today:220,soon:130,followup:100,none:0}[t.assessment.urgency]||0)+(t.assessment.important?65:0));
  const deadline=t=>[t.dueDate,t.internalDueDate,t.externalDueDate].filter(Boolean).sort()[0]||'9999';
  candidates=[...candidates].sort((a,b)=>rank(b)-rank(a)||deadline(a).localeCompare(deadline(b)));
  const midnight=Date.parse(day+'T00:00:00+08:00');
  const current=Math.max(0,Math.min(1440,Math.ceil((+now-midnight)/300000)*5));
  const parts=['morning','afternoon','evening'];
  const windows={};
  for(const part of parts){
    const start=Math.max(timelineMinuteOf(p[part+'Start']),current),end=timelineMinuteOf(p[part+'End']);
    const busy=events.filter(e=>e.busy).map(e=>[Math.max(start,(Date.parse(e.start)-midnight)/60000-p.meetingBuffer),Math.min(end,(Date.parse(e.end)-midnight)/60000+p.meetingBuffer)]).filter(([a,b])=>a<b).sort((a,b)=>a[0]-b[0]);
    let cursor=start;windows[part]=[];
    for(const [a,b] of busy){if(a>cursor)windows[part].push([Math.ceil(cursor),Math.floor(a)]);cursor=Math.max(cursor,b);}
    if(cursor<end)windows[part].push([Math.ceil(cursor),end]);
  }
  const availableMinutes=Object.fromEntries(parts.map(part=>[part,windows[part].reduce((n,[start,end])=>n+end-start,0)]));
  const result={asOf:timelineClock(current),availableMinutes,items:[],unscheduled:[],rankOrder:candidates.map(t=>t.id),off};
  if(off)return result;
  const assigned=new Set();let eveningMinutes=0,eveningCount=0;
  function place(task,allowed,duration=task.assessment.estimated){
    if(assigned.has(task.id))return true;
    for(const part of allowed){
      if(part==='evening'&&(eveningMinutes+duration>30||eveningCount>=2))continue;
      const slot=windows[part].find(w=>w[1]-w[0]>=duration);
      if(!slot)continue;
      const start=slot[0];slot[0]+=duration;assigned.add(task.id);
      if(part==='evening'){eveningMinutes+=duration;eveningCount++;}
      result.items.push({kind:'task',taskId:task.id,title:task.title,start:timelineClock(start),end:timelineClock(start+duration),minutes:duration,part,type:task.assessment.type,urgency:task.assessment.urgency,important:task.assessment.important,partial:duration<task.assessment.estimated,followUp:task.status==='waiting'});
      return true;
    }
    return false;
  }
  const hard=candidates.filter(t=>['today','overdue'].includes(t.assessment.urgency));
  const deadlineFirst=p.deadlineFirst!==false;
  if(deadlineFirst)for(const task of hard)if(task.id!==focus?.id&&!(task.assessment.type==='deep'&&focusSlot==='none'))place(task,['morning','afternoon']);
  if(focus&&focusSlot!=='none')place(focus,[focusSlot],focusMinutes);
  for(const task of candidates){
    if(task.id===focus?.id)continue;
    if(task.assessment.type==='deep'){if(focusSlot!=='none')place(task,['morning','afternoon']);}
    else if(task.assessment.type==='admin')place(task,deadlineFirst&&hard.some(t=>t.id===task.id)?['morning','afternoon']:['afternoon']);
    else place(task,hard.some(t=>t.id===task.id)?['afternoon','evening']:['evening']);
  }
  for(const task of candidates.filter(t=>!assigned.has(t.id))){
    const selected=task.id===focus?.id;
    result.unscheduled.push({taskId:task.id,title:task.title,minutes:selected?focusMinutes:task.assessment.estimated,reason:task.assessment.type==='deep'&&focusSlot==='none'?'You chose not to schedule deep work today.':selected?'No continuous slot in your selected focus period. Adjust the period or estimate.':task.assessment.type==='misc'?'No room within the light evening limit.':'No continuous slot of sufficient length remains today.'});
  }
  for(const event of events.filter(e=>e.busy&&Date.parse(e.end)>+now)){
    const start=Math.max(0,Math.floor((Date.parse(event.start)-midnight)/60000)),end=Math.min(1440,Math.ceil((Date.parse(event.end)-midnight)/60000));
    result.items.push({kind:'event',title:event.title,start:timelineClock(start),end:timelineClock(end),ongoing:Date.parse(event.start)<+now});
  }
  result.items.sort((a,b)=>a.start.localeCompare(b.start)||a.kind.localeCompare(b.kind));
  return result;
}

function planHalfDays(state,{now=new Date(),day=today(now),ignored=()=>false}={}){
 const setting=key=>{const r=state.tables.settings.find(x=>x.key===key);return r?JSON.parse(r.json):null;};
 const p={morningStart:'09:00',morningEnd:'12:00',afternoonStart:'14:00',afternoonEnd:'18:00',eveningStart:'19:00',eveningEnd:'20:00',meetingBuffer:15,focusMinutes:90,...setting('rhythm')};
 const cal=setting('calendar'),start=Date.parse(day+'T00:00:00+08:00'),end=start+86400000;
 const links=setting('google-calendar-sync')?.links||[],mirrored=new Set(links.filter(l=>!l.suppressed&&!l.failed).map(l=>l.sourceId));
 const seen=new Set(),events=(cal?.events||[]).filter(e=>Date.parse(e.start)<end&&Date.parse(e.end)>start).filter(e=>e.provider!=='outlook'||!mirrored.has(e.id)||(cal.events||[]).every(g=>g.provider!=='google'||!links.some(l=>l.sourceId===e.id&&l.googleId===g.id))).filter(e=>{const k=e.title.toLowerCase().trim()+'|'+e.start+'|'+e.end;if(seen.has(k))return false;seen.add(k);return true;});
 const workDay=state.tables.work_days?.find(r=>r.day===day),record=workDay?JSON.parse(workDay.json):null;
 const candidates=state.tables.tasks.map(r=>JSON.parse(r.json)).filter(t=>!ignored(t.id)&&isToday(t,day)&&['todo','waiting'].includes(t.status)).map(t=>{
  const type=t.workType&&t.workType!=='auto'?t.workType:t.project==='科研申请'||/proposal|research|paper|manuscript|experiment|rebuttal/i.test(t.title)?'deep':t.kind==='bill'||t.project==='个人事务'?'misc':'admin';
  const due=effectiveDueDate(t),urgency=due&&due<day?'overdue':due===day?'today':due&&due<=addDays(day,2)?'soon':t.status==='waiting'&&t.followUpDate<=day?'followup':'none';
  const important=t.importance==='high'||(t.importance!=='normal'&&(t.priority==='high'||type==='deep'));
  return {...t,assessment:{type,urgency,important,estimated:t.estimatedMinutes||(type==='deep'?90:type==='misc'?15:30)}};
 });
 const focus=candidates.find(t=>t.id===record?.focusId)||candidates.find(t=>t.assessment.type==='deep');
 const vacation=events.some(e=>/vacation|annual leave|\bPTO\b|休假|年假|度假/i.test(e.title)&&e.busy);
 const timeline=suggestedTimeline({day,now:day===today(now)?now:new Date(day+'T00:00:00+08:00'),preferences:p,events,candidates,focus,focusSlot:record?.focusSlot||'morning',focusMinutes:focus?Math.min(p.focusMinutes,focus.assessment.estimated):0,off:record?.mode==='off'||vacation});
 return {...timeline,day,calendarVerified:Boolean(cal?.complete&&Date.now()-Date.parse(cal.checkedAt)<6*3600000&&Date.parse(cal.start)<=start&&Date.parse(cal.end)>=end),focusId:focus?.id||''};
}

// Public login UI. Recipient and encryption secrets are never configured here.
function createTabSession(storage,now=()=>Date.now()){
 const key='daily-bench-session-v1';let cached='';
 const clear=()=>{cached='';try{storage?.removeItem(key);}catch{}};
 const expiry=token=>{try{if(typeof token!=='string'||token.length>1000||token.split('.').length!==2)return 0;const p=token.split('.')[0].replaceAll('-','+').replaceAll('_','/');return JSON.parse(atob(p)).exp||0;}catch{return 0;}};
 // Allow a small client/server clock difference. The server still enforces
 // the signed original 30-minute expiry for every resume and write.
 const read=()=>{let token=cached;try{token=storage?.getItem(key)||cached;}catch{}const exp=expiry(token);if(!Number.isSafeInteger(exp)||exp<=now()||exp>now()+31*60000){clear();return '';}return token;};
 const save=token=>{const exp=expiry(token);if(!Number.isSafeInteger(exp)||exp<=now()||exp>now()+31*60000)return;cached=token;try{storage?.setItem(key,token);}catch{}};
 return {read,save,clear};
}
function initialiseOtp({endpoint,onUnlocked,documentRoot=document,fetcher=fetch,random=crypto,storage}){
 const root=documentRoot,$=id=>root.getElementById(id);let challenge=null,nonce='',generation=0,cooldown=null;
 if(storage===undefined)try{storage=window.sessionStorage;}catch{storage=null;}
 const tabSession=createTabSession(storage);let restoring=false;
 const parsed=new URL(endpoint);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('Invalid login endpoint.');
 const api=async(action,data)=>{const r=await fetcher(endpoint.replace(/\/$/,'')+'/'+action,{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();if(!r.ok)throw Object.assign(new Error(action==='request'?'A code could not be sent. Please wait and try again.':action==='board'?'Your session could not be restored.':'The code could not be verified. Please try again.'),{status:r.status});return value;};
 const open=async(result,attempt)=>{if(typeof result.unlockSecret!=='string'||result.unlockSecret.length<16||typeof result.sessionToken!=='string')throw new Error('Could not open your records.');let secret=result.unlockSecret;delete result.unlockSecret;if(attempt===generation)tabSession.save(result.sessionToken);try{await onUnlocked(secret,result.sessionToken);}finally{secret='';}};
 const reset=()=>{generation++;challenge=null;nonce='';clearInterval(cooldown);cooldown=null;$('otp-code').value='';$('otp-form').hidden=true;$('send-code').disabled=false;$('send-code').textContent='Send code';$('verify-code').disabled=false;$('otp-status').textContent='';$('unlock-error').textContent='';};
 $('send-code').onclick=async()=>{
  if(tabSession.read()){if(await restore())return;if(tabSession.read())return;}
  const attempt=++generation;$('send-code').disabled=true;$('unlock-error').textContent='';nonce=Array.from(random.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  try{const result=await api('request',{nonce});if(attempt!==generation)return;if(!/^[0-9a-f-]{36}$/.test(result.requestId||''))throw new Error('Cannot start sign-in.');challenge=result.requestId;$('otp-form').hidden=false;$('otp-status').textContent='Check your inbox for a one-time code.';let seconds=60;$('send-code').textContent='Send again in '+seconds+'s';clearInterval(cooldown);cooldown=setInterval(()=>{seconds--;$('send-code').textContent=seconds>0?'Send again in '+seconds+'s':'Send another code';if(seconds<=0){clearInterval(cooldown);cooldown=null;$('send-code').disabled=false;}},1000);}catch(error){if(attempt===generation){$('unlock-error').textContent=error.message;$('send-code').disabled=false;$('send-code').textContent='Send code';}}
 };
 $('otp-form').onsubmit=async event=>{
  event.preventDefault();if(!challenge)return;const attempt=generation;let code=$('otp-code').value.trim();$('otp-code').value='';if(!/^\d{8}$/.test(code)){$('unlock-error').textContent='Enter the eight-digit code from your email.';return;}$('verify-code').disabled=true;$('unlock-error').textContent='';
  try{const result=await api('verify',{requestId:challenge,nonce,code});code='';if(attempt!==generation)return;await open(result,attempt);if(attempt===generation)reset();}catch(error){if(attempt===generation){$('unlock-error').textContent=error.message;$('verify-code').disabled=false;}}finally{code='';}
 };
 const restore=async()=>{if(restoring)return false;const token=tabSession.read();if(!token)return false;restoring=true;const attempt=++generation;$('otp-status').textContent='Restoring your session…';try{const result=await api('board',{action:'resume',sessionToken:token});if(attempt!==generation)return false;await open(result,attempt);if(attempt===generation)reset();return true;}catch(error){if(attempt===generation){if(error.status===401)tabSession.clear();$('otp-status').textContent='';$('unlock-error').textContent=error.status===401?'Your session expired. Send a new code.':error.message;}return false;}finally{restoring=false;}};
 return {reset,restore,forget:()=>{tabSession.clear();reset();}};
}

import {unseal} from './vault.mjs';
import {today,addDays,effectiveDueDate,isToday,PROJECTS} from './core.mjs';
const $=id=>document.getElementById(id),escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={'教学':'Teaching','科研申请':'Research & proposals','学生事务':'Student matters','行政报销':'Administration & expenses','合作交流':'Collaboration & visits','个人事务':'Personal'};
let otpController=null,decisionBoard=null;
let state=null,store=null,view='today',calendarDay='',planningDay='today',activity=Date.now(),session=0;
const fmt=(date,options={})=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Hong_Kong',...options}).format(new Date(date));
const safeLink=url=>{try{return new URL(url).protocol==='https:'?url:'';}catch{return '';}};
function setting(name){return JSON.parse((decisionBoard?.snapshot()||state).tables.settings.find(r=>r.key===name)?.json||'null');}
function visibleCalendarEvents(calendar){const links=setting('google-calendar-sync')?.links||[];return calendar.events.filter(e=>e.provider!=='outlook'||!links.some(l=>(l.sourceId===e.id||l.sourceId===e.recurringId)&&(l.suppressed||calendar.events.some(g=>g.provider==='google'&&(g.id===l.googleId||g.recurringId===l.googleId)))));}
function lock({forget=false}={}){session++;state=null;store=null;if(forget)otpController?.forget();else otpController?.reset();decisionBoard?.reset();$('workbench').hidden=true;$('gate').hidden=false;for(const id of ['tasks','agenda','read-items','calendar-days','views','results','updated','encouragement','decisions','opportunities','request-status','half-day-plan','plan-overflow','plan-status'])$(id).replaceChildren();$('search').value='';$('unlock-error').textContent='';document.title='Daily';}
$('lock').onclick=()=>lock({forget:true});
$('refresh').onclick=()=>{lock();location.reload();};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&state)lock();else if(!document.hidden&&!state)otpController?.restore();});
window.addEventListener('pageshow',()=>{if(!document.hidden&&!state)otpController?.restore();});
for(const event of ['pointerdown','keydown','scroll'])document.addEventListener(event,()=>activity=Date.now(),{passive:true});
setInterval(()=>{if(state&&Date.now()-activity>600000)lock();},10000);
const authConfig=await (await fetch('./auth-config.json',{cache:'no-store'})).json();
decisionBoard=createDecisionBoard({getState:()=>state,endpoint:authConfig.endpoint,onChange:()=>{renderTasks();renderPlanning();renderCalendar();}});
otpController=initialiseOtp({endpoint:authConfig.endpoint,onUnlocked:async(secret,sessionToken)=>{const attempt=++session;try{const response=await fetch('./state.enc',{cache:'no-store'});if(!response.ok)throw new Error('Cannot load your encrypted records.');const value=await unseal(await response.json(),secret);secret='';if(attempt!==session)return;if(value.format!=='daily-workbench-github'||value.version!==1||!value.tables)throw new Error('Unsupported workbench data.');state=value;store=state.tables.tasks.map(r=>JSON.parse(r.json));activity=Date.now();$('gate').hidden=true;$('workbench').hidden=false;render();await decisionBoard.start(sessionToken);}finally{secret='';}}});
await otpController.restore();
for(const id of ['search','project','sort'])$(id).addEventListener(id==='search'?'input':'change',renderTasks);
function render(){
 const day=today();$('today').textContent=fmt(day+'T12:00:00+08:00',{weekday:'long',day:'numeric',month:'long'});
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Hong_Kong',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
 $('greeting').textContent=hour>=18?'A gentle finish to your day.':'A little room for a good day.';
 $('encouragement').textContent=setting('daily-reads')?.encouragement||'One thing at a time. Your list will keep the rest.';
 $('updated').textContent='Last updated '+fmt(state.updatedAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+' HKT';
 $('project').innerHTML='<option value="">All work areas</option>'+PROJECTS.map(p=>'<option value="'+escape(p)+'">'+labels[p]+'</option>').join('');
 $('views').innerHTML=[['today','Today'],['all','All open'],['review','To review'],['waiting','Waiting'],['done','Completed'],['cancelled','Ignored']].map(([key,label])=>'<button data-view="'+key+'" class="'+(view===key?'active':'')+'">'+label+'</button>').join('');
 $('views').querySelectorAll('button').forEach(button=>button.onclick=()=>{view=button.dataset.view;$('views').querySelectorAll('button').forEach(b=>b.classList.toggle('active',b===button));renderTasks();});
 renderTasks();renderCalendar();renderReads();decisionBoard?.render();renderPlanning();
}
function reviewControls(t){
 if(t.status!=='review')return '';
 if(setting('meeting-proposals')?.[t.id])return '<p><a href="#decisions">Answer the calendar question above</a></p>';
 if(decisionBoard?.pending(t.id))return '<p class="queued">Saved · pending next scan</p>';
 return '<div class="decision-actions">'+[['accept',t.opportunity?'Pursue':'Accept'],['ignore','Ignore']].map(([choice,label])=>'<button data-decision="'+choice+'" data-kind="task" data-task="'+escape(t.id)+'" data-revision="'+t.revision+'">'+label+'</button>').join('')+'</div>';
}
function renderTasks(){if(!state)return;const day=today(),query=$('search').value.trim().toLowerCase(),project=$('project').value;
 let tasks=(decisionBoard?.snapshot()||state).tables.tasks.map(r=>JSON.parse(r.json)).filter(t=>!t.deletedAt).filter(t=>view==='today'?(t.status!=='review'&&isToday(t,day)):view==='all'?['todo','waiting'].includes(t.status):t.status===view);
 tasks=tasks.filter(t=>(!project||t.project===project)&&(!query||[t.title,t.notes,labels[t.project]].join(' ').toLowerCase().includes(query)));
 tasks.sort((a,b)=>{if($('sort').value==='title')return a.title.localeCompare(b.title);const d=(effectiveDueDate(a)||'9999').localeCompare(effectiveDueDate(b)||'9999');if($('sort').value==='deadline')return d;const weight=t=>(effectiveDueDate(t)&&effectiveDueDate(t)<=day?20:0)+(t.importance==='high'?8:0)+(t.priority==='high'?4:0);return weight(b)-weight(a)||d||a.title.localeCompare(b.title);});
 $('results').textContent=tasks.length+' '+(tasks.length===1?'record':'records');
 $('tasks').innerHTML=tasks.length?tasks.map(t=>{const due=effectiveDueDate(t),status={todo:'To do',waiting:'Waiting',review:'To review',done:'Completed',cancelled:'Ignored'}[t.status]||t.status;const dates=[['Planned',t.planDate],['Deadline',t.dueDate],['Internal deadline',t.internalDueDate],['External deadline',t.externalDueDate],['Follow up',t.followUpDate]].filter(([,date])=>date);return '<details class="task"><summary><div><div class="task-title">'+escape(t.title)+'</div><div class="task-meta"><span>'+escape(labels[t.project]||t.project)+'</span><span class="tag">'+status+'</span>'+(t.longTerm?'<span class="tag">Long-term work</span>':'')+(t.importance==='high'?'<span class="tag">Important</span>':'')+'</div></div><div class="due '+(due&&due<day&&!['done','cancelled'].includes(t.status)?'overdue':'')+'">'+(due?'Due '+escape(due):'No confirmed deadline')+'<br><span>View details ↓</span></div></summary><div class="task-body"><div class="dates">'+dates.map(([label,date])=>'<span>'+label+': '+escape(date)+'</span>').join('')+'</div>'+(t.notes?'<p>'+escape(t.notes)+'</p>':'')+(t.steps?.length?'<ul>'+t.steps.map(s=>'<li class="'+(s.done?'step-done':'')+'">'+(s.done?'✓ ':'')+escape(s.text)+'</li>').join('')+'</ul>':'')+(safeLink(t.link)?'<a rel="noopener noreferrer" target="_blank" href="'+escape(t.link)+'">Open source ↗</a>':'')+(!t.notes&&!t.steps?.length?'<p>No additional notes.</p>':'')+reviewControls(t)+(['todo','waiting'].includes(t.status)?'<button class="complete-button" data-decision="complete" data-kind="work" data-task="'+escape(t.id)+'" data-revision="'+t.revision+'"'+(decisionBoard?.pending(t.id)?' disabled':'')+'>'+ (decisionBoard?.pending(t.id)?'Saved · pending next scan':t.kind==='bill'?'Confirm paid':t.steps?.some(s=>!s.done)?'Mark task and all steps complete':'Mark completed')+'</button>':'')+'</div></details>';}).join(''):'<p class="empty">Nothing in this view. Try another filter.</p>';
}
function renderCalendar(){const calendar=setting('calendar');$('calendar').hidden=!calendar;if(!calendar)return;const day=today();calendarDay=calendarDay||day;$('calendar-status').textContent='Snapshot from '+fmt(calendar.checkedAt,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+' HKT';$('calendar-days').innerHTML=Array.from({length:7},(_,i)=>{const date=new Date(day+'T12:00:00+08:00');date.setUTCDate(date.getUTCDate()+i);const value=today(date);return '<button data-day="'+value+'" class="'+(value===calendarDay?'active':'')+'">'+fmt(date,{weekday:'short'})+'<strong>'+fmt(date,{day:'numeric'})+'</strong></button>';}).join('');$('calendar-days').querySelectorAll('button').forEach(b=>b.onclick=()=>{calendarDay=b.dataset.day;renderCalendar();});const start=Date.parse(calendarDay+'T00:00:00+08:00'),end=start+86400000;const events=visibleCalendarEvents(calendar).filter(e=>Date.parse(e.start)<end&&Date.parse(e.end)>start).sort((a,b)=>a.start.localeCompare(b.start));$('agenda').innerHTML=events.length?events.map(e=>'<div class="agenda-item"><time>'+(e.allDay?'All day':fmt(e.start,{hour:'2-digit',minute:'2-digit'})+'–'+fmt(e.end,{hour:'2-digit',minute:'2-digit'}))+'</time><div><strong>'+escape(e.title)+'</strong><p>'+escape(e.location||'')+'</p></div></div>').join(''):'<p class="empty">No events in this saved snapshot. Calendar availability has not been rechecked.</p>';}
function renderReads(){const reads=setting('daily-reads');$('reads').hidden=!reads?.articles?.length;if(!reads?.articles?.length)return;$('reads-day').textContent=reads.day;$('read-items').innerHTML=reads.articles.map(a=>'<article class="read-item"><small>'+escape(a.kind)+' · '+escape(a.source)+'</small><h3>'+(safeLink(a.url)?'<a rel="noopener noreferrer" target="_blank" href="'+escape(a.url)+'">'+escape(a.title)+' ↗</a>':escape(a.title))+'</h3><p>'+escape(a.summary)+'</p></article>').join('');}

function renderPlanning(){
 if(!state)return;const day=planningDay==='tomorrow'?addDays(today(),1):today();
 const plan=planHalfDays(decisionBoard?.snapshot()||state,{day});
 $('plan-status').textContent=plan.off?'Day off or vacation: no work suggested.':plan.calendarVerified?'Planned around the latest saved calendar events.':'Provisional plan: selected calendars have not been freshly verified.';
 $('half-day-plan').innerHTML=['morning','afternoon','evening'].map(part=>'<section class="plan-part"><h3>'+({morning:'Morning',afternoon:'Afternoon',evening:'Evening'}[part])+'</h3><small>'+plan.availableMinutes[part]+' estimated free minutes</small>'+plan.items.filter(x=>x.kind==='task'&&x.part===part).map(x=>'<div class="plan-item"><time>'+escape(x.start)+'–'+escape(x.end)+'</time>'+escape(x.title)+'<small> · '+x.minutes+' min'+(x.partial?' focus block':' estimate')+'</small></div>').join('')+(plan.items.some(x=>x.kind==='task'&&x.part===part)?'':'<p class="plan-note">No work block suggested.</p>')+'</section>').join('');
 $('plan-overflow').innerHTML=plan.unscheduled.length?'<details class="plan-note"><summary>Still on your list</summary>'+plan.unscheduled.map(x=>'<p>'+escape(x.title)+' · '+escape(x.reason)+'</p>').join('')+'</details>':'';
}
document.querySelectorAll('[data-plan-day]').forEach(button=>button.onclick=()=>{planningDay=button.dataset.planDay;document.querySelectorAll('[data-plan-day]').forEach(b=>b.classList.toggle('active',b===button));renderPlanning();});
