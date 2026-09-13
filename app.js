/* 실습 시간 계산기 — 정적 클라이언트 전용 앱 (백엔드/엑셀 없음, localStorage로 진행상황 보존) */

const STORAGE_KEY = 'ctc_state_v5';

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
// "HH:MM"을 refMs 시각과 같은 날짜로 해석했을 때 이미 지난 시각이면(예: 21시에
// 시작해서 새벽 1시에 끝나는 경우) 다음 날로 넘겨서 절대 시각(ms)을 계산한다.
// 자정을 넘기는 일정을 "당일"로 잘못 계산해 수백 분씩 마이너스가 나던 버그의 원인이었다.
function resolveTimeOnOrAfter(hm, refMs){
  const [h, m] = (hm||'0:0').split(':').map(Number);
  const d = new Date(refMs);
  d.setHours(h||0, m||0, 0, 0);
  if (d.getTime() < refMs) d.setDate(d.getDate()+1);
  return d.getTime();
}
// ms 시각을 "HH:MM"으로 표시하되, 기준 시각(baseMs)과 날짜가 다르면(자정을 넘겼으면)
// "(+1일)"처럼 며칠 뒤인지 붙여서 헷갈리지 않게 한다.
function formatClockRel(ms, baseMs){
  const clock = msToClock(ms);
  if (baseMs == null) return clock;
  const a = new Date(baseMs), b = new Date(ms);
  const dayDiff = Math.round((Date.UTC(b.getFullYear(),b.getMonth(),b.getDate()) - Date.UTC(a.getFullYear(),a.getMonth(),a.getDate())) / 86400000);
  return dayDiff > 0 ? `${clock}(+${dayDiff}일)` : clock;
}

