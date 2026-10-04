import assert from 'node:assert/strict';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import { chromium } from 'playwright';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let browser,page,context,child,serverUrl;
const errors=[];
before(async()=>{
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const temp=await mkdtemp(path.join(os.tmpdir(),'ezdes-review-test-'));
  child=spawn(process.env.EZDES_TEST_PYTHON||'python',['-u','-c',
    "import ezdes_server as e; s=e.ThreadingHTTPServer(('127.0.0.1',0),e.Handler); print(s.server_address[1],flush=True); s.serve_forever()"],
    {cwd:root,env:{...process.env,EZDES_PASSWORD:'',EZDES_STATE_DIR:path.join(temp,'state'),EZDES_DATA_DIR:path.join(temp,'data')}});
  child.stderr.on('data',()=>{});
  serverUrl=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Test server did not start')),10000);
    child.once('error',error=>{clearTimeout(timer);reject(error)});
    child.stdout.once('data',data=>{clearTimeout(timer);resolve('http://127.0.0.1:'+data.toString().trim())});
  });
});
after(async()=>{child?.kill();await browser?.close()});
beforeEach(async()=>{
  errors.length=0;
  context=await browser.newContext({viewport:{width:1440,height:1000}});
  page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://cdn.jsdelivr.net/**',route=>route.abort());
  await page.addInitScript(()=>{
    window.XLSX={utils:{sheet_to_json:sheet=>sheet.matrix,book_new:()=>({}),
      json_to_sheet:rows=>{window.exportedRows=rows;return rows},book_append_sheet:()=>{}},writeFile:()=>{}};
  });
  await page.goto(pathToFileURL(path.join(root,'copper-speed-organizer.html')).href);
});
afterEach(async()=>{await context.close();assert.deepEqual(errors,[],'No uncaught UI errors')});

const headers=['TN','N','WO','LYR','COPPERWEIGHT','SPEED','NUMBER OF CORES'];
const row=(weight='h/h',cores=12,wo='174-05-01')=>['1740','alpha',wo,'11/10',weight,80,cores];
async function load(matrix,name='production.xlsx'){
  await page.evaluate(({matrix,name})=>{
    state.file={name};state.workbook={Sheets:{Sheet1:{matrix}},SheetNames:['Sheet1']};state.sheetName='Sheet1';
    prepareSheet();
  },{matrix,name});
}
async function run(){await page.locator('#run').click();return page.locator('#status').innerText()}
async function observation(runId,actual='22'){
  for(const [id,value] of Object.entries({'learning-run-id':runId,'learning-tn':'1740','learning-weight':'2/2',
    'learning-planned-speed':'24','learning-actual-speed':actual,'learning-cores':'12'}))await page.locator('#'+id).fill(value);
  await page.locator('#learning-save').click();
  await page.waitForFunction(()=>!document.getElementById('learning-save').disabled&&document.getElementById('learning-form-status').textContent);
}

test('unfamiliar headers can be mapped; header row choice and duplicate names preserve data',async()=>{
  await load([['Worklist','October'],['Tool','Material','Rate','Work','Count'],['1740','2/2',24,'174-05-01',12]]);
  await page.locator('#header-select').selectOption('1');
  for(const [key,column] of Object.entries({copper:'Material',speed:'Rate',wo:'Work',tn:'Tool',cores:'Count'}))
    await page.locator('#map-'+key).selectOption(column);
  await page.locator('#apply-mapping').click();
  assert.match(await run(),/Scheduled 1 jobs/);
  await load([['TN','WO','Copperweight','Speed','Extra','Extra',''],['1740','174-05-01','h/h',80,'one','two','three']]);
  assert.deepEqual(await page.evaluate(()=>state.sourceRows[0]),{
    TN:'1740',WO:'174-05-01',Copperweight:'h/h',Speed:80,Extra:'one','Extra (2)':'two','Column 7':'three'});
});

test('workbook values cannot create executable attributes',async()=>{
  const malicious='100-01" onclick="window.reviewInjected=true"-99';
  await load([headers,row('h/h',12,malicious)]);
  assert.match(await run(),/Scheduled/);
  const attributes=await page.locator('#body tr[data-id]').evaluate(el=>({key:el.dataset.jobKey,onclick:el.getAttribute('onclick')}));
  assert.equal(attributes.key,'WO 100-01" onclick="window.reviewInjected=true"');
  assert.equal(attributes.onclick,null);
  await page.locator('#body tr[data-id]').click();
  assert.equal(await page.evaluate(()=>window.reviewInjected),undefined);
  assert.equal(await page.evaluate(()=>EZDES.escapeHtml('"\'<> &')),'&quot;&#39;&lt;&gt; &amp;');
});

