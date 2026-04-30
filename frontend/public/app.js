/**
 * BitMine Web UI — Frontend Application
 */

/* ── State ─────────────────────────────────────────────────────────────── */
let ws            = null;
let wsRetryTimer  = null;
let isRunning     = false;
let uptimeTimer   = null;
let serverUptime  = 0;   // ms, last value from server
let uptimeBase    = null; // local Date.now() when we got that value
let speedChart    = null;
let foundKeys     = [];
let autoScroll    = true;

/* ── DOM refs ────────────────────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelector(sel);

const elBadge     = $('status-badge');
const elSpeed     = $('stat-speed');
const elTotal     = $('stat-total');
const elUptime    = $('stat-uptime');
const elFound     = $('stat-found');
const elConsole   = $('console');
const elTbody     = $('found-tbody');
const elBtnStart  = $('btn-start');
const elBtnStop   = $('btn-stop');
const elWsDot     = $('ws-status');
const elWsLabel   = $('ws-label');
const elFootInfo  = $('footer-info');
const elClock     = $('clock');
const elPidLabel  = $('pid-label');
const elPidValue  = $('pid-value');
const elPidSep    = $('pid-sep');
const form        = $('config-form');

/* ── Clock ───────────────────────────────────────────────────────────────── */
function tickClock() {
  const now = new Date();
  elClock.textContent = now.toLocaleTimeString('en-US', { hour12: false });
}
setInterval(tickClock, 1000);
tickClock();

/* ── Uptime timer ────────────────────────────────────────────────────────── */
function startUptimeTick(currentUptimeMs) {
  serverUptime = currentUptimeMs;
  uptimeBase   = Date.now();
  if (uptimeTimer) clearInterval(uptimeTimer);
  uptimeTimer = setInterval(() => {
    const elapsed = serverUptime + (Date.now() - uptimeBase);
    elUptime.textContent = formatDuration(elapsed);
  }, 1000);
}

function stopUptimeTick() {
  if (uptimeTimer) { clearInterval(uptimeTimer); uptimeTimer = null; }
  elUptime.textContent = '00:00:00';
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':');
}

/* ── Speed formatter ─────────────────────────────────────────────────────── */
function fmtSpeed(n) {
  if (n === 0 || n == null) return '— keys/s';
  if (n >= 1e18) return (n / 1e18).toFixed(2) + ' Ekeys/s';
  if (n >= 1e15) return (n / 1e15).toFixed(2) + ' Pkeys/s';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + ' Tkeys/s';
  if (n >= 1e9)  return (n / 1e9 ).toFixed(2) + ' Gkeys/s';
  if (n >= 1e6)  return (n / 1e6 ).toFixed(2) + ' Mkeys/s';
  if (n >= 1e3)  return (n / 1e3 ).toFixed(2) + ' Kkeys/s';
  return n.toFixed(0) + ' keys/s';
}

function fmtNum(n) {
  return (n ?? 0).toLocaleString();
}

/* ── Status badge ────────────────────────────────────────────────────────── */
function setRunning(running, pid) {
  isRunning = running;
  elBadge.textContent  = running ? 'RUNNING' : 'IDLE';
  elBadge.className    = 'badge ' + (running ? 'badge-running' : 'badge-idle');
  elBtnStart.disabled  = running;
  elBtnStop.disabled   = !running;

  if (running && pid) {
    elPidValue.textContent = pid;
    elPidLabel.style.display = 'inline';
    elPidSep.style.display   = 'inline';
  } else {
    elPidLabel.style.display = 'none';
    elPidSep.style.display   = 'none';
  }
}

/* ── Chart setup ─────────────────────────────────────────────────────────── */
function initChart() {
  const ctx = $('speed-chart').getContext('2d');
  speedChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Speed',
        data: [],
        borderColor: '#00ff88',
        backgroundColor: 'rgba(0,255,136,0.06)',
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          display: false
        },
        y: {
          ticks: {
            color: '#5a6070',
            font: { family: 'monospace', size: 10 },
            callback: v => fmtSpeed(v)
          },
          grid: { color: 'rgba(37,42,56,0.8)' }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => fmtSpeed(ctx.parsed.y)
          }
        }
      }
    }
  });
}

function updateChart(history) {
  if (!speedChart || !history?.length) return;
  speedChart.data.labels  = history.map((_, i) => i);
  speedChart.data.datasets[0].data = history.map(p => p.speed ?? p);
  speedChart.update('none');
}

