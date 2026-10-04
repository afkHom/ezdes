/* Shared helpers used by the scheduler, viewer, and production learning. */
(()=>{
  'use strict';
  const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const normalized=value=>String(value??'').trim().toLowerCase();
  const trackerKey=entry=>JSON.stringify([normalized(entry.tn),normalized(entry.copperweight)]);
  const canonical=value=>JSON.stringify(value);
  function fingerprint(value){
    const text=canonical(value);let a=2166136261,b=5381;
    for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b,33)^text.charCodeAt(i)}
    return `${(a>>>0).toString(16)}-${(b>>>0).toString(16)}-${text.length}`;
  }
  function rowKey(row,rows){
    const value=fingerprint(row),index=rows.indexOf(row);
    const occurrence=rows.slice(0,Math.max(0,index)).filter(item=>fingerprint(item)===value).length;
    return `${value}:${occurrence}`;
  }
  function workbookKey(state){
    return fingerprint([state.file?.name||'workbook',state.sheetName,state.headers,state.sourceRows]);
  }
  function timeline(rows,{runningHours,needsChangeover,setupHours=0,start='07:00',timeAdd}){
    let elapsed=0;
    return rows.map((row,index)=>{
      const duration=runningHours(row,rows[index-1]);
      const changeover=needsChangeover(row,rows[index-1])?setupHours:0;
      const totalHours=duration+changeover,startHours=elapsed;
      if(!Number.isFinite(totalHours)||totalHours<0)throw new Error('Fix invalid weight or timing rules before scheduling.');
      elapsed+=totalHours;
      return {row,index,duration,changeover,totalHours,startHours,start:timeAdd(start,startHours),finish:timeAdd(start,elapsed)};
    });
  }
  const localKey='ezdes-local-data-v2';
  function readLocal(){
    const raw=localStorage.getItem(localKey);
    if(raw){const saved=JSON.parse(raw);if(!saved||!Array.isArray(saved.observations)||!Array.isArray(saved.speedEntries)||!saved.decisions||typeof saved.decisions!=='object'||Array.isArray(saved.decisions))throw new Error('Local production data is damaged. Restore a backup before saving.');return saved}
    const learning=JSON.parse(localStorage.getItem('ezdes-production-learning-v1')||'{}');
    const speedEntries=JSON.parse(localStorage.getItem('ezdes-speed-tracker')||'[]');
    if(!learning||typeof learning!=='object'||Array.isArray(learning))throw new Error('Legacy production history is damaged. Restore a backup before saving.');
    const observations=learning.observations??[],decisions=learning.decisions??{};
    if(!Array.isArray(observations)||!Array.isArray(speedEntries)||typeof decisions!=='object'||Array.isArray(decisions))throw new Error('Legacy production data is damaged. Restore a backup before saving.');
    return {version:2,observations,decisions,speedEntries};
  }
  function saveLocal(changes){
    const saved={...readLocal(),...changes,version:2};
    localStorage.setItem(localKey,JSON.stringify(saved));
    return saved;
  }
  function upsertTracker(entries,payload){
    const key=trackerKey(payload),existing=entries.find(item=>payload.id&&item.id===payload.id)||entries.find(item=>trackerKey(item)===key);
    const now=new Date().toISOString(),entry={...payload,id:existing?.id||globalThis.crypto?.randomUUID?.()||`local-${Date.now()}-${Math.random()}`,createdAt:existing?.createdAt||now,updatedAt:now};
    return [entry,...entries.filter(item=>item.id!==entry.id&&trackerKey(item)!==key)];
  }
  function evidence(observations){
    const unique=new Map();
    observations.forEach(item=>{
      if(!item.id||!item.runId||!['good','adjusted'].includes(item.outcome)||!Number.isFinite(Number(item.actualSpeed))||Number(item.actualSpeed)<=0)return;
      const key=JSON.stringify([normalized(item.tn),normalized(item.copperweight),normalized(item.runId)]);
      if(!unique.has(key))unique.set(key,item);
    });
    return [...unique.values()];
  }
  globalThis.EZDES={escapeHtml,normalized,trackerKey,fingerprint,rowKey,workbookKey,timeline,readLocal,saveLocal,upsertTracker,evidence};
})();
