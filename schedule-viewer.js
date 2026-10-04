(()=>{
  'use strict';

  const byId=id=>document.getElementById(id);
  const esc=EZDES.escapeHtml;
  const progressStorageKey='ezdes-schedule-viewer-progress-v2';
  const buildLabel=document.querySelector('h1 .note');
  if(buildLabel)buildLabel.textContent='testing build v2026.09.19';

  const dialog=document.createElement('dialog');
  dialog.id='schedule-viewer';
  dialog.className='guide-dialog schedule-viewer-dialog';
  dialog.setAttribute('aria-labelledby','schedule-viewer-title');
  dialog.innerHTML=`
    <div class="guide-head">
      <div><h2 id="schedule-viewer-title">Interactive schedule viewer</h2><span class="internal">Top-to-bottom production run sheet</span></div>
      <button id="schedule-viewer-close" type="button">Close</button>
    </div>
    <div class="guide-content">
      <p class="note">Work down the arranged schedule. Mark one layer complete, or complete every layer in a WO job at once.</p>
      <div class="viewer-toolbar">
        <div><label for="viewer-search">Find TN, WO, weight, speed, or any workbook value</label><input id="viewer-search" type="search" placeholder="Search this schedule"></div>
        <div><label for="viewer-status">Show</label><select id="viewer-status"><option value="all">All scheduled work</option><option value="open">Not completed</option><option value="done">Completed</option></select></div>
        <button id="viewer-clear-progress" type="button">Clear completion marks</button>
      </div>
      <p id="viewer-save-status" class="note" aria-live="polite"></p><div id="viewer-summary" class="viewer-summary" aria-live="polite"></div>
      <div id="viewer-list" class="viewer-list" aria-label="Generated schedule run sheet"></div>
      <section id="viewer-details" class="viewer-details" aria-live="polite"><p class="note">Select a layer to inspect its workbook information.</p></section>
    </div>`;
  document.body.append(dialog);

  const openButton=document.createElement('button');
  openButton.id='schedule-viewer-open';
  openButton.type='button';
  openButton.textContent='Interactive schedule viewer';
  openButton.title='Open the top-to-bottom run sheet for the current arranged schedule';
  const downloadButton=byId('download');
  downloadButton.parentElement.insertBefore(openButton,downloadButton);

  const search=byId('viewer-search');
  const statusFilter=byId('viewer-status');
  const summary=byId('viewer-summary');
  const list=byId('viewer-list');
  const details=byId('viewer-details');
  let entries=[];
  let selectedIndex=null;

  function field(row,mappingKey){
    const header=state.mapping[mappingKey];
    return header?row[header]??'':'';
  }

  function scheduleKey(){return EZDES.workbookKey(state)}

  function allProgress(){const saved=JSON.parse(localStorage.getItem(progressStorageKey)||'{}');if(!saved||Array.isArray(saved)||typeof saved!=='object')throw Error('Saved completion history is damaged. Restore a backup before saving.');return saved}

  function readProgress(){
    return allProgress()[scheduleKey()]||{};
  }

  function writeProgress(progress){try{const saved=allProgress();saved[scheduleKey()]=progress;localStorage.setItem(progressStorageKey,JSON.stringify(saved));byId('viewer-save-status').textContent='Completion marks saved in this browser.';return true}catch(error){byId('viewer-save-status').textContent='Not saved: '+error.message;return false}}

  function layerKey(entry){return EZDES.rowKey(entry.row,state.sourceRows)}

  function makeEntries(){return scheduleTimeline().map(line=>{const {row,index}=line,entry={...line,job:jobKey(row),tn:field(row,'tn'),wo:field(row,'wo'),weight:field(row,'copper'),speed:field(row,'speed'),cores:field(row,'cores'),target:target(row),note:state.jobNotes[jobKey(row)]||''};entry.searchable=[entry.job,entry.tn,entry.wo,entry.weight,entry.speed,entry.target,...Object.values(row)].join(' ').toLowerCase();return entry})}

  function groupedEntries(){
    const groups=[];
    const byJob=new Map();
    entries.forEach(entry=>{
      let group=byJob.get(entry.job);
      if(!group){group={job:entry.job,entries:[]};byJob.set(entry.job,group);groups.push(group)}
      group.entries.push(entry);
    });
    return groups;
  }

  function hoursLabel(hours){
    const minutes=Math.round(hours*60);
    if(minutes<60)return `${minutes} min`;
    const whole=Math.floor(minutes/60),remaining=minutes%60;
    return remaining?`${whole}h ${remaining}m`:`${whole}h`;
  }

  function isDone(entry,progress=readProgress()){
    return Boolean(progress[layerKey(entry)]);
  }

  function groupIsDone(group,progress=readProgress()){
    return group.entries.length>0&&group.entries.every(entry=>isDone(entry,progress));
  }

  function setLayerDone(entry,done){
    const progress=readProgress();
    if(done)progress[layerKey(entry)]=true;else delete progress[layerKey(entry)];
    if(writeProgress(progress))renderViewer();
  }

  function setJobDone(group,done){
    const progress=readProgress();
    group.entries.forEach(entry=>{if(done)progress[layerKey(entry)]=true;else delete progress[layerKey(entry)]});
    if(writeProgress(progress))renderViewer();
  }

  function showDetails(index){
    selectedIndex=index;
    document.querySelectorAll('.viewer-layer').forEach(row=>row.classList.toggle('is-selected',Number(row.dataset.index)===index));
    const entry=entries[index];
    if(!entry){details.innerHTML='<p class="note">Select a layer to inspect its workbook information.</p>';return}
    const fields=state.headers.map(header=>`<div class="viewer-field"><b>${esc(header)}</b>${esc(entry.row[header]??'—')}</div>`).join('');
    details.innerHTML=`
      <div class="viewer-detail-actions"><div><h3>${esc(entry.job)} · layer ${index+1}</h3><div class="note">${esc(entry.start)} → ${esc(entry.finish)} · ${hoursLabel(entry.totalHours)}</div></div><button id="viewer-jump" type="button">Find in arranged data</button></div>
      <div class="viewer-fields">
        <div class="viewer-field"><b>Target speed</b>${esc(entry.target)}</div>
        <div class="viewer-field"><b>Core running time</b>${hoursLabel(entry.duration)}</div>
        <div class="viewer-field"><b>Changeover included</b>${entry.changeover?hoursLabel(entry.changeover):'None'}</div>
        ${fields}
      </div>
      ${entry.note?`<div class="viewer-note"><b>Job note</b><br>${esc(entry.note)}</div>`:''}`;
    byId('viewer-jump').onclick=()=>{
      const arrangedSearch=byId('schedule-search');
      arrangedSearch.value=entry.job;
      arrangedSearch.dispatchEvent(new Event('input',{bubbles:true}));
      dialog.close();
      byId('results').scrollIntoView({behavior:'smooth',block:'start'});
      arrangedSearch.focus();
    };
  }

  function renderViewer(){
    try{renderViewerContents()}catch(error){
      byId('viewer-save-status').textContent='Completion history could not load: '+error.message;
      list.innerHTML='<div class="viewer-empty">Restore completion history before making changes.</div>';
      summary.textContent='';
    }
  }

  function renderViewerContents(){
    entries=makeEntries();
    const progress=readProgress();
    const query=search.value.trim().toLowerCase();
    const filter=statusFilter.value;
    const groups=groupedEntries();
    const completed=entries.filter(entry=>isDone(entry,progress)).length;
    const totalHours=entries.reduce((total,entry)=>total+entry.totalHours,0);
    summary.innerHTML=`<span class="viewer-stat"><b>${groups.length}</b> WO job${groups.length===1?'':'s'}</span><span class="viewer-stat"><b>${entries.length}</b> layer${entries.length===1?'':'s'}</span><span class="viewer-stat viewer-stat-done"><b>${completed}</b> completed</span><span class="viewer-stat"><b>${entries.length-completed}</b> remaining</span><span class="viewer-stat"><b>${hoursLabel(totalHours)}</b> planned</span>`;

    if(!entries.length){
      list.innerHTML='<div class="viewer-empty">Run a schedule to create the interactive run sheet.</div>';
      showDetails(null);
      return;
    }

    const groupIndexByJob=new Map(groups.map((group,index)=>[group.job,index]));
    const visibleEntries=entries.filter(entry=>{
      const done=isDone(entry,progress);
      const matchesSearch=!query||entry.searchable.includes(query);
      const matchesStatus=filter==='all'||(filter==='done'&&done)||(filter==='open'&&!done);
      return matchesSearch&&matchesStatus;
    });

    list.innerHTML=visibleEntries.length?`<div class="viewer-flat">
      <div class="viewer-flat-head"><span>Done</span><span>Scheduled layer</span><span>Whole WO job</span></div>
      ${visibleEntries.map(entry=>{
        const layerDone=isDone(entry,progress);
        const groupIndex=groupIndexByJob.get(entry.job);
        const jobDone=groupIsDone(groups[groupIndex],progress);
        return `<div class="viewer-layer${layerDone?' is-complete':''}${selectedIndex===entry.index?' is-selected':''}" data-index="${entry.index}" tabindex="0">
          <button type="button" class="viewer-layer-check" data-index="${entry.index}" aria-pressed="${layerDone}" aria-label="${layerDone?'Reopen':'Complete'} layer ${entry.index+1}">${layerDone?'✓':'○'}</button>
          <button type="button" class="viewer-layer-main" data-index="${entry.index}">
            <span class="viewer-layer-number">${entry.index+1}</span>
            <span><b>${esc(entry.wo||entry.job)}</b><small>TN ${esc(entry.tn||'—')}</small></span>
            <span><b>${esc(entry.weight||'—')}</b><small>Copperweight</small></span>
            <span><b>${esc(entry.cores||'—')}</b><small>Cores</small></span>
            <span><b>${esc(entry.target||entry.speed||'—')}</b><small>Speed</small></span>
            <span><b>${esc(entry.start)} → ${esc(entry.finish)}</b><small>${hoursLabel(entry.totalHours)}${entry.changeover?' incl. changeover':''}</small></span>
          </button>
          <button type="button" class="viewer-job-toggle ${jobDone?'is-done':''}" data-group-index="${groupIndex}" aria-pressed="${jobDone}">${jobDone?'↶ Reopen WO':'✓ Complete WO'}</button>
        </div>`;
      }).join('')}
    </div>`:'<div class="viewer-empty">No schedule layers match the current search and completion filter.</div>';

    document.querySelectorAll('.viewer-job-toggle').forEach(button=>button.onclick=()=>{
      const group=groups[Number(button.dataset.groupIndex)];
      setJobDone(group,!groupIsDone(group));
    });
    document.querySelectorAll('.viewer-layer-check').forEach(button=>button.onclick=event=>{
      event.stopPropagation();
      const entry=entries[Number(button.dataset.index)];
      setLayerDone(entry,!isDone(entry));
    });
    document.querySelectorAll('.viewer-layer-main').forEach(button=>button.onclick=()=>showDetails(Number(button.dataset.index)));
    document.querySelectorAll('.viewer-layer').forEach(row=>row.onkeydown=event=>{
      if(event.target!==row||!['ArrowUp','ArrowDown','Home','End',' ','Enter'].includes(event.key))return;
      event.preventDefault();
      if(event.key===' '||event.key==='Enter'){
        const entry=entries[Number(row.dataset.index)];
        setLayerDone(entry,!isDone(entry));
        document.querySelector('.viewer-layer[data-index="'+entry.index+'"]')?.focus();
        return;
      }
      const rows=[...document.querySelectorAll('.viewer-layer')];
      const current=rows.indexOf(row);
      const next=event.key==='Home'?0:event.key==='End'?rows.length-1:Math.max(0,Math.min(rows.length-1,current+(event.key==='ArrowUp'?-1:1)));
      rows[next]?.focus();
      if(rows[next])showDetails(Number(rows[next].dataset.index));
    });
    if(selectedIndex!==null&&entries[selectedIndex])showDetails(selectedIndex);
  }

  openButton.onclick=()=>{
    renderViewer();
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
    search.focus();
  };
  byId('schedule-viewer-close').onclick=()=>dialog.close();
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close()});
  search.oninput=renderViewer;
  statusFilter.onchange=renderViewer;
  byId('viewer-clear-progress').onclick=()=>{
    if(!entries.length)return;
    if(!confirm('Clear all completion marks for this workbook schedule?'))return;
    if(!writeProgress({}))return;
    selectedIndex=null;
    renderViewer();
  };

  const resultsBody=byId('body');
  new MutationObserver(()=>{if(dialog.open)renderViewer()}).observe(resultsBody,{childList:true});

  const guide=byId('guide-content');
  if(guide){
    const section=document.createElement('details');
    section.innerHTML='<summary>Interactive schedule viewer</summary><div><ul><li>Select <b>Interactive schedule viewer</b> beside the schedule action buttons.</li><li>Layers remain in one continuous top-to-bottom list in the exact order shown in Arranged data; WO jobs are not separated into containers.</li><li>Select the circle beside a layer to complete or reopen just that layer. Select <b>Complete WO</b> on any line to update every matching layer in that WO job.</li><li>Completed work is crossed out and saved in this browser for the current workbook.</li><li>Use the search and completion filter to focus on remaining work. With a layer focused, use ↑/↓ to move and Space or Enter to toggle completion.</li><li>Select a layer for all workbook fields, timing details, changeover time, and the saved WO note.</li></ul></div>';
    const troubleshooting=[...guide.querySelectorAll('details')].find(item=>item.querySelector('summary')?.textContent.trim()==='Troubleshooting');
    guide.insertBefore(section,troubleshooting||null);
  }
})();