test('fill shift rejects an oversized first job and includes setup in its limit',async()=>{
  await load([headers,row('4/4',24,'900-01-01')]);
  await page.evaluate(()=>{state.selectedDay='Friday';document.getElementById('fill-capacity').checked=true;
    document.getElementById('shift-hours').value='.25'});
  assert.match(await run(),/No complete WO jobs fit/);
  assert.equal(await page.evaluate(()=>state.rows.length),0);
  await load([headers,row('4/4',24,'900-01-01'),row('h/h',1,'901-01-01')]);
  await run();
  assert.deepEqual(await page.evaluate(()=>state.rows.map(r=>r.WO)),['901-01-01']);
  assert.ok(await page.evaluate(()=>plannedScheduleHours(state.rows,0)<=.25));
  await page.locator('#setup-minutes').fill('10');
  assert.equal(await page.evaluate(()=>state.rows.length),0);
});

test('invalid weight or timing rules block scheduling and clear stale results',async()=>{
  await load([headers,row()]);await run();
  await load([headers,row('9/h')]);
  assert.match(await run(),/Fix the errors/);
  assert.equal(await page.evaluate(()=>state.rows.length),0);
  assert.equal(await page.locator('#results-layout').isVisible(),false);
  await load([headers,row()]);
  await page.evaluate(()=>document.querySelector('.interval-seconds').value='-2');
  assert.match(await run(),/Fix the errors/);
});

test('all timing displays and exports use the same continuation and setup timeline',async()=>{
  await load([headers,row('h/h',12,'174-05-01'),row('h/h',12,'174-05-02')]);
  await page.locator('#setup-minutes').fill('5');await run();
  const lines=await page.evaluate(()=>scheduleTimeline().map(({duration,changeover,totalHours,start,finish})=>({duration,changeover,totalHours,start,finish})));
  assert.ok(lines[0].changeover>0);assert.equal(lines[1].changeover,0);
  assert.ok(lines[1].duration<lines[0].duration);
  assert.equal(await page.evaluate(()=>plannedScheduleHours(state.rows,5/60)),lines.reduce((sum,r)=>sum+r.totalHours,0));
  const displayed=await page.locator('#body tr[data-id] td.num.print-hide').allTextContents();
  assert.equal(Number(displayed[1]),Number(lines[0].totalHours.toFixed(2)));
  await page.locator('#download').click();
  const exported=await page.evaluate(()=>window.exportedRows);
  exported.forEach((entry,i)=>{assert.equal(entry['Scheduled line hours'],Number(lines[i].totalHours.toFixed(4)));
    assert.equal(entry.Start,lines[i].start);assert.equal(entry.Finish,lines[i].finish)});
  assert.ok(exported[1]['Standalone layer hours']>exported[1]['Core running hours']);
  await page.locator('#schedule-viewer-open').click();
  assert.match(await page.locator('#viewer-summary').innerText(),new RegExp(Math.round(lines.reduce((sum,r)=>sum+r.totalHours,0)*60)+' min'));
});

test('completion marks persist only for the same workbook and keyboard buttons do not double toggle',async()=>{
  const matrix=[headers,row('h/h',12,'174-05-01'),row('h/h',12,'174-05-02')];
  await load(matrix);await run();await page.locator('#schedule-viewer-open').click();
  await page.locator('.viewer-layer-check').first().click();
  assert.equal(await page.locator('.viewer-layer.is-complete').count(),1);
  await page.locator('#schedule-viewer-close').click();
  await load(matrix);await run();await page.locator('#schedule-viewer-open').click();
  assert.equal(await page.locator('.viewer-layer.is-complete').count(),1);
  await page.locator('#schedule-viewer-close').click();await page.reload();
  await load(matrix);await run();await page.locator('#schedule-viewer-open').click();
  assert.equal(await page.locator('.viewer-layer.is-complete').count(),1);
  await page.locator('.viewer-job-toggle').first().focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('.viewer-layer.is-complete').count(),2);
  await page.locator('.viewer-layer').first().focus();await page.keyboard.press('Space');
  assert.equal(await page.locator('.viewer-layer.is-complete').count(),1);
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('viewer-layer')),true);
  await page.locator('#schedule-viewer-close').click();
  await load([headers,row('h/h',4,'174-05-01'),row('h/h',4,'174-05-02')]);await run();
  await page.locator('#schedule-viewer-open').click();
  assert.equal(await page.locator('.viewer-layer.is-complete').count(),0);
});

