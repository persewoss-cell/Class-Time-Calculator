/* 실습 시간 계산기 — 정적 클라이언트 전용 앱 (백엔드 없음, localStorage로 진행상황 보존) */

const STORAGE_KEY = 'ctc_state_v1';

/* ---------- time helpers ---------- */
function pad(n){ return String(n).padStart(2,'0'); }
function minutesToHM(totalMin){
  totalMin = Math.round(totalMin);
  const h = Math.floor(totalMin/60)%24;
  const m = totalMin%60;
  return `${pad(h)}:${pad(m)}`;
}
function hmToTodayMs(hm){
  const [h,m] = hm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
function msToClock(ms){
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtMin(min){
  const r = Math.round(min);
  return `${r}분`;
}
function fmtSigned(min){
  const r = Math.round(min);
  if (r === 0) return '±0분';
  return (r > 0 ? '+' : '') + r + '분';
}

/* ---------- excel parsing ---------- */
async function parseExcelFile(file){
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {type:'array', raw:true});
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:true, blankrows:false});

  let startHM = null;
  const tasks = [];

  for (let i = 1; i < rows.length; i++){
    const row = rows[i] || [];
    const rawName = row[0];
    if (rawName === undefined || rawName === null || String(rawName).trim() === '') continue;
    const name = String(rawName).trim();

    if (name === '시작시간'){
      const t = row[2];
      if (typeof t === 'number' && isFinite(t)){
        startHM = minutesToHM(t * 24 * 60);
      } else if (t instanceof Date){
        startHM = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
      } else if (typeof t === 'string' && /^\d{1,2}:\d{2}/.test(t)){
        startHM = t.slice(0,5);
      }
      continue;
    }

    const planned = Number(row[1]);
    if (!isFinite(planned) || planned <= 0) continue;
    tasks.push({ name, planned });
  }

  if (tasks.length === 0){
    throw new Error('실습 항목을 찾을 수 없어요. 엑셀 형식을 확인해주세요 (A열: 실습명, B열: 계획 시간(분)).');
  }
  return { tasks, startHM };
}

/* ---------- state ---------- */
function defaultState(){
  return {
    tasks: null,        // [{name, planned}]
    startHM: '13:30',
    targetHM: '17:10',
    hardEndHM: '17:30',
    phase: 'setup',      // setup -> ready -> running -> finished
    actualStartMs: null,
    log: [],             // [{name, planned, doneAtMs, durationMin}]
    currentIndex: 0
  };
}

let state = loadState();

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed);
  }catch(e){
    return defaultState();
  }
}
function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function resetAll(){
  if (!confirm('진행 상황을 모두 초기화할까요?')) return;
  localStorage.removeItem(STORAGE_KEY);
  state = defaultState();
  render();
}

/* ---------- recommendation engine ---------- */
// Returns { remaining: [{name, planned, recMin, recStartMs, recEndMs}], remainingBudgetMin, overtime }
function computeRecommendation(nowMs){
  const pending = state.tasks.slice(state.currentIndex);
  const targetMs = hmToTodayMs(state.targetHM);
  const remainingBudgetMinRaw = (targetMs - nowMs) / 60000;
  const plannedSum = pending.reduce((s,t)=>s+t.planned, 0);
  const overtime = remainingBudgetMinRaw <= 0;
  const budget = Math.max(remainingBudgetMinRaw, pending.length); // at least 1 min each if overtime

  let recMinutes;
  if (plannedSum <= 0){
    recMinutes = pending.map(()=>0);
  } else if (overtime){
    recMinutes = pending.map(()=>1);
  } else {
    // proportional scale, largest-remainder rounding to integer minutes summing to round(budget)
    const targetTotal = Math.max(Math.round(budget), pending.length);
    const raw = pending.map(t => t.planned / plannedSum * targetTotal);
    const floors = raw.map(Math.floor).map(v => Math.max(v,1));
    let used = floors.reduce((a,b)=>a+b,0);
    let remainder = targetTotal - used;
    const order = raw.map((v,i)=>({i, frac: v - Math.floor(v)}))
                      .sort((a,b)=>b.frac - a.frac);
    recMinutes = floors.slice();
    let k = 0;
    while (remainder > 0 && k < order.length){
      recMinutes[order[k].i] += 1;
      remainder--; k++;
    }
  }

  let cursor = nowMs;
  const remaining = pending.map((t,idx)=>{
    const recMin = recMinutes[idx];
    const recStartMs = cursor;
    const recEndMs = cursor + recMin*60000;
    cursor = recEndMs;
    return { ...t, recMin, recStartMs, recEndMs };
  });

  return { remaining, remainingBudgetMin: remainingBudgetMinRaw, overtime };
}

