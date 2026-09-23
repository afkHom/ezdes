(()=>{
  'use strict';

  const byId=id=>document.getElementById(id);
  const esc=value=>{const node=document.createElement('span');node.textContent=value??'';return node.innerHTML};
  const localKey='ezdes-production-learning-v1';
  const learning={observations:[],decisions:{},shared:false};
  const buildLabel=document.querySelector('h1 .note');
  if(buildLabel)buildLabel.textContent='local living-database test build';

  const launch=document.createElement('button');
  launch.id='learning-open';
  launch.className='guide-launch learning-launch';
  launch.type='button';
  launch.textContent='Production learning';
  launch.setAttribute('aria-haspopup','dialog');
  document.body.append(launch);

  const dialog=document.createElement('dialog');
  dialog.id='learning-center';
  dialog.className='guide-dialog learning-dialog';
  dialog.setAttribute('aria-labelledby','learning-title');
  dialog.innerHTML=`
    <div class="guide-head">
      <div><h2 id="learning-title">Production learning</h2><span class="internal">Evidence first · human approval required</span></div>
      <button id="learning-close" type="button">Close</button>
    </div>
    <div class="guide-content">
      <div class="learning-safety"><b>Safe by design:</b> observations never change the schedule automatically. EZDES waits for repeated, consistent results and a person must approve a recommendation before it is copied to the Special speed tracker.</div>
      <p id="learning-storage" class="tracker-status" aria-live="polite">Loading production history…</p>
      <div id="learning-summary" class="learning-summary"></div>

      <details open class="learning-section">
        <summary>Record a completed run</summary>
        <div>
          <label for="learning-row">Optional: fill from the current arranged schedule</label>
          <select id="learning-row"><option value="">Choose a scheduled layer</option></select>
          <div class="learning-form">
            <div><label for="learning-tn">Tool number *</label><input id="learning-tn" placeholder="Tool number"></div>
            <div><label for="learning-wo">WO group</label><input id="learning-wo" placeholder="Example: 174-05"></div>
            <div><label for="learning-weight">Copperweight *</label><input id="learning-weight" placeholder="Example: 2/2"></div>
            <div><label for="learning-planned-speed">Planned speed</label><input id="learning-planned-speed" type="number" step="0.1"></div>
            <div><label for="learning-actual-speed">Actual stable speed *</label><input id="learning-actual-speed" type="number" step="0.1"></div>
            <div><label for="learning-cores">Number of cores</label><input id="learning-cores" type="number" min="1" step="1"></div>
            <div><label for="learning-minutes">Actual minutes <span class="internal">optional</span></label><input id="learning-minutes" type="number" min="0" step="0.1"></div>
            <div><label for="learning-outcome">Run result *</label><select id="learning-outcome"><option value="good">Good — stable and usable</option><option value="adjusted">Adjusted — stable after a change</option><option value="problem">Problem — do not learn from this speed</option></select></div>
            <div class="wide"><label for="learning-notes">Notes</label><textarea id="learning-notes" rows="3" placeholder="Reason for adjustment, quality result, material detail, or anything the next operator should know"></textarea></div>
          </div>
          <div class="learning-actions"><button id="learning-save" class="primary" type="button">Record observation</button><button id="learning-clear" type="button">Clear form</button></div>
          <p id="learning-form-status" class="note" aria-live="polite"></p>
        </div>
      </details>

      <details open class="learning-section">
        <summary>Recommendations awaiting review</summary>
        <div>
          <p class="note">A speed recommendation requires at least three usable runs for the same tool number and copperweight. Problem runs are retained in history but excluded from the proposed speed.</p>
          <div id="learning-recommendations" class="learning-cards"></div>
        </div>
      </details>

      <details class="learning-section">
        <summary>Recorded history</summary>
        <div>
          <div class="learning-actions"><input id="learning-search" type="search" placeholder="Search tool, WO, weight, result, or notes"><button id="learning-refresh" type="button">Refresh</button><button id="learning-export" type="button">Export backup</button></div>
          <div class="table-wrap"><table class="learning-table"><thead><tr><th>Recorded</th><th>Tool</th><th>WO group</th><th>Weight</th><th>Planned</th><th>Actual</th><th>Cores</th><th>Minutes</th><th>Result</th><th>Notes</th><th></th></tr></thead><tbody id="learning-history"></tbody></table></div>
        </div>
      </details>
    </div>`;
  document.body.append(dialog);

  function localData(){
    try{
      const saved=JSON.parse(localStorage.getItem(localKey)||'{}');
      return {observations:Array.isArray(saved.observations)?saved.observations:[],decisions:saved.decisions&&typeof saved.decisions==='object'?saved.decisions:{}};
    }catch{return {observations:[],decisions:{}}}
  }

  function saveLocal(){
    localStorage.setItem(localKey,JSON.stringify({version:1,observations:learning.observations,decisions:learning.decisions}));
  }

  function setData(payload){
    learning.observations=Array.isArray(payload.observations)?payload.observations:[];
    learning.decisions=payload.decisions&&typeof payload.decisions==='object'?payload.decisions:{};
    renderAll();
  }

  function storageMessage(message,error=false){
    const element=byId('learning-storage');
    element.textContent=message;
    element.style.color=error?'#bd2020':'';
  }

  async function loadLearning(){
    storageMessage('Checking shared production history…');
    if(location.protocol!=='file:'){
      try{
        const response=await fetch('/api/learning',{cache:'no-store'});
        if(!response.ok)throw new Error('Shared history is unavailable.');
        const payload=await response.json();
        learning.shared=true;
        setData(payload);
        storageMessage('Shared server history — available to EZDES users connected to this server.');
        return;
      }catch{}
    }
    learning.shared=false;
    setData(localData());
    storageMessage(location.protocol==='file:'?'Browser-only test history — run EZDES through its server to share observations.':'Shared history unavailable — using this browser only.',location.protocol!=='file:');
  }

  function observationPayload(){
    return {
      action:'observation',
      tn:byId('learning-tn').value.trim(),
      woGroup:byId('learning-wo').value.trim(),
      copperweight:byId('learning-weight').value.trim(),
      plannedSpeed:byId('learning-planned-speed').value.trim(),
      actualSpeed:byId('learning-actual-speed').value.trim(),
      cores:byId('learning-cores').value.trim(),
      actualMinutes:byId('learning-minutes').value.trim(),
      outcome:byId('learning-outcome').value,
      notes:byId('learning-notes').value.trim(),
    };
  }

  function clearForm(){
    byId('learning-row').value='';
    ['learning-tn','learning-wo','learning-weight','learning-planned-speed','learning-actual-speed','learning-cores','learning-minutes','learning-notes'].forEach(id=>byId(id).value='');
    byId('learning-outcome').value='good';
    byId('learning-form-status').textContent='';
  }

  function validateObservation(payload){
    if(!payload.tn)return 'Enter a tool number.';
    if(!payload.copperweight)return 'Enter the copperweight.';
    if(!Number.isFinite(Number(payload.actualSpeed))||Number(payload.actualSpeed)<=0)return 'Enter a valid actual stable speed.';
    if(payload.plannedSpeed&&(!Number.isFinite(Number(payload.plannedSpeed))||Number(payload.plannedSpeed)<=0))return 'Enter a valid planned speed or leave it blank.';
    if(payload.actualMinutes&&(!Number.isFinite(Number(payload.actualMinutes))||Number(payload.actualMinutes)<0))return 'Enter valid actual minutes or leave it blank.';
    return '';
  }

  async function saveObservation(){
    const payload=observationPayload(),error=validateObservation(payload);
    if(error){byId('learning-form-status').textContent=error;return}
    try{
      if(learning.shared){
        const response=await fetch('/api/learning',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        const data=await response.json();
        if(!response.ok)throw new Error(data.error||'Could not save the observation.');
        setData(data);
      }else{
        const observation={...payload,id:crypto.randomUUID?.()||`${Date.now()}-${Math.random()}`,recordedAt:new Date().toISOString()};
        delete observation.action;
        learning.observations=[observation,...learning.observations];
        saveLocal();
        renderAll();
      }
      clearForm();
      byId('learning-form-status').textContent=learning.shared?'Observation saved to shared history.':'Observation saved in this browser.';
    }catch(error){byId('learning-form-status').textContent=error.message||'Could not save the observation.'}
  }

  function median(values){
    const sorted=values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    if(!sorted.length)return null;
    const middle=Math.floor(sorted.length/2);
    return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
  }

  function rounded(value){return Math.round(Number(value)*10)/10}
  function normalized(value){return String(value??'').trim().toLowerCase()}
  function recommendationKey(tn,weight,speed){return `${normalized(tn)}|${normalized(weight)}|${rounded(speed)}`}

  function analyses(){
    const groups=new Map();
    learning.observations.forEach(observation=>{
      const key=`${normalized(observation.tn)}|${normalized(observation.copperweight)}`;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(observation);
    });
    return [...groups.values()].map(items=>{
      const usable=items.filter(item=>item.outcome!=='problem'&&Number.isFinite(Number(item.actualSpeed)));
      const actual=usable.map(item=>Number(item.actualSpeed));
      const planned=usable.map(item=>Number(item.plannedSpeed)).filter(value=>Number.isFinite(value)&&value>0);
      const proposed=median(actual),baseline=median(planned),spread=actual.length?Math.max(...actual)-Math.min(...actual):null;
      const stable=actual.length>=3&&spread<=Math.max(4,(proposed||0)*.08);
      const changed=baseline===null||Math.abs(proposed-baseline)>=1;
      const key=proposed===null?'':recommendationKey(items[0].tn,items[0].copperweight,proposed);
      const decision=key?learning.decisions[key]?.status||'pending':'pending';
      const confidence=usable.length>=5&&spread<=2?'High':usable.length>=3&&stable?'Medium':'Collecting';
      return {items,usable,actual,planned,proposed,baseline,spread,stable,changed,key,decision,confidence,tn:items[0].tn,copperweight:items[0].copperweight,woGroup:items.find(item=>item.woGroup)?.woGroup||''};
    }).sort((a,b)=>String(a.tn).localeCompare(String(b.tn),undefined,{numeric:true,sensitivity:'base'})||String(a.copperweight).localeCompare(String(b.copperweight)));
  }

  function analysisStatus(item){
    if(item.usable.length<3)return {kind:'collecting',label:`Collecting — ${3-item.usable.length} more usable run${3-item.usable.length===1?'':'s'} needed`};
    if(!item.stable)return {kind:'hold',label:'Hold — recorded speeds are not consistent enough'};
    if(!item.changed)return {kind:'confirmed',label:'Current planned speed confirmed'};
    return {kind:item.decision,label:item.decision==='approved'?'Approved':item.decision==='rejected'?'Rejected':'Awaiting review'};
  }

  function renderRecommendations(){
    const rows=analyses();
    byId('learning-recommendations').innerHTML=rows.length?rows.map((item,index)=>{
      const status=analysisStatus(item),range=item.actual.length?`${Math.min(...item.actual)}–${Math.max(...item.actual)}`:'—';
      const recommendation=item.stable&&item.changed?`Use ${rounded(item.proposed)}`:item.proposed===null?'Not enough usable data':item.stable?`Keep ${rounded(item.baseline)}`:'Wait for consistent results';
      const actions=item.stable&&item.changed?`<div class="learning-card-actions">${item.decision!=='approved'?`<button type="button" class="learning-approve primary" data-analysis="${index}">Approve and add to tracker</button>`:''}${item.decision!=='rejected'?`<button type="button" class="learning-reject" data-analysis="${index}">Reject</button>`:''}${item.decision!=='pending'?`<button type="button" class="learning-reconsider" data-analysis="${index}">Reconsider</button>`:''}</div>`:'';
      return `<article class="learning-card ${esc(status.kind)}">
        <div class="learning-card-head"><div><h3>Tool ${esc(item.tn)} · ${esc(item.copperweight)}</h3><span class="learning-badge">${esc(status.label)}</span></div><strong>${esc(recommendation)}</strong></div>
        <div class="learning-evidence"><span><b>${item.usable.length}</b> usable runs</span><span><b>${esc(range)}</b> observed range</span><span><b>${item.baseline===null?'—':rounded(item.baseline)}</b> planned median</span><span><b>${esc(item.confidence)}</b> confidence</span></div>
        ${actions}
      </article>`;
    }).join(''):'<div class="viewer-empty">No production observations yet. Record completed runs to begin building evidence.</div>';
    document.querySelectorAll('.learning-approve').forEach(button=>button.onclick=()=>approveRecommendation(rows[Number(button.dataset.analysis)]));
    document.querySelectorAll('.learning-reject').forEach(button=>button.onclick=()=>saveDecision(rows[Number(button.dataset.analysis)],'rejected'));
    document.querySelectorAll('.learning-reconsider').forEach(button=>button.onclick=()=>saveDecision(rows[Number(button.dataset.analysis)],'pending'));
  }

  async function saveDecision(item,status){
    try{
      if(learning.shared){
        const response=await fetch('/api/learning',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'decision',key:item.key,status})});
        const data=await response.json();
        if(!response.ok)throw new Error(data.error||'Could not save the decision.');
        setData(data);
      }else{
        if(status==='pending')delete learning.decisions[item.key];else learning.decisions[item.key]={status,decidedAt:new Date().toISOString()};
        saveLocal();renderAll();
      }
    }catch(error){storageMessage(error.message||'Could not save the decision.',true)}
  }

  async function addRecommendationToTracker(item){
    await loadSpeedTracker();
    const trackerEntry={
      tn:String(item.tn),woGroup:String(item.woGroup||''),copperweight:String(item.copperweight),
      normalSpeed:item.baseline===null?'':String(rounded(item.baseline)),adjustedSpeed:String(rounded(item.proposed)),
      reason:'Approved production-learning recommendation',
      notes:`Approved from ${item.usable.length} usable runs. Observed range ${Math.min(...item.actual)}–${Math.max(...item.actual)}. The scheduler was not changed automatically.`
    };
    if(state.speedShared){
      const response=await fetch('/api/speed-tracker',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(trackerEntry)});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||'Could not add the recommendation to the shared speed tracker.');
      state.speedEntries=data.entries;
    }else{
      const toolKey=trackerEntry.tn.trim().toLowerCase(),now=new Date().toISOString();
      const existing=state.speedEntries.find(entry=>String(entry.tn||'').trim().toLowerCase()===toolKey);
      const saved={...trackerEntry,id:existing?.id||crypto.randomUUID?.()||`${Date.now()}-${Math.random()}`,createdAt:existing?.createdAt||now,updatedAt:now};
      state.speedEntries=[saved,...state.speedEntries.filter(entry=>String(entry.tn||'').trim().toLowerCase()!==toolKey)];
      saveLocalSpeedEntries();
    }
    renderSpeedTracker();
  }

  async function approveRecommendation(item){
    try{
      await addRecommendationToTracker(item);
      await saveDecision(item,'approved');
      storageMessage(`Approved tool ${item.tn} at speed ${rounded(item.proposed)} and copied it to the Special speed tracker. Scheduling rules remain unchanged.`);
    }catch(error){storageMessage(error.message||'Could not approve this recommendation.',true)}
  }

  function renderHistory(){
    const query=byId('learning-search').value.trim().toLowerCase();
    const rows=learning.observations.filter(item=>!query||Object.values(item).join(' ').toLowerCase().includes(query));
    byId('learning-history').innerHTML=rows.length?rows.map(item=>`<tr><td>${esc(item.recordedAt?new Date(item.recordedAt).toLocaleString():'')}</td><td><b>${esc(item.tn)}</b></td><td>${esc(item.woGroup)}</td><td>${esc(item.copperweight)}</td><td class="num">${esc(item.plannedSpeed||'—')}</td><td class="num"><b>${esc(item.actualSpeed)}</b></td><td class="num">${esc(item.cores||'—')}</td><td class="num">${esc(item.actualMinutes||'—')}</td><td><span class="learning-result ${esc(item.outcome)}">${esc(item.outcome)}</span></td><td class="tracker-note">${esc(item.notes)}</td><td><button type="button" class="learning-delete" data-id="${esc(item.id)}">Delete</button></td></tr>`).join(''):'<tr><td colspan="11">No matching observations.</td></tr>';
    document.querySelectorAll('.learning-delete').forEach(button=>button.onclick=()=>deleteObservation(button.dataset.id));
  }

  function renderSummary(){
    const all=analyses(),pending=all.filter(item=>item.stable&&item.changed&&item.decision==='pending').length,approved=all.filter(item=>item.decision==='approved').length;
    byId('learning-summary').innerHTML=`<span class="viewer-stat"><b>${learning.observations.length}</b> observations</span><span class="viewer-stat"><b>${all.length}</b> tool/weight combinations</span><span class="viewer-stat"><b>${pending}</b> awaiting review</span><span class="viewer-stat viewer-stat-done"><b>${approved}</b> approved</span>`;
  }

  function renderAll(){renderSummary();renderRecommendations();renderHistory()}

  async function deleteObservation(id){
    if(!confirm('Delete this production observation?'))return;
    try{
      if(learning.shared){
        const response=await fetch(`/api/learning?id=${encodeURIComponent(id)}`,{method:'DELETE'}),data=await response.json();
        if(!response.ok)throw new Error(data.error||'Could not delete the observation.');
        setData(data);
      }else{
        learning.observations=learning.observations.filter(item=>item.id!==id);saveLocal();renderAll();
      }
    }catch(error){storageMessage(error.message||'Could not delete the observation.',true)}
  }

  function mapped(row,key){const header=state.mapping[key];return header?row[header]??'':''}
  function populateScheduleRows(){
    const select=byId('learning-row');
    select.innerHTML='<option value="">Choose a scheduled layer</option>'+state.rows.map((row,index)=>`<option value="${index}">#${index+1} · WO ${esc(mapped(row,'wo')||jobKey(row))} · Tool ${esc(mapped(row,'tn')||'—')} · ${esc(mapped(row,'copper')||'—')}</option>`).join('');
  }

  function fillFromSchedule(){
    const index=Number(byId('learning-row').value);
    if(!Number.isInteger(index)||!state.rows[index])return;
    const row=state.rows[index];
    byId('learning-tn').value=mapped(row,'tn');
    byId('learning-wo').value=String(jobKey(row)).replace(/^WO\s+/i,'');
    byId('learning-weight').value=mapped(row,'copper');
    byId('learning-planned-speed').value=target(row);
    byId('learning-actual-speed').value=target(row);
    byId('learning-cores').value=mapped(row,'cores');
  }

  function exportBackup(){
    const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),observations:learning.observations,decisions:learning.decisions},null,2)],{type:'application/json'}),link=document.createElement('a');
    link.href=URL.createObjectURL(blob);link.download='ezdes-production-learning-backup.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  }

  launch.onclick=async()=>{
    populateScheduleRows();
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
    await loadLearning();
    byId('learning-row').focus();
  };
  byId('learning-close').onclick=()=>dialog.close();
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close()});
  byId('learning-row').onchange=fillFromSchedule;
  byId('learning-save').onclick=saveObservation;
  byId('learning-clear').onclick=clearForm;
  byId('learning-refresh').onclick=loadLearning;
  byId('learning-search').oninput=renderHistory;
  byId('learning-export').onclick=exportBackup;

  const guide=byId('guide-content');
  if(guide){
    const section=document.createElement('details');
    section.innerHTML='<summary>Production learning and recommendations</summary><div><ul><li>Record the actual stable speed after a completed run. Actual minutes are optional so the system does not depend on burdensome time studies.</li><li>Recommendations are separated by tool number and copperweight and require at least three usable, reasonably consistent runs.</li><li>Runs marked Problem remain in history but are excluded from the proposed speed.</li><li>Nothing changes scheduling automatically. Approving a recommendation only copies it to the Special speed tracker; rejecting it records the decision.</li><li>Server mode shares the history through the existing persistent state folder. Direct HTML mode stores it only in the current browser.</li><li>Use Export backup to keep an independent JSON copy of observations and decisions.</li></ul></div>';
    const troubleshooting=[...guide.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent.trim()==='Troubleshooting');
    guide.insertBefore(section,troubleshooting||null);
  }
})();