/* ── Console log ─────────────────────────────────────────────────────────── */
function classifyLine(line) {
  if (/hit!|key\s+found/i.test(line))          return 'log-hit';
  if (/private\s*key/i.test(line))             return 'log-key';
  if (/pubkey/i.test(line))                    return 'log-pubkey';
  if (/^address\s/i.test(line))                return 'log-address';
  if (/rmd160/i.test(line))                    return 'log-rmd';
  if (/^\[+\]/.test(line))                     return 'log-info';
  return 'log-normal';
}

function appendLog(line, stream, ts) {
  const div = document.createElement('div');
  div.className = 'log-line';

  const tsEl = document.createElement('span');
  tsEl.className = 'log-ts';
  const d = ts ? new Date(ts) : new Date();
  tsEl.textContent = d.toLocaleTimeString('en-US', { hour12: false });

  const txt = document.createElement('span');
  txt.className = 'log-txt ' + (stream === 'stderr' ? 'log-err' : classifyLine(line));
  txt.textContent = line;

  div.appendChild(tsEl);
  div.appendChild(txt);
  elConsole.appendChild(div);

  // Limit to last 600 DOM lines
  while (elConsole.childElementCount > 600) {
    elConsole.removeChild(elConsole.firstChild);
  }

  if (autoScroll) {
    elConsole.scrollTop = elConsole.scrollHeight;
  }
}