/* ---------- state ---------- */
function defaultState(){
  return {
    tasks: [
      { name: '이론', planned: 20 },
      { name: 'STEP1', planned: 15 },
      { name: 'STEP2', planned: 15 },
      { name: 'STEP3', planned: 15 },
      { name: 'STEP4(방향)', planned: 15 },
      { name: 'STEP4(시수)', planned: 20 },
      { name: '전단계', planned: 20 },
      { name: '내용체계', planned: 20 },
      { name: '핵심아이디어', planned: 20 },
      { name: '성취기준', planned: 15 },
      { name: '필요성/목표', planned: 15 },
      { name: '단원지도계획', planned: 15 },
      { name: '평가계획', planned: 15 }
    ],
    startHM: '13:30',
    targetMs: null,         // 목표 종료 시각(절대 ms). 수업 시작 시 확정되어 자정을 넘겨도 정확하다.
    // 실제 강의 종료 시각은 "N시간 M분 뒤"(hardEndH/M) 또는 "몇 시 몇 분"(hardEndAbsH/M)
    // 둘 중 한 가지 방법으로만 입력한다. 전부 빈 문자열이면 미설정 상태.
    hardEndH: '',
    hardEndM: '',
    hardEndAbsH: '',
    hardEndAbsM: '',
    phase: 'edit',        // edit -> running -> finished
    actualStartMs: null,
    log: [],               // [{name, planned, doneAtMs, durationMin}]
    currentIndex: 0,
    showSettings: false,
    away: false            // true면 진행 중이어도 첫화면(상태 박스)에 머무른다
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

// 실제 강의 종료 시각은 "N시간 M분 뒤"(hardEndH/M) 또는 "몇 시 몇 분"(hardEndAbsH/M)
// 둘 중 하나로만 정할 수 있다. 한쪽 방법의 칸이 하나만 채워졌거나, 두 방법이
// 동시에 채워졌으면 에러를 반환하고, 둘 다 비어있으면 미설정(ms:null)으로 둔다.
function computeHardEndInfo(anchorMs){
  const durH = state.hardEndH, durM = state.hardEndM;
  const absH = state.hardEndAbsH, absM = state.hardEndAbsM;
  const durEngaged = durH !== '' || durM !== '';
  const durComplete = durH !== '' && durM !== '';
  const absEngaged = absH !== '' || absM !== '';
  const absComplete = absH !== '' && absM !== '';

  if (durEngaged && absEngaged){
    return { ms: null, error: '"N시간 M분 뒤"와 "몇 시 몇 분" 중 하나만 입력해주세요.' };
  }
  if (durEngaged && !durComplete){
    return { ms: null, error: '시간과 분을 모두 입력해주세요.' };
  }
  if (absEngaged && !absComplete){
    return { ms: null, error: '시와 분을 모두 입력해주세요.' };
  }
  if (durComplete){
    return { ms: anchorMs + (Number(durH)*60 + Number(durM))*60000 };
  }
  if (absComplete){
    return { ms: resolveTimeOnOrAfter(`${absH}:${absM}`, anchorMs) };
  }
  return { ms: null };
}

function cumulativeDelayMin(){
  // 완료된 실습만으로 계산한다. 진행 중인(아직 완료 버튼을 안 누른) 실습에
  // 흐르고 있는 시간은 완료 시점 전까지는 지연/단축에 반영하지 않는다.
  if (state.log.length === 0) return 0;
  const plannedElapsed = state.log.reduce((s,l)=>s+l.planned, 0);
  const actualElapsed = state.log[state.log.length-1].doneAtMs - state.actualStartMs;
  return (actualElapsed/60000) - plannedElapsed;
}

/* ---------- rendering ---------- */
const app = document.getElementById('app');
let tickTimer = null;

// 화면을 다시 그리면 입력 중이던 필드(DOM)가 새로 만들어져 포커스가 풀리고
// 모바일 숫자 키패드가 닫혀버린다. 다시 그리기 전 포커스/커서 위치를 기억해뒀다가
// 같은 id(또는 같은 클래스+data-idx) 요소에 그대로 복원해 키패드가 열려있게 한다.
// restoringFocus는 이 복원용 focus()인지(그대로 이어 입력) 사용자가 직접 탭한
// focus인지(전체 선택해서 새로 입력) 구분하는 데 쓰인다.
let restoringFocus = false;
function rerenderKeepingFocus(renderFn){
  const active = document.activeElement;
  let restore = null;
  if (active && app.contains(active) && active.tagName === 'INPUT'){
    let selStart = null, selEnd = null;
    try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch(e){}
    restore = {
      id: active.id || null,
      cls: active.className ? active.className.trim().split(/\s+/)[0] : null,
      idx: active.dataset ? active.dataset.idx : undefined,
      selStart, selEnd
    };
  }
  renderFn();
  if (restore){
    const el = restore.id
      ? document.getElementById(restore.id)
      : (restore.cls && restore.idx !== undefined ? app.querySelector(`.${restore.cls}[data-idx="${restore.idx}"]`) : null);
    if (el){
      restoringFocus = true;
      el.focus();
      restoringFocus = false;
      if (restore.selStart != null && el.setSelectionRange){
        try { el.setSelectionRange(restore.selStart, restore.selEnd); } catch(e){}
      }
    }
  }
}

// 시/분 칸을 새로 탭했을 때는 기존 숫자를 전체 선택해서, 이어서 입력하는 게 아니라
// 새로 친 숫자로 통째로 바뀌게 한다. 다시 그리기용 focus() 복원 때는 select하지 않는다.
function selectAllOnFreshFocus(el){
  el.addEventListener('focus', ()=>{
    if (!restoringFocus) el.select();
  });
}

// 숫자 입력칸: 타이핑 중(빈 값 등 중간 상태)에는 값을 강제로 고치지 않고 그대로 두어
// 여러 자리를 이어서 입력하거나 지우고 다시 쓸 수 있게 하고, 포커스를 벗어날 때만
// 최소/최대 범위로 정리한다.
function bindNumberInput(el, { min = 0, max = Infinity, fallback = min, onChange, rerenderFn }){
  el.addEventListener('input', e=>{
    const raw = e.target.value;
    if (raw === '' || !/^\d+$/.test(raw)) return;
    onChange(Math.min(max, Math.max(min, Number(raw))));
    saveState();
    rerenderKeepingFocus(rerenderFn);
  });
  el.addEventListener('blur', e=>{
    const raw = e.target.value;
    const v = (raw === '' || !/^\d+$/.test(raw)) ? fallback : Math.min(max, Math.max(min, Number(raw)));
    onChange(v);
    saveState();
    rerenderFn();
  });
  el.addEventListener('keydown', e=>{
    if (e.key === 'Enter'){ e.preventDefault(); e.target.blur(); }
  });
}

// bindNumberInput과 달리 빈 값을 그대로 허용한다("입력 안 함" 자체가 유효한 상태).
// 실제 강의 종료 시각의 두 입력 방법(시간/분 뒤, 몇 시 몇 분)처럼 값이 없어도
// 되는 칸에 쓴다.
function bindOptionalNumberInput(el, { max = Infinity, onChange, rerenderFn }){
  const clamp = raw => (raw === '' || !/^\d+$/.test(raw)) ? '' : Math.min(max, Number(raw));
  el.addEventListener('input', e=>{
    const raw = e.target.value;
    if (raw !== '' && !/^\d+$/.test(raw)) return;
    onChange(clamp(raw));
    saveState();
    rerenderKeepingFocus(rerenderFn);
  });
  el.addEventListener('blur', e=>{
    onChange(clamp(e.target.value));
    saveState();
    rerenderFn();
  });
  el.addEventListener('keydown', e=>{
    if (e.key === 'Enter'){ e.preventDefault(); e.target.blur(); }
  });
}

function render(){
  if (tickTimer) clearInterval(tickTimer);
  if (state.phase === 'running' && state.currentIndex >= state.tasks.length){
    state.phase = 'finished';
    saveState();
  }
  if (state.away && state.phase !== 'edit') return renderHome();
  if (state.phase === 'edit') return renderEdit();
  if (state.phase === 'running') { renderRunning(); tickTimer = setInterval(renderRunning, 1000); return; }
  if (state.phase === 'finished') return renderFinished();
}

/* ---- home: 진행 중인 수업이 있을 때 나가기를 누르면 여기로 온다 ---- */
function renderHome(){
  const isFinished = state.phase === 'finished';
  const current = isFinished ? null : state.tasks[state.currentIndex];
  const doneCount = state.log.length;
  const total = state.tasks.length;

  app.innerHTML = `
    <div class="section">
      <h1>강의 시간 계산기</h1>
      <div class="session-box">
        <button class="session-box-body" id="resumeBox">
          <div class="session-box-title">${isFinished ? '수업이 완료됐어요' : `진행 중 · ${escapeHtml(current.name)}`}</div>
          <div class="session-box-sub">${doneCount}/${total} 완료 · 눌러서 ${isFinished ? '결과 보기' : '이어하기'}</div>
        </button>
        <button class="session-trash" id="trashBtn" aria-label="진행 중인 수업 삭제">&#128465;</button>
      </div>
    </div>
  `;

  document.getElementById('resumeBox').addEventListener('click', ()=>{
    state.away = false;
    saveState();
    render();
  });
  document.getElementById('trashBtn').addEventListener('click', ()=>{
    if (!confirm('진행 중인 수업 기록을 삭제할까요? 되돌릴 수 없어요.')) return;
    localStorage.removeItem(STORAGE_KEY);
    state = defaultState();
    render();
  });
}

/* ---- edit phase: 엑셀 없이 표(행/열)를 직접 입력 ---- */
function renderEdit(){
  const plannedSum = state.tasks.reduce((s,t)=>s+t.planned,0);
  // 시작 시각을 오늘 날짜에 얹어 가상의 기준 시각으로 삼는다. 목표/최종 종료는 여기에
  // 분 단위를 그대로 "더하기"만 해서 구하므로(문자열로 바꿨다가 다시 파싱하지 않음)
  // 자정을 넘기는 일정(예: 21시 시작 → 다음날 01시 종료)도 날짜가 저절로 넘어간다.
  const plannedAnchorMs = hmToTodayMs(state.startHM);
  const previewTargetMs = plannedAnchorMs + plannedSum*60000;
  const hardEndInfo = computeHardEndInfo(plannedAnchorMs);
  const preview = distribute(state.tasks, plannedAnchorMs, previewTargetMs);

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
            <input type="text" class="eplanned" data-idx="${idx}" value="${t.planned}" inputmode="numeric" pattern="[0-9]*">
            <span>분</span>
          </div>
          <div class="epreview">계획 ${formatClockRel(p.recStartMs, plannedAnchorMs)}–${formatClockRel(p.recEndMs, plannedAnchorMs)}</div>
        </div>
      </div>
    `;
  }).join('');

  app.innerHTML = `
    <div class="section">
      <h1>강의 시간 계산기</h1>

      <div class="card">
        <div class="field">
          <label>시작 시각</label>
          <div class="time-row">
            <input type="time" id="startInput" value="${state.startHM}">
            <button class="btn-mini" id="nowBtn">지금</button>
          </div>
        </div>
        <div class="field">
          <label>강의 계획 시간의 총합계 시각</label>
          <div class="computed-value">${formatClockRel(previewTargetMs, plannedAnchorMs)}</div>
        </div>
        <div class="field">
          <label>실제 강의 종료 시각</label>
          <div class="duration-row">
            <input type="text" class="duration-input duration-h" id="hardEndHInput" value="${state.hardEndH}" placeholder="0" inputmode="numeric" pattern="[0-9]*"><span>시간</span>
            <input type="text" class="duration-input duration-m" id="hardEndMInput" value="${state.hardEndM}" placeholder="0" inputmode="numeric" pattern="[0-9]*"><span>분</span>
            <span class="duration-arrow">뒤</span>
          </div>
          <div class="duration-or">또는</div>
          <div class="duration-row">
            <input type="text" class="duration-input duration-h" id="hardEndAbsHInput" value="${state.hardEndAbsH}" placeholder="0" inputmode="numeric" pattern="[0-9]*"><span>시</span>
            <input type="text" class="duration-input duration-m" id="hardEndAbsMInput" value="${state.hardEndAbsM}" placeholder="0" inputmode="numeric" pattern="[0-9]*"><span>분</span>
          </div>
          ${hardEndInfo.error
            ? `<div class="computed-value" style="margin-top:6px;color:var(--behind);">${hardEndInfo.error}</div>`
            : hardEndInfo.ms != null
              ? `<div class="computed-value" style="margin-top:6px;">${formatClockRel(hardEndInfo.ms, plannedAnchorMs)}(${fmtSigned((previewTargetMs-hardEndInfo.ms)/60000)})</div>`
              : ''}
        </div>
      </div>

      <div class="edit-list">
        ${rowsHtml}
      </div>
      <button class="btn add-row-btn" id="addRowBtn">+ 강의 계획 시간 추가</button>

      <p class="desc" style="margin-top:14px;">강의 계획 시간 합계(${fmtMin(plannedSum)})</p>
      <div id="errBox" style="color:var(--behind);font-size:13px;"></div>
    </div>
    <footer class="actions">
      <button class="btn btn-primary" id="startBtn">수업 시작</button>
    </footer>
  `;

  document.getElementById('startInput').addEventListener('input', e=>{ state.startHM = e.target.value; saveState(); renderEdit(); });
  const hardEndHInput = document.getElementById('hardEndHInput');
  const hardEndMInput = document.getElementById('hardEndMInput');
  const hardEndAbsHInput = document.getElementById('hardEndAbsHInput');
  const hardEndAbsMInput = document.getElementById('hardEndAbsMInput');
  hardEndHInput.setAttribute('enterkeyhint', 'next');
  hardEndMInput.setAttribute('enterkeyhint', 'done');
  hardEndAbsHInput.setAttribute('enterkeyhint', 'next');
  hardEndAbsMInput.setAttribute('enterkeyhint', 'done');
  bindOptionalNumberInput(hardEndHInput, { onChange: v=>{ state.hardEndH = v; }, rerenderFn: renderEdit });
  bindOptionalNumberInput(hardEndMInput, { max: 59, onChange: v=>{ state.hardEndM = v; }, rerenderFn: renderEdit });
  bindOptionalNumberInput(hardEndAbsHInput, { max: 23, onChange: v=>{ state.hardEndAbsH = v; }, rerenderFn: renderEdit });
  bindOptionalNumberInput(hardEndAbsMInput, { max: 59, onChange: v=>{ state.hardEndAbsM = v; }, rerenderFn: renderEdit });
  [hardEndHInput, hardEndMInput, hardEndAbsHInput, hardEndAbsMInput].forEach(selectAllOnFreshFocus);
  hardEndHInput.addEventListener('keydown', e=>{
    if (e.key === 'Enter') document.getElementById('hardEndMInput').focus();
  });
  hardEndAbsHInput.addEventListener('keydown', e=>{
    if (e.key === 'Enter') document.getElementById('hardEndAbsMInput').focus();
  });
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
    el.setAttribute('enterkeyhint', 'done');
    bindNumberInput(el, {
      min: 1, fallback: 1,
      onChange: v=>{ state.tasks[+el.dataset.idx].planned = v; },
      rerenderFn: renderEdit
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
    // 목표 종료 시각은 (시작 화면에 표시된) 계획 시작 시각 + 기준 시간 합계로 고정한다.
    // 절대 ms로 계산해두면 자정을 넘기는 일정도 날짜가 저절로 넘어간다.
    // 실제 시작이 늦거나 빨라도 이 목표는 바뀌지 않아야 지연/단축이 곧바로 반영된다.
    const sum = cleaned.reduce((s,t)=>s+t.planned,0);
    state.targetMs = hmToTodayMs(state.startHM) + sum*60000;
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
  const targetMs = state.targetMs;
  // 계획 시작~종료 시각은 "지금"이 아니라 마지막 체크포인트(수업 시작 또는 직전 실습
  // 완료 시각)를 기준으로 계산해 고정한다. 완료 버튼을 눌러야만(=체크포인트가 바뀌어야만)
  // 남은 실습들의 계획이 다시 계산되고, 단순히 시간이 흐른다고 실시간으로 바뀌지 않는다.
  const checkpointMs = state.log.length ? state.log[state.log.length-1].doneAtMs : state.actualStartMs;
  const { items } = distribute(pending, checkpointMs, targetMs);
  const delay = cumulativeDelayMin();
  const liveOvertime = nowMs > targetMs;
  const untilTargetMin = (targetMs - nowMs)/60000;
  // 실제 강의 종료 시각(교실을 비워야 하는 시각) 대비 예상 단축 시간.
  // 목표 종료 시각 자체는 시작할 때 고정되지만, 지금까지 완료한 실습들이
  // 계획보다 빠르거나 늦었던 만큼(delay)을 반영해야 "빨리 끝내면 단축 시간이
  // 늘어난다"는 게 보인다. 그래서 정적인 (hardEnd-target)이 아니라 delay를
  // 뺀 값을 쓴다: 빨리 끝날수록(delay<0) 단축 시간이 늘고, 늦어질수록 준다.
  const hardEndInfo = computeHardEndInfo(state.actualStartMs);
  const shortenMin = hardEndInfo.ms != null ? (hardEndInfo.ms - targetMs)/60000 - delay : null;

  let badgeHtml;
  if (Math.abs(delay) < 0.5) badgeHtml = `<span class="badge even">정시 진행</span>`;
  else if (delay > 0) badgeHtml = `<span class="badge behind">${fmtMin(delay)} 지연</span>`;
  else badgeHtml = `<span class="badge ahead">${fmtMin(-delay)} 단축</span>`;

  const doneHtml = state.log.map(l => `
    <div class="task done">
      <div class="task-main">
        <div class="task-name"><span class="check">&#10003;</span> ${escapeHtml(l.name)}</div>
        <div class="task-meta">
          계획 ${fmtMin(l.planned)} → 실제 ${formatClockRel(l.startMs, state.actualStartMs)}–${formatClockRel(l.doneAtMs, state.actualStartMs)} (${fmtMin(l.durationMin)})
          <span class="${l.durationMin>l.planned?'delta-down':'delta-up'}">${fmtSigned(l.durationMin-l.planned)}</span>
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
            <input type="text" class="pplanned" data-idx="${idx}" value="${t.planned}" inputmode="numeric" pattern="[0-9]*">
            분
            ${deltaMin !== 0 ? `<span class="${deltaCls}">(${fmtSigned(deltaMin)})</span>` : ''}
            · 계획 ${formatClockRel(t.recStartMs, state.actualStartMs)}–${formatClockRel(t.recEndMs, state.actualStartMs)}
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
        <input type="time" id="targetInputR" value="${msToClock(state.targetMs)}">
      </div>
      <div class="field">
        <label>실제 강의 종료 시각</label>
        <div class="duration-row">
          <input type="text" class="duration-input duration-h" id="hardEndHInputR" value="${state.hardEndH}" placeholder="0" inputmode="numeric" pattern="[0-9]*"><span>시간</span>
          <input type="text" class="duration-input duration-m" id="hardEndMInputR" value="${state.hardEndM}" placeholder="0" inputmode="numeric" pattern="[0-9]*"><span>분</span>
          <span class="duration-arrow">뒤</span>
        </div>
        <div class="duration-or">또는</div>
        <div class="duration-row">
          <input type="text" class="duration-input duration-h" id="hardEndAbsHInputR" value="${state.hardEndAbsH}" placeholder="0" inputmode="numeric" pattern="[0-9]*"><span>시</span>
          <input type="text" class="duration-input duration-m" id="hardEndAbsMInputR" value="${state.hardEndAbsM}" placeholder="0" inputmode="numeric" pattern="[0-9]*"><span>분</span>
        </div>
        ${hardEndInfo.error
          ? `<div class="computed-value" style="margin-top:6px;color:var(--behind);">${hardEndInfo.error}</div>`
          : hardEndInfo.ms != null
            ? `<div class="computed-value" style="margin-top:6px;">${formatClockRel(hardEndInfo.ms, state.actualStartMs)}(${fmtSigned((targetMs-hardEndInfo.ms)/60000)})</div>`
            : ''}
      </div>
    </div>
  ` : '';

  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-row">
        <div class="now-clock">${msToClock(nowMs)}</div>
        <div>
          <button class="icon-btn" id="settingsBtn">설정</button>
          <button class="icon-btn" id="leaveBtn">나가기</button>
          <button class="icon-btn" id="resetBtn">초기화</button>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="label">목표 종료</div><div class="value">${formatClockRel(targetMs, state.actualStartMs)}</div></div>
        <div class="stat"><div class="label">남은 시간</div><div class="value">${untilTargetMin>=0?fmtMin(untilTargetMin):'초과 '+fmtMin(-untilTargetMin)}</div></div>
        <div class="stat"><div class="label">진행 상태</div><div class="value">${badgeHtml}</div></div>
      </div>
      ${shortenMin != null ? `
      <div class="hardend-box">
        <div class="hardend-seg">
          <div class="label">실제 강의 종료 시각</div>
          <div class="value">${formatClockRel(hardEndInfo.ms, state.actualStartMs)}</div>
        </div>
        <div class="hardend-seg">
          <div class="label">예상 단축 시간</div>
          <div class="value ${shortenMin>=0?'ahead':'behind'}">${shortenMin>=0 ? fmtMin(shortenMin)+' 단축' : fmtMin(-shortenMin)+' 초과'}</div>
        </div>
      </div>
      ` : ''}
      ${settingsHtml}
    </div>
    ${liveOvertime ? `<div class="warning-banner">목표 종료 시각을 초과했어요. 완료를 누르면 남은 실습 계획이 다시 계산돼요.</div>` : ''}
    <div class="task-list">
      ${doneHtml}
      ${pendingHtml}
    </div>
    <button class="btn add-row-btn add-row-btn-inline" id="addRowBtnR">+ 강의 계획 시간 추가</button>
  `;

  document.getElementById('resetBtn').addEventListener('click', resetAll);
  document.getElementById('leaveBtn').addEventListener('click', ()=>{
    state.away = true;
    saveState();
    render();
  });
  document.getElementById('settingsBtn').addEventListener('click', ()=>{
    state.showSettings = !state.showSettings;
    saveState();
    renderRunning();
  });
  if (state.showSettings){
    document.getElementById('startInputR').addEventListener('input', e=>{ state.startHM = e.target.value; saveState(); renderRunning(); });
    document.getElementById('targetInputR').addEventListener('input', e=>{
      // 시:분만 입력하므로, 지금 목표보다 이전 시각이면(자정을 넘겨야 하는 경우) 다음 날로 계산한다.
      state.targetMs = resolveTimeOnOrAfter(e.target.value, state.actualStartMs);
      saveState();
      renderRunning();
    });
    const hardEndHInputR = document.getElementById('hardEndHInputR');
    const hardEndMInputR = document.getElementById('hardEndMInputR');
    const hardEndAbsHInputR = document.getElementById('hardEndAbsHInputR');
    const hardEndAbsMInputR = document.getElementById('hardEndAbsMInputR');
    hardEndHInputR.setAttribute('enterkeyhint', 'next');
    hardEndMInputR.setAttribute('enterkeyhint', 'done');
    hardEndAbsHInputR.setAttribute('enterkeyhint', 'next');
    hardEndAbsMInputR.setAttribute('enterkeyhint', 'done');
    bindOptionalNumberInput(hardEndHInputR, { onChange: v=>{ state.hardEndH = v; }, rerenderFn: renderRunning });
    bindOptionalNumberInput(hardEndMInputR, { max: 59, onChange: v=>{ state.hardEndM = v; }, rerenderFn: renderRunning });
    bindOptionalNumberInput(hardEndAbsHInputR, { max: 23, onChange: v=>{ state.hardEndAbsH = v; }, rerenderFn: renderRunning });
    bindOptionalNumberInput(hardEndAbsMInputR, { max: 59, onChange: v=>{ state.hardEndAbsM = v; }, rerenderFn: renderRunning });
    [hardEndHInputR, hardEndMInputR, hardEndAbsHInputR, hardEndAbsMInputR].forEach(selectAllOnFreshFocus);
    hardEndHInputR.addEventListener('keydown', e=>{
      if (e.key === 'Enter') document.getElementById('hardEndMInputR').focus();
    });
    hardEndAbsHInputR.addEventListener('keydown', e=>{
      if (e.key === 'Enter') document.getElementById('hardEndAbsMInputR').focus();
    });
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
    el.setAttribute('enterkeyhint', 'done');
    bindNumberInput(el, {
      min: 1, fallback: 1,
      onChange: v=>{ state.tasks[state.currentIndex + (+el.dataset.idx)].planned = v; },
      rerenderFn: renderRunning
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
      state.log.push({ name: task.name, planned: task.planned, startMs: prevMs, doneAtMs: now, durationMin });
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
      <span>${fmtMin(l.planned)} → ${formatClockRel(l.startMs, state.actualStartMs)}–${formatClockRel(l.doneAtMs, state.actualStartMs)} (${fmtSigned(l.durationMin-l.planned)})</span>
    </div>
  `).join('');

  app.innerHTML = `
    <div class="section">
      <h1>수업 완료</h1>
      <div class="card finish-card">
        <div class="label" style="color:var(--muted);font-size:13px;">종료 시각</div>
        <div class="big">${formatClockRel(endMs, state.actualStartMs)}</div>
        <div style="color:${diff>0?'var(--behind)':'var(--ahead)'};font-weight:700;">
          목표(${formatClockRel(state.targetMs, state.actualStartMs)}) 대비 ${fmtSigned(diff)}
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
