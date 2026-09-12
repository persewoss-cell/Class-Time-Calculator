/* 실습 시간 계산기 — 정적 클라이언트 전용 앱 (백엔드/엑셀 없음, localStorage로 진행상황 보존) */

const STORAGE_KEY = 'ctc_state_v2';

/* ---------- time helpers ---------- */
function pad(n){ return String(n).padStart(2,'0'); }
function hmToTodayMs(hm){
  const [h,m] = (hm||'0:0').split(':').map(Number);
  const d = new Date();
  d.setHours(h||0, m||0, 0, 0);
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

/* ---------- state ---------- */
function defaultState(){
  return {
    tasks: [
      { name: '실습 1', planned: 15 },
      { name: '실습 2', planned: 15 },
      { name: '실습 3', planned: 15 }
    ],
    startHM: '13:30',
    targetHM: '17:10',
    hardEndHM: '17:30',
    phase: 'edit',        // edit -> running -> finished
    actualStartMs: null,
    log: [],               // [{name, planned, doneAtMs, durationMin}]
    currentIndex: 0,
    showSettings: false
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
  if (!confirm('모든 실습 목록과 진행 상황을 초기화할까요?')) return;
  localStorage.removeItem(STORAGE_KEY);
  state = defaultState();
  render();
}

/* ---------- recommendation engine ----------
   tasks: [{name, planned}] 를 anchorMs 시각부터 시작해 targetMs 시각에 맞춰
   계획(planned) 비율대로 분 단위 시간을 배분한다. */
function distribute(tasks, anchorMs, targetMs){
  const budgetRaw = (targetMs - anchorMs) / 60000;
  const plannedSum = tasks.reduce((s,t)=>s+t.planned, 0);
  const overtime = budgetRaw <= 0;
  let recMinutes;

  if (tasks.length === 0){
    recMinutes = [];
  } else if (plannedSum <= 0){
    recMinutes = tasks.map(()=>0);
  } else if (overtime){
    recMinutes = tasks.map(()=>1);
  } else {
    const targetTotal = Math.max(Math.round(budgetRaw), tasks.length);
    const raw = tasks.map(t => t.planned / plannedSum * targetTotal);
    const floors = raw.map(v => Math.max(Math.floor(v), 1));
    let used = floors.reduce((a,b)=>a+b,0);
    let remainder = targetTotal - used;
    const order = raw.map((v,i)=>({ i, frac: v - Math.floor(v) }))
                      .sort((a,b)=>b.frac - a.frac);
    recMinutes = floors.slice();
    let k = 0;
    while (remainder > 0 && k < order.length){
      recMinutes[order[k].i] += 1;
      remainder--; k++;
    }
  }

  let cursor = anchorMs;
  const items = tasks.map((t,idx)=>{
    const recMin = recMinutes[idx] || 0;
    const recStartMs = cursor;
    const recEndMs = cursor + recMin*60000;
    cursor = recEndMs;
    return { ...t, recMin, recStartMs, recEndMs };
  });

  return { items, remainingBudgetMin: budgetRaw, overtime };
}

function cumulativeDelayMin(nowMs){
  if (state.actualStartMs == null) return 0;
  const plannedElapsed = state.log.reduce((s,l)=>s+l.planned, 0);
  const actualElapsed = (state.log.length
      ? state.log[state.log.length-1].doneAtMs
      : nowMs) - state.actualStartMs;
  return (actualElapsed/60000) - plannedElapsed;
}

/* ---------- rendering ---------- */
const app = document.getElementById('app');
let tickTimer = null;

function render(){
  if (tickTimer) clearInterval(tickTimer);
  if (state.phase === 'running' && state.currentIndex >= state.tasks.length){
    state.phase = 'finished';
    saveState();
  }
  if (state.phase === 'edit') return renderEdit();
  if (state.phase === 'running') { renderRunning(); tickTimer = setInterval(renderRunning, 1000); return; }
  if (state.phase === 'finished') return renderFinished();
}

/* ---- edit phase: 엑셀 없이 표(행/열)를 직접 입력 ---- */
function renderEdit(){
  const preview = distribute(state.tasks, hmToTodayMs(state.startHM), hmToTodayMs(state.targetHM));
  const plannedSum = state.tasks.reduce((s,t)=>s+t.planned,0);

  const rowsHtml = state.tasks.map((t, idx)=>{
    const p = preview.items[idx];
    return `
      <div class="edit-row" data-idx="${idx}">
        <div class="edit-row-top">
          <input type="text" class="ename" data-idx="${idx}" value="${escapeAttr(t.name)}" placeholder="실습명">
          <button class="del-btn" data-idx="${idx}" aria-label="삭제">×</button>
        </div>
        <div class="edit-row-bottom">
          <div class="eplan">
            <input type="number" class="eplanned" data-idx="${idx}" value="${t.planned}" min="1" inputmode="numeric">
            <span>분</span>
          </div>
          <div class="epreview">추천 ${msToClock(p.recStartMs)}–${msToClock(p.recEndMs)}</div>
        </div>
      </div>
    `;
  }).join('');

  app.innerHTML = `
    <div class="section">
      <h1>실습 시간 계산기</h1>
      <p class="desc">실습명과 기준 시간(분)을 직접 입력하세요. 값을 바꿀 때마다 추천 시작~종료 시각이 자동으로 계산돼요.</p>

      <div class="card">
        <div class="field">
          <label>시작 시각</label>
          <div class="time-row">
            <input type="time" id="startInput" value="${state.startHM}">
            <button class="btn-mini" id="nowBtn">지금</button>
          </div>
        </div>
        <div class="field">
          <label>목표 종료 시각 (이 시각에 맞춰 비율 배분)</label>
          <input type="time" id="targetInput" value="${state.targetHM}">
        </div>
        <div class="field">
          <label>강의 최종 종료 시각 (참고용)</label>
          <input type="time" id="hardEndInput" value="${state.hardEndHM}">
        </div>
      </div>

      <div class="edit-list">
        ${rowsHtml}
      </div>
      <button class="btn add-row-btn" id="addRowBtn">+ 실습 추가</button>

      <p class="desc" style="margin-top:14px;">기준 시간 합계 ${fmtMin(plannedSum)}${preview.overtime ? ' · <span style="color:var(--behind);font-weight:700;">목표 종료 시각을 이미 넘겼어요</span>' : ''}</p>
      <div id="errBox" style="color:var(--behind);font-size:13px;"></div>
    </div>
    <footer class="actions">
      <button class="btn btn-primary" id="startBtn">수업 시작</button>
    </footer>
  `;

  document.getElementById('startInput').addEventListener('input', e=>{ state.startHM = e.target.value; saveState(); renderEdit(); });
  document.getElementById('targetInput').addEventListener('input', e=>{ state.targetHM = e.target.value; saveState(); renderEdit(); });
  document.getElementById('hardEndInput').addEventListener('input', e=>{ state.hardEndHM = e.target.value; saveState(); });
  document.getElementById('nowBtn').addEventListener('click', ()=>{
    state.startHM = msToClock(Date.now());
    saveState();
    renderEdit();
  });
  document.getElementById('addRowBtn').addEventListener('click', ()=>{
    state.tasks.push({ name: `실습 ${state.tasks.length+1}`, planned: 10 });
    saveState();
    renderEdit();
  });
  app.querySelectorAll('.ename').forEach(el=>{
    el.addEventListener('input', e=>{
      state.tasks[+e.target.dataset.idx].name = e.target.value;
      saveState();
    });
  });
  app.querySelectorAll('.eplanned').forEach(el=>{
    el.addEventListener('input', e=>{
      const v = Math.max(1, Number(e.target.value) || 1);
      state.tasks[+e.target.dataset.idx].planned = v;
      saveState();
      renderEdit();
    });
  });
  app.querySelectorAll('.del-btn').forEach(el=>{
    el.addEventListener('click', e=>{
      state.tasks.splice(+e.target.dataset.idx, 1);
      saveState();
      renderEdit();
    });
  });
  document.getElementById('startBtn').addEventListener('click', ()=>{
    const cleaned = state.tasks
      .map((t,i)=>({ name: (t.name||'').trim() || `실습 ${i+1}`, planned: Math.max(1, Number(t.planned)||0) }))
      .filter(t => t.planned > 0);
    if (cleaned.length === 0){
      document.getElementById('errBox').textContent = '실습을 1개 이상 추가해주세요.';
      return;
    }
    state.tasks = cleaned;
    const now = Date.now();
    state.startHM = msToClock(now);
    state.actualStartMs = now;
    state.log = [];
    state.currentIndex = 0;
    state.phase = 'running';
    saveState();
    render();
  });
}

/* ---- running phase ---- */
function renderRunning(){
  const nowMs = Date.now();
  const pending = state.tasks.slice(state.currentIndex);
  const { items, overtime } = distribute(pending, nowMs, hmToTodayMs(state.targetHM));
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

  const pendingHtml = items.map((t, idx)=>{
    const isCurrent = idx === 0;
    const deltaMin = t.recMin - t.planned;
    const deltaCls = deltaMin > 0 ? 'delta-up' : (deltaMin < 0 ? 'delta-down' : '');
    return `
      <div class="task ${isCurrent ? 'current' : ''}">
        <div class="task-main">
          <div class="task-name-row">
            <input type="text" class="pname" data-idx="${idx}" value="${escapeAttr(t.name)}">
            <button class="del-btn small" data-idx="${idx}" aria-label="삭제">×</button>
          </div>
          <div class="task-meta">
            기준
            <input type="number" class="pplanned" data-idx="${idx}" value="${t.planned}" min="1" inputmode="numeric">
            분
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

  const settingsHtml = state.showSettings ? `
    <div class="settings-panel">
      <div class="field">
        <label>시작 시각</label>
        <input type="time" id="startInputR" value="${state.startHM}">
      </div>
      <div class="field">
        <label>목표 종료 시각</label>
        <input type="time" id="targetInputR" value="${state.targetHM}">
      </div>
      <div class="field">
        <label>강의 최종 종료 시각 (참고용)</label>
        <input type="time" id="hardEndInputR" value="${state.hardEndHM}">
      </div>
    </div>
  ` : '';

  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-row">
        <div class="now-clock">${msToClock(nowMs)}</div>
        <div>
          <button class="icon-btn" id="settingsBtn">설정</button>
          <button class="icon-btn" id="resetBtn">초기화</button>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="label">목표 종료</div><div class="value">${state.targetHM}</div></div>
        <div class="stat"><div class="label">남은 시간</div><div class="value">${untilTargetMin>=0?fmtMin(untilTargetMin):'초과 '+fmtMin(-untilTargetMin)}</div></div>
        <div class="stat"><div class="label">진행 상태</div><div class="value">${badgeHtml}</div></div>
      </div>
      ${settingsHtml}
    </div>
    ${overtime ? `<div class="warning-banner">목표 종료 시각을 초과했어요. 남은 실습을 최소 시간으로 서둘러 진행하세요.</div>` : ''}
    <div class="task-list">
      ${doneHtml}
      ${pendingHtml}
    </div>
    <button class="btn add-row-btn add-row-btn-inline" id="addRowBtnR">+ 실습 추가</button>
  `;

  document.getElementById('resetBtn').addEventListener('click', resetAll);
  document.getElementById('settingsBtn').addEventListener('click', ()=>{
    state.showSettings = !state.showSettings;
    saveState();
    renderRunning();
  });
  if (state.showSettings){
    document.getElementById('startInputR').addEventListener('input', e=>{ state.startHM = e.target.value; saveState(); });
    document.getElementById('targetInputR').addEventListener('input', e=>{ state.targetHM = e.target.value; saveState(); renderRunning(); });
    document.getElementById('hardEndInputR').addEventListener('input', e=>{ state.hardEndHM = e.target.value; saveState(); });
  }
  document.getElementById('addRowBtnR').addEventListener('click', ()=>{
    state.tasks.push({ name: `실습 ${state.tasks.length+1}`, planned: 10 });
    saveState();
    renderRunning();
  });
  app.querySelectorAll('.pname').forEach(el=>{
    el.addEventListener('input', e=>{
      state.tasks[state.currentIndex + (+e.target.dataset.idx)].name = e.target.value;
      saveState();
    });
  });
  app.querySelectorAll('.pplanned').forEach(el=>{
    el.addEventListener('input', e=>{
      const v = Math.max(1, Number(e.target.value) || 1);
      state.tasks[state.currentIndex + (+e.target.dataset.idx)].planned = v;
      saveState();
      renderRunning();
    });
  });
  app.querySelectorAll('.del-btn.small').forEach(el=>{
    el.addEventListener('click', e=>{
      state.tasks.splice(state.currentIndex + (+e.target.dataset.idx), 1);
      saveState();
      render();
    });
  });
  const doneBtn = document.getElementById('doneBtn');
  if (doneBtn){
    doneBtn.addEventListener('click', ()=>{
      const now = Date.now();
      const task = state.tasks[state.currentIndex];
      const prevMs = state.log.length ? state.log[state.log.length-1].doneAtMs : state.actualStartMs;
      const durationMin = (now - prevMs)/60000;
      state.log.push({ name: task.name, planned: task.planned, doneAtMs: now, durationMin });
      state.currentIndex++;
      saveState();
      render();
    });
  }
}

/* ---- finished phase ---- */
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
      <button class="btn btn-ghost" id="editBtn">실습 목록 수정</button>
      <button class="btn btn-danger-ghost" id="resetBtn2">전체 초기화</button>
    </footer>
  `;
  document.getElementById('restartBtn').addEventListener('click', ()=>{
    state.phase = 'running';
    const now = Date.now();
    state.startHM = msToClock(now);
    state.actualStartMs = now;
    state.log = [];
    state.currentIndex = 0;
    saveState();
    render();
  });
  document.getElementById('editBtn').addEventListener('click', ()=>{
    state.phase = 'edit';
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
function escapeAttr(s){
  return escapeHtml(s);
}

render();