test('local approval is atomic on storage failure and preserves other weights',async()=>{
  await page.evaluate(()=>EZDES.saveLocal({speedEntries:[{id:'other-weight',tn:'1740',copperweight:'1/1',adjustedSpeed:'44'}]}));
  await page.locator('#learning-open').click();
  for(let i=1;i<=3;i++){await observation('local-run-'+i);assert.match(await page.locator('#learning-form-status').innerText(),/saved/)}
  await observation('local-run-1');assert.match(await page.locator('#learning-form-status').innerText(),/already recorded/);
  await page.evaluate(()=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){
    if(key==='ezdes-local-data-v2')throw Error('Simulated storage failure');return window.originalSetItem.call(this,key,value)}});
  await page.locator('.learning-approve').click();
  assert.match(await page.locator('#learning-storage').innerText(),/Simulated storage failure/);
  assert.equal(await page.evaluate(()=>Object.keys(EZDES.readLocal().decisions).length),0);
  assert.equal(await page.evaluate(()=>EZDES.readLocal().speedEntries.length),1);
  await page.evaluate(()=>Storage.prototype.setItem=window.originalSetItem);
  await page.locator('.learning-approve').click();
  assert.match(await page.locator('#learning-storage').innerText(),/^Approved/);
  assert.equal(await page.evaluate(()=>EZDES.readLocal().speedEntries.length),2);
  assert.equal(await page.evaluate(()=>Object.values(EZDES.readLocal().decisions)[0].status),'approved');
  await page.locator('#learning-close').click();await page.reload();await page.locator('#learning-open').click();
  assert.match(await page.locator('#learning-summary').innerText(),/1 approved/);
});

test('scheduled targets are not prefilled as measured actual speeds',async()=>{
  await load([headers,row('2/2')]);await run();await page.locator('#learning-open').click();
  await page.locator('#learning-row').selectOption('0');
  assert.equal(await page.locator('#learning-planned-speed').inputValue(),'24');
  assert.equal(await page.locator('#learning-actual-speed').inputValue(),'');
  assert.equal(await page.locator('#learning-run-id').inputValue(),'');
  assert.equal(await page.evaluate(()=>EZDES.evidence([{tn:'1',copperweight:'2/2',actualSpeed:22,outcome:'good'}]).length),0);
});

test('completion save failure and damaged completion history are visible without false completion',async()=>{
  await load([headers,row()]);await run();await page.locator('#schedule-viewer-open').click();
  await page.evaluate(()=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){
    if(key==='ezdes-schedule-viewer-progress-v2')throw Error('Completion storage full');return window.originalSetItem.call(this,key,value)}});
  await page.locator('.viewer-layer-check').click();
  assert.equal(await page.locator('.viewer-layer.is-complete').count(),0);
  assert.match(await page.locator('#viewer-save-status').innerText(),/Not saved: Completion storage full/);
  await page.evaluate(()=>{Storage.prototype.setItem=window.originalSetItem;localStorage.setItem('ezdes-schedule-viewer-progress-v2','invalid JSON')});
  await page.locator('#schedule-viewer-close').click();await page.locator('#schedule-viewer-open').click();
  assert.match(await page.locator('#viewer-save-status').innerText(),/could not load/);
  assert.equal(await page.locator('.viewer-layer-check').count(),0);
});

test('a failed workbook import does not leave the previous schedule available',async()=>{
  await load([headers,row()]);await run();
  await page.evaluate(()=>{window.XLSX.read=()=>{throw Error('Unreadable workbook')};loadFile(new File(['bad'],'bad.xlsx'))});
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Unreadable workbook');
  assert.equal(await page.evaluate(()=>state.sourceRows.length),0);
  assert.equal(await page.locator('#results-layout').isVisible(),false);
  assert.equal(await page.locator('#download').isVisible(),false);
});

test('shared approval succeeds through the real API; failures never report approval or fall back locally',async()=>{
  await page.goto(serverUrl+'/copper-speed-organizer.html');
  await page.locator('#learning-open').click();
  for(let i=1;i<=3;i++){await observation('shared-run-'+i);assert.match(await page.locator('#learning-form-status').innerText(),/saved/)}
  await page.route('**/api/learning',async route=>{
    if(route.request().method()==='POST'&&route.request().postDataJSON()?.action==='approve')
      await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Simulated server failure'})});
    else await route.continue();
  });
  await page.locator('.learning-approve').click();
  await page.waitForFunction(()=>document.getElementById('learning-storage').textContent.includes('Simulated server failure'));
  assert.match(await page.locator('#learning-storage').innerText(),/Simulated server failure/);
  assert.equal(await page.evaluate(()=>localStorage.getItem('ezdes-local-data-v2')),null);
  await page.unroute('**/api/learning');await page.locator('.learning-approve').click();
  await page.waitForFunction(()=>document.getElementById('learning-storage').textContent.startsWith('Approved'));
  assert.match(await page.locator('#learning-storage').innerText(),/^Approved/);
  assert.equal((await (await page.request.get(serverUrl+'/api/speed-tracker')).json()).entries.length,1);
});

test('shared storage outage is visible and disables observation saves',async()=>{
  await page.goto(serverUrl+'/copper-speed-organizer.html');
  await page.route('**/api/learning',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"History unavailable"}'}));
  await page.locator('#learning-open').click();
  assert.equal(await page.locator('#learning-save').isDisabled(),true);
  assert.match(await page.locator('#learning-storage').innerText(),/History unavailable/);
  assert.equal(await page.evaluate(()=>localStorage.getItem('ezdes-local-data-v2')),null);
});