function cumulativeDelayMin(nowMs){
  if (state.actualStartMs == null) return 0;
  const plannedElapsed = state.log.reduce((s,l)=>s+l.planned, 0);
  const actualElapsed = (state.log.length
      ? state.log[state.log.length-1].doneAtMs
      : state.actualStartMs) - state.actualStartMs;
  return (actualElapsed/60000) - plannedElapsed;
}

/* ---------- rendering ---------- */
const app = document.getElementById('app');
let tickTimer = null;

function render(){
  if (tickTimer) clearInterval(tickTimer);
  if (state.phase === 'setup') return renderSetup();
  if (state.phase === 'ready') return renderReady();
  if (state.phase === 'running') { renderRunning(); tickTimer = setInterval(renderRunning, 1000); return; }
  if (state.phase === 'finished') return renderFinished();
}

function renderSetup(){
  app.innerHTML = `
    <div class="section">
      <h1>실습 시간 계산기</h1>
      <p class="desc">실습 목록 엑셀 파일을 올리면, 각 실습을 마칠 때마다 남은 실습들의 추천 시간이 자동으로 재계산돼요.</p>
      <div class="upload-box">
        <div>엑셀 파일 (.xlsx)을 선택하세요</div>
        <div style="font-size:12px;margin-top:4px;">A열: 실습명 · B열: 계획 시간(분)</div>
        <label class="upload-label">
          파일 선택
          <input type="file" id="fileInput" accept=".xlsx,.xls">
        </label>
      </div>
      <div id="errBox" style="color:#dc2626;font-size:13px;margin-top:12px;"></div>
    </div>
  `;
  document.getElementById('fileInput').addEventListener('change', async (e)=>{
    const file = e.target.files[0];
    if (!file) return;
    try{
      const { tasks, startHM } = await parseExcelFile(file);
      state = defaultState();
      state.tasks = tasks;
      if (startHM) state.startHM = startHM;
      const startMin = hmToMinutes(state.startHM);
      const plannedSum = tasks.reduce((s,t)=>s+t.planned,0);
      state.targetHM = minutesToHM(startMin + plannedSum);
      state.phase = 'ready';
      saveState();
      render();
    }catch(err){
      document.getElementById('errBox').textContent = err.message || String(err);
    }
  });
}

function hmToMinutes(hm){
  const [h,m] = hm.split(':').map(Number);
  return h*60+m;
}

function renderReady(){
  const plannedSum = state.tasks.reduce((s,t)=>s+t.planned,0);
  app.innerHTML = `
    <div class="section">
      <h1>실습 시간 계산기</h1>
      <p class="desc">${state.tasks.length}개 실습 · 계획 합계 ${fmtMin(plannedSum)}</p>
      <div class="card">
        <div class="field">
          <label>수업 시작 예정 시각</label>
          <input type="time" id="startInput" value="${state.startHM}">
        </div>
        <div class="field">
          <label>목표 종료 시각 (이 시각에 맞춰 시간 배분)</label>
          <input type="time" id="targetInput" value="${state.targetHM}">
        </div>
        <div class="field">
          <label>강의 최종 종료 시각 (참고용)</label>
          <input type="time" id="hardEndInput" value="${state.hardEndHM}">
        </div>
        <button class="btn btn-primary" id="startBtn">수업 시작</button>
      </div>
    </div>
    <footer class="actions">
      <button class="btn btn-ghost" id="reuploadBtn">다른 파일 업로드</button>
    </footer>
  `;
  document.getElementById('startInput').addEventListener('change', e=>{ state.startHM = e.target.value; saveState(); });
  document.getElementById('targetInput').addEventListener('change', e=>{ state.targetHM = e.target.value; saveState(); });
  document.getElementById('hardEndInput').addEventListener('change', e=>{ state.hardEndHM = e.target.value; saveState(); });
  document.getElementById('startBtn').addEventListener('click', ()=>{
    state.actualStartMs = Date.now();
    state.phase = 'running';
    saveState();
    render();
  });
  document.getElementById('reuploadBtn').addEventListener('click', ()=>{
    if (!confirm('현재 불러온 실습 목록을 버리고 새 파일을 업로드할까요?')) return;
    state = defaultState();
    saveState();
    render();
  });
}