/* ── Found keys table ────────────────────────────────────────────────────── */
function renderFoundRow(entry, index, flash = false) {
  const tr = document.createElement('tr');
  if (flash) tr.className = 'row-new';

  const fmt = v => v ? truncate(v, 24) : '—';
  const d   = entry.timestamp ? new Date(entry.timestamp) : new Date();

  tr.innerHTML = `
    <td>${index + 1}</td>
    <td title="${entry.privateKey ?? ''}">${entry.privateKey ?? '—'}</td>
    <td title="${entry.address ?? ''}">${fmt(entry.address)}</td>
    <td title="${entry.rmd160 ?? ''}">${fmt(entry.rmd160)}</td>
    <td>${d.toLocaleString()}</td>
  `;
  return tr;
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function renderFoundTable(keys) {
  foundKeys = keys || [];
  elTbody.innerHTML = '';
  if (!foundKeys.length) {
    elTbody.innerHTML = '<tr class="empty-row"><td colspan="5">No keys found yet.</td></tr>';
    return;
  }
  foundKeys.forEach((k, i) => elTbody.appendChild(renderFoundRow(k, i, false)));
  elFound.textContent = foundKeys.length;
}

function addFoundRow(entry) {
  // Remove empty row if present
  const empty = elTbody.querySelector('.empty-row');
  if (empty) empty.remove();

  foundKeys.push(entry);
  const tr = renderFoundRow(entry, foundKeys.length - 1, true);
  elTbody.appendChild(tr);
  elFound.textContent = foundKeys.length;

  // Scroll table into view
  tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ── Config form ─────────────────────────────────────────────────────────── */
function populateForm(cfg) {
  if (!cfg) return;
  for (const [key, val] of Object.entries(cfg)) {
    const el = form.elements[key];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = val ?? '';
  }
}

function collectForm() {
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') data[el.name] = el.checked;
    else if (el.type === 'number') data[el.name] = el.value ? Number(el.value) : el.value;
    else data[el.name] = el.value;
  }
  return data;
}

/* ── WebSocket ───────────────────────────────────────────────────────────── */
function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}`);

  ws.onopen = () => {
    elWsDot.className  = 'ws-dot ws-connected';
    elWsLabel.textContent = 'Connected';
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
  };

  ws.onclose = () => {
    elWsDot.className  = 'ws-dot ws-error';
    elWsLabel.textContent = 'Disconnected — retrying…';
    wsRetryTimer = setTimeout(connectWs, 3000);
  };

  ws.onerror = () => {
    elWsDot.className  = 'ws-dot ws-error';
    elWsLabel.textContent = 'Connection error';
  };

  ws.onmessage = evt => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (_) { return; }
    handleMessage(msg);
  };
}

function handleMessage({ type, data, ts }) {
  switch (type) {

    case 'init': {
      setRunning(data.running, data.pid);
      populateForm(data.config);
      renderFoundTable(data.foundKeys);
      elSpeed.textContent = fmtSpeed(data.currentSpeed);
      elTotal.textContent = fmtNum(data.totalKeys);
      if (data.running && data.uptime) startUptimeTick(data.uptime);
      updateChart(data.speedHistory);
      if (data.logs?.length) {
        data.logs.forEach(l => appendLog(l.line, l.stream, l.ts));
      }
      const bgNote = data.running ? `Running (PID ${data.pid}) · background process survives browser close` : 'Idle';
      elFootInfo.textContent = `BitMine Web UI · ${bgNote}`;
      break;
    }

    case 'status': {
      setRunning(data.running, data.pid);
      if (data.running) {
        startUptimeTick(0);
        elFootInfo.textContent = `BitMine Web UI · Running (PID ${data.pid}) · background process survives browser close`;
      } else {
        stopUptimeTick();
        elSpeed.textContent = '— keys/s';
        elFootInfo.textContent = 'BitMine Web UI · Idle';
      }
      if (data.config) populateForm(data.config);
      break;
    }

    case 'stats': {
      elSpeed.textContent = fmtSpeed(data.currentSpeed);
      elTotal.textContent = fmtNum(data.totalKeys);
      elFound.textContent = data.foundCount ?? foundKeys.length;
      if (data.uptime) startUptimeTick(data.uptime);
      updateChart(data.speedHistory);
      break;
    }

    case 'log': {
      appendLog(data.line, data.stream, ts);
      break;
    }

    case 'found_key': {
      addFoundRow(data);
      break;
    }

    case 'raw_found_file': {
      // keyhunt wrote to KEYFOUNDKEYFOUND.txt — show in console
      if (data.text?.trim()) {
        appendLog('── KEYFOUNDKEYFOUND.txt updated ──', 'stdout', ts);
        data.text.trim().split('\n').forEach(l => appendLog(l, 'stdout', ts));
      }
      break;
    }

    case 'error': {
      appendLog('[ERROR] ' + data.message, 'stderr', ts);
      break;
    }
  }
}

/* ── API calls ───────────────────────────────────────────────────────────── */
async function apiPost(path, body) {
  const res = await fetch(path, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });
  return res.json();
}

async function apiGet(path) {
  const res = await fetch(path);
  return res.json();
}

/* ── Form submit → start ─────────────────────────────────────────────────── */
form.addEventListener('submit', async e => {
  e.preventDefault();
  const cfg = collectForm();
  elBtnStart.disabled = true;

  const result = await apiPost('/api/start', cfg).catch(err => ({ error: err.message }));

  if (result.error) {
    appendLog('[ERROR] ' + result.error, 'stderr');
    elBtnStart.disabled = false;
  } else {
    appendLog(`[START] PID=${result.pid}  keyhunt ${result.args?.join(' ')}`, 'stdout');
    appendLog(`[CWD]   ${result.workDir}`, 'stdout');
    appendLog(`[INFO]  Process runs in background — safe to close this browser tab`, 'stdout');
    appendLog(`[LOGS]  ${result.logs?.stdout}`, 'stdout');
  }
});

/* ── Stop button ─────────────────────────────────────────────────────────── */
$('btn-stop').addEventListener('click', async () => {
  elBtnStop.disabled = true;
  const result = await apiPost('/api/stop', {}).catch(err => ({ error: err.message }));
  if (result.error) {
    appendLog('[ERROR] ' + result.error, 'stderr');
    elBtnStop.disabled = false;
  }
});

/* ── Clear log ───────────────────────────────────────────────────────────── */
$('btn-clear-log').addEventListener('click', () => {
  elConsole.innerHTML = '';
});

/* ── Auto-scroll toggle ──────────────────────────────────────────────────── */
$('chk-autoscroll').addEventListener('change', e => {
  autoScroll = e.target.checked;
});

/* ── Reset config ────────────────────────────────────────────────────────── */
$('btn-reset-cfg').addEventListener('click', async () => {
  const cfg = await apiGet('/api/config');
  populateForm(cfg);
});

/* ── Export found keys ───────────────────────────────────────────────────── */
$('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(foundKeys, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `bitmine_found_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

/* ── Clear found keys ────────────────────────────────────────────────────── */
$('btn-clear-found').addEventListener('click', async () => {
  if (!confirm('Clear all found keys from the dashboard? (Server-side file is also cleared.)')) return;
  await fetch('/api/found', { method: 'DELETE' });
  renderFoundTable([]);
});

/* ── Init ────────────────────────────────────────────────────────────────── */
initChart();
connectWs();