function renderRunning(){
  const nowMs = Date.now();
  const { remaining, remainingBudgetMin, overtime } = computeRecommendation(nowMs);
  const delay = cumulativeDelayMin(nowMs);
  const targetMs = hmToTodayMs(state.targetHM);
  const untilTargetMin = (targetMs - nowMs)/60000;

  let badgeHtml;
  if (Math.abs(delay) < 0.5) badgeHtml = `<span class="badge even">정시 진행</span>`;
  else if (delay > 0) badgeHtml = `<span class="badge behind">${fmtMin(delay)} 지연</span>`;
  else badgeHtml = `<span class="badge ahead">${fmtMin(-delay)} 단축</span>`;

  const doneHtml = state.log.map(l => `
    <div class="task done">
      <div class="task-main">
        <div class="task-name"><span class="check">&#10003;</span> ${escapeHtml(l.name)}</div>
        <div class="task-meta">
          계획 ${fmtMin(l.planned)} → 실제 ${fmtMin(l.durationMin)}
          <span class="${l.durationMin>l.planned?'delta-down':'delta-up'}">${fmtSigned(l.durationMin-l.planned)}</span>
          · ${msToClock(l.doneAtMs)} 완료
        </div>
      </div>
    </div>
  `).join('');

  const pendingHtml = remaining.map((t, idx)=>{
    const isCurrent = idx === 0;
    const deltaMin = t.recMin - t.planned;
    const deltaCls = deltaMin > 0 ? 'delta-up' : (deltaMin < 0 ? 'delta-down' : '');
    return `
      <div class="task ${isCurrent ? 'current' : ''}">
        <div class="task-main">
          <div class="task-name">${escapeHtml(t.name)}</div>
          <div class="task-meta">
            계획 ${fmtMin(t.planned)}
            ${deltaMin !== 0 ? `<span class="${deltaCls}">(${fmtSigned(deltaMin)})</span>` : ''}
            · 추천 ${msToClock(t.recStartMs)}–${msToClock(t.recEndMs)}
          </div>
        </div>
        <div class="task-rec">${t.recMin}<small>분</small></div>
        ${isCurrent
          ? `<button class="done-btn" id="doneBtn">완료</button>`
          : `<button class="done-btn" disabled>대기</button>`}
      </div>
    `;
  }).join('');

  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-row">
        <div class="now-clock">${msToClock(nowMs)}</div>
        <button class="icon-btn" id="resetBtn">초기화</button>
      </div>
      <div class="stats">
        <div class="stat"><div class="label">목표 종료</div><div class="value">${state.targetHM}</div></div>
        <div class="stat"><div class="label">남은 시간</div><div class="value">${untilTargetMin>=0?fmtMin(untilTargetMin):'초과 '+fmtMin(-untilTargetMin)}</div></div>
        <div class="stat"><div class="label">진행 상태</div><div class="value">${badgeHtml}</div></div>
      </div>
    </div>
    ${overtime ? `<div class="warning-banner">목표 종료 시각을 초과했어요. 남은 실습을 최소 시간으로 서둘러 진행하세요.</div>` : ''}
    <div class="task-list">
      ${doneHtml}
      ${pendingHtml}
    </div>
  `;

  document.getElementById('resetBtn').addEventListener('click', resetAll);
  const doneBtn = document.getElementById('doneBtn');
  if (doneBtn){
    doneBtn.addEventListener('click', ()=>{
      const now = Date.now();
      const task = state.tasks[state.currentIndex];
      const prevMs = state.log.length ? state.log[state.log.length-1].doneAtMs : state.actualStartMs;
      const durationMin = (now - prevMs)/60000;
      state.log.push({ name: task.name, planned: task.planned, doneAtMs: now, durationMin });
      state.currentIndex++;
      if (state.currentIndex >= state.tasks.length){
        state.phase = 'finished';
      }
      saveState();
      render();
    });
  }
}

function renderFinished(){
  const totalPlanned = state.tasks.reduce((s,t)=>s+t.planned,0);
  const totalActual = state.log.reduce((s,l)=>s+l.durationMin,0);
  const diff = totalActual - totalPlanned;
  const endMs = state.log.length ? state.log[state.log.length-1].doneAtMs : state.actualStartMs;

  const rows = state.log.map(l => `
    <div class="summary-row">
      <span>${escapeHtml(l.name)}</span>
      <span>${fmtMin(l.planned)} → ${fmtMin(l.durationMin)} (${fmtSigned(l.durationMin-l.planned)})</span>
    </div>
  `).join('');

  app.innerHTML = `
    <div class="section">
      <h1>수업 완료</h1>
      <div class="card finish-card">
        <div class="label" style="color:var(--muted);font-size:13px;">종료 시각</div>
        <div class="big">${msToClock(endMs)}</div>
        <div style="color:${diff>0?'var(--behind)':'var(--ahead)'};font-weight:700;">
          목표(${state.targetHM}) 대비 ${fmtSigned(diff)}
        </div>
      </div>
      <div class="card" style="margin-top:12px;">
        ${rows}
      </div>
    </div>
    <footer class="actions">
      <button class="btn btn-primary" id="restartBtn">같은 목록으로 다시 진행</button>
      <button class="btn btn-danger-ghost" id="resetBtn2">전체 초기화 (새 파일)</button>
    </footer>
  `;
  document.getElementById('restartBtn').addEventListener('click', ()=>{
    state.phase = 'ready';
    state.actualStartMs = null;
    state.log = [];
    state.currentIndex = 0;
    saveState();
    render();
  });
  document.getElementById('resetBtn2').addEventListener('click', resetAll);
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

render();
