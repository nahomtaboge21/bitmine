/**
 * BitMine Web UI - Backend Server
 *
 * keyhunt runs as a DETACHED background process:
 *   - survives browser tab close
 *   - survives this Node server restarting
 *   - stdout/stderr are written to logs/bitmine.out / logs/bitmine.err
 *   - PID + config saved to runstate.json so the server can re-attach on restart
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const http = require('http');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Paths ────────────────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
const FOUND_FILE  = path.join(__dirname, 'found_keys.json');
const STATE_FILE  = path.join(__dirname, 'runstate.json');
const LOG_DIR     = path.join(__dirname, 'logs');
const STDOUT_LOG  = path.join(LOG_DIR, 'bitmine.out');
const STDERR_LOG  = path.join(LOG_DIR, 'bitmine.err');

fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── Runtime state ────────────────────────────────────────────────────────────
let foundKeys    = [];
let startTime    = null;
let speedHistory = [];
let totalKeys    = 0;
let currentSpeed = 0;
let logBuffer    = [];        // last 500 parsed log lines (in-memory ring buffer)
const MAX_LOG    = 500;

// Background-process tracking
let trackedPid    = null;     // PID of the running keyhunt (or null)
let tailInterval  = null;     // setInterval handle for log tailing
let watchInterval = null;     // setInterval handle for KEYFOUNDKEYFOUND.txt
let pendingKey    = null;     // partial key block being assembled from output

// Stdout tail offset (how many bytes we've already read from the log file)
let tailOutOffset = 0;
let tailErrOffset = 0;

// ─── Default config ───────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  binaryPath:    '../bitmine',
  workDir:       '..',
  mode:          'address',
  file:          'tests/66.txt',
  bits:          '66',
  range:         '',
  threads:       '4',
  compress:      'compress',
  random:        true,
  quiet:         true,
  statsInterval: '10',
  kFactor:       '',
  endomorphism:  false,
  saveFiles:     false,
  extraArgs:     ''
};
let config = { ...DEFAULT_CONFIG };

// ─── Persistence helpers ──────────────────────────────────────────────────────
function loadPersisted() {
  if (fs.existsSync(CONFIG_FILE)) {
    try { config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
    catch (_) {}
  }
  if (fs.existsSync(FOUND_FILE)) {
    try { foundKeys = JSON.parse(fs.readFileSync(FOUND_FILE, 'utf8')); }
    catch (_) { foundKeys = []; }
  }
}

function saveRunState(pid, cfg, args, workDir, stime) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pid, config: cfg, args, workDir, startTime: stime }, null, 2));
  } catch (_) {}
}

function clearRunState() {
  try { fs.writeFileSync(STATE_FILE, '{}'); } catch (_) {}
}

function loadRunState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

// ─── Check if a PID is alive (cross-platform) ─────────────────────────────────
function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (_) { return false; }
}

// ─── WebSocket broadcast ──────────────────────────────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function pushLog(line, stream = 'stdout') {
  const entry = { line, stream, ts: Date.now() };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG) logBuffer.shift();
  broadcast('log', entry);
}

// ─── Output parser ────────────────────────────────────────────────────────────
function parseOutput(line) {
  // Stats: Total 47634432 keys in 10 seconds: ~4.76 Mkeys/s (4763443 keys/s)
  const sm = line.match(/Total\s+([\d,]+)\s+keys.*?~([\d.]+)\s*([KMGTPE]?)keys\/s\s+\(([\d,]+)\s*keys\/s\)/i);
  if (sm) {
    totalKeys = parseInt(sm[1].replace(/,/g, ''), 10);
    const mult = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
    currentSpeed = parseFloat(sm[2]) * (mult[sm[3].toUpperCase()] ?? 1);
    speedHistory.push({ time: Date.now(), speed: currentSpeed });
    if (speedHistory.length > 120) speedHistory.shift();
    broadcast('stats', {
      totalKeys, currentSpeed, foundCount: foundKeys.length,
      uptime: startTime ? Date.now() - startTime : 0,
      speedHistory: speedHistory.slice(-60)
    });
  }

  if (/hit!|key\s+found/i.test(line)) {
    pendingKey = { timestamp: new Date().toISOString(), privateKey: null, pubkey: null, address: null, rmd160: null };
  }

  const pkm = line.match(/(?:private\s*key|priv\s*key)[:\s]+([0-9a-fA-F]{8,})/i);
  if (pkm) { if (!pendingKey) pendingKey = { timestamp: new Date().toISOString() }; pendingKey.privateKey = pkm[1]; }

  const pubm = line.match(/pubkey[:\s]+([0-9a-fA-F]{66,130})/i);
  if (pubm && pendingKey) pendingKey.pubkey = pubm[1];

  const addrm = line.match(/address\s+([13bc][a-zA-Z0-9]{24,33}|0x[0-9a-fA-F]{40})/i);
  if (addrm && pendingKey) pendingKey.address = addrm[1];

  const rmdm = line.match(/rmd160\s+([0-9a-fA-F]{40})/i);
  if (rmdm && pendingKey) {
    pendingKey.rmd160 = rmdm[1];
    saveFoundKey({ ...pendingKey });
    pendingKey = null;
  }

  // Fallback flush
  if (pendingKey?.privateKey && pendingKey?.address && !pendingKey.pubkey) {
    const re = [/pubkey/i, /private\s*key/i, /address\s/i, /rmd160/i];
    if (!re.some(r => r.test(line))) { saveFoundKey({ ...pendingKey }); pendingKey = null; }
  }
}

function saveFoundKey(entry) {
  foundKeys.push(entry);
  try { fs.writeFileSync(FOUND_FILE, JSON.stringify(foundKeys, null, 2)); } catch (_) {}
  broadcast('found_key', entry);
}

// ─── Log file tailer ──────────────────────────────────────────────────────────
// Reads new bytes from the log files every 300 ms and processes lines.
// This is how we get real-time output from the detached process.
let tailOutBuf = '';
let tailErrBuf = '';

function readNewBytes(filepath, offset, buf) {
  try {
    const stat = fs.statSync(filepath);
    if (stat.size <= offset) return { data: '', newOffset: offset };
    const toRead = Math.min(stat.size - offset, 65536); // max 64k per tick
    const b  = Buffer.alloc(toRead);
    const fd = fs.openSync(filepath, 'r');
    fs.readSync(fd, b, 0, toRead, offset);
    fs.closeSync(fd);
    return { data: b.toString('utf8'), newOffset: offset + toRead };
  } catch (_) {
    return { data: '', newOffset: offset };
  }
}

function tickTail() {
  // stdout
  const out = readNewBytes(STDOUT_LOG, tailOutOffset, tailOutBuf);
  if (out.data) {
    tailOutOffset = out.newOffset;
    tailOutBuf   += out.data;
    const lines   = tailOutBuf.split('\n');
    tailOutBuf    = lines.pop(); // keep incomplete last line
    lines.filter(l => l.trim()).forEach(l => { parseOutput(l); pushLog(l, 'stdout'); });
  }

  // stderr
  const err = readNewBytes(STDERR_LOG, tailErrOffset, tailErrBuf);
  if (err.data) {
    tailErrOffset = err.newOffset;
    tailErrBuf   += err.data;
    const lines   = tailErrBuf.split('\n');
    tailErrBuf    = lines.pop();
    lines.filter(l => l.trim()).forEach(l => { parseOutput(l); pushLog(l, 'stderr'); });
  }

  // Stop tailing once the process has exited
  if (!isPidAlive(trackedPid)) {
    stopMonitoring(true);
  }
}

function startMonitoring(pid, workDir) {
  trackedPid = pid;

  if (tailInterval)  clearInterval(tailInterval);
  if (watchInterval) clearInterval(watchInterval);

  tailInterval  = setInterval(tickTail, 300);
  watchInterval = setInterval(() => checkFoundFile(workDir), 2000);
}

function stopMonitoring(processExited = false) {
  if (tailInterval)  { clearInterval(tailInterval);  tailInterval  = null; }
  if (watchInterval) { clearInterval(watchInterval); watchInterval = null; }

  if (processExited && trackedPid !== null) {
    console.log(`[monitor] keyhunt PID ${trackedPid} is gone — stopped monitoring`);
    trackedPid = null;
    clearRunState();
    broadcast('status', { running: false });
  }
}

// ─── KEYFOUNDKEYFOUND.txt watcher ────────────────────────────────────────────
let foundFileSize = 0;
function checkFoundFile(workDir) {
  const fpath = path.join(workDir, 'KEYFOUNDKEYFOUND.txt');
  try {
    const st = fs.statSync(fpath);
    if (st.size > foundFileSize) {
      const b  = Buffer.alloc(st.size - foundFileSize);
      const fd = fs.openSync(fpath, 'r');
      fs.readSync(fd, b, 0, b.length, foundFileSize);
      fs.closeSync(fd);
      foundFileSize = st.size;
      broadcast('raw_found_file', { text: b.toString('utf8') });
    }
  } catch (_) {}
}

// ─── Build CLI args ───────────────────────────────────────────────────────────
function buildArgs(cfg) {
  const a = [];
  if (cfg.mode)          a.push('-m', cfg.mode);
  if (cfg.file)          a.push('-f', cfg.file);
  if (cfg.bits)          a.push('-b', cfg.bits);
  if (cfg.range)         a.push('-r', cfg.range);
  if (cfg.threads)       a.push('-t', cfg.threads);
  if (cfg.compress && cfg.compress !== 'both') a.push('-l', cfg.compress);
  if (cfg.random)        a.push('-R');
  if (cfg.quiet)         a.push('-q');
  if (cfg.statsInterval) a.push('-s', cfg.statsInterval);
  if (cfg.kFactor)       a.push('-k', cfg.kFactor);
  if (cfg.endomorphism)  a.push('-e');
  if (cfg.saveFiles)     a.push('-S');
  if (cfg.extraArgs)     cfg.extraArgs.trim().split(/\s+/).filter(Boolean).forEach(x => a.push(x));
  return a;
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.post('/api/start', (req, res) => {
  if (trackedPid && isPidAlive(trackedPid))
    return res.status(400).json({ error: 'Already running (PID ' + trackedPid + ')' });

  const runCfg  = { ...config, ...req.body };
  config = runCfg;
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (_) {}

  const args    = buildArgs(runCfg);
  const workDir = path.resolve(__dirname, runCfg.workDir || '..');
  const binPath = path.resolve(workDir, runCfg.binaryPath);

  let resolvedBin = binPath;
  if (process.platform === 'win32' && !binPath.endsWith('.exe') && !fs.existsSync(binPath)) {
    if (fs.existsSync(binPath + '.exe')) resolvedBin = binPath + '.exe';
  }

  if (!fs.existsSync(resolvedBin))
    return res.status(400).json({ error: `Binary not found: ${resolvedBin}` });

  // Reset state
  startTime     = Date.now();
  speedHistory  = [];
  totalKeys     = 0;
  currentSpeed  = 0;
  logBuffer     = [];
  pendingKey    = null;
  foundFileSize = 0;
  tailOutBuf    = '';
  tailErrBuf    = '';

  // Truncate log files so we start fresh
  try { fs.writeFileSync(STDOUT_LOG, ''); fs.writeFileSync(STDERR_LOG, ''); } catch (_) {}
  tailOutOffset = 0;
  tailErrOffset = 0;

  // Open file descriptors for child stdio
  let outFd, errFd;
  try {
    outFd = fs.openSync(STDOUT_LOG, 'w');
    errFd = fs.openSync(STDERR_LOG, 'w');
  } catch (err) {
    return res.status(500).json({ error: `Cannot open log files: ${err.message}` });
  }

  let child;
  try {
    child = spawn(resolvedBin, args, {
      cwd:      workDir,
      detached: true,                 // ← survives this server exiting
      stdio:    ['ignore', outFd, errFd]
    });
  } catch (err) {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    return res.status(500).json({ error: `Spawn failed: ${err.message}` });
  }

  // Close our copies of the fds — the child owns them now
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  // unref() → this server process won't wait for keyhunt to exit
  child.unref();

  const pid = child.pid;
  console.log(`[start] PID=${pid}  ${resolvedBin} ${args.join(' ')}`);
  console.log(`[cwd]   ${workDir}`);
  console.log(`[logs]  ${STDOUT_LOG}`);

  saveRunState(pid, runCfg, args, workDir, startTime);
  startMonitoring(pid, workDir);

  broadcast('status', { running: true, pid, config: runCfg, args, workDir });
  res.json({ success: true, pid, args, workDir, logs: { stdout: STDOUT_LOG, stderr: STDERR_LOG } });
});

app.post('/api/stop', (_req, res) => {
  if (!trackedPid || !isPidAlive(trackedPid))
    return res.status(400).json({ error: 'Not running' });

  const pid = trackedPid;
  console.log(`[stop] sending SIGTERM to PID ${pid}`);

  try {
    process.kill(pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGTERM');
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Force-kill after 6 s if still alive
  setTimeout(() => {
    if (isPidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (_) {}
    }
  }, 6000);

  res.json({ success: true, pid });
});

app.get('/api/status', (_req, res) => {
  const running = !!(trackedPid && isPidAlive(trackedPid));
  res.json({
    running,
    pid:         trackedPid,
    config,
    totalKeys,
    currentSpeed,
    foundCount:  foundKeys.length,
    uptime:      startTime ? Date.now() - startTime : 0,
    speedHistory: speedHistory.slice(-60),
    logs:        { stdout: STDOUT_LOG, stderr: STDERR_LOG }
  });
});

app.get('/api/found',    (_req, res) => res.json(foundKeys));
app.delete('/api/found', (_req, res) => {
  foundKeys = [];
  try { fs.writeFileSync(FOUND_FILE, '[]'); } catch (_) {}
  res.json({ success: true });
});

app.get('/api/config',  (_req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  config = { ...config, ...req.body };
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (_) {}
  res.json(config);
});

app.get('/api/logs', (_req, res) => res.json(logBuffer));

// Tail the raw log file (last N bytes) for a quick history fetch
app.get('/api/logs/raw', (_req, res) => {
  try {
    const st   = fs.statSync(STDOUT_LOG);
    const tail = Math.min(st.size, 100 * 1024);   // last 100 KB
    const buf  = Buffer.alloc(tail);
    const fd   = fs.openSync(STDOUT_LOG, 'r');
    fs.readSync(fd, buf, 0, tail, st.size - tail);
    fs.closeSync(fd);
    res.setHeader('Content-Type', 'text/plain');
    res.send(buf.toString('utf8'));
  } catch (_) {
    res.status(404).send('No log yet');
  }
});

// ─── WebSocket: send full state on connect ────────────────────────────────────
wss.on('connection', ws => {
  const running = !!(trackedPid && isPidAlive(trackedPid));
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      running,
      pid:         trackedPid,
      config,
      totalKeys,
      currentSpeed,
      foundKeys,
      foundCount:  foundKeys.length,
      speedHistory: speedHistory.slice(-60),
      uptime:      startTime ? Date.now() - startTime : 0,
      logs:        logBuffer
    }
  }));
});

// ─── On startup: re-attach if keyhunt is still running ───────────────────────
function tryReattach() {
  const state = loadRunState();
  if (!state.pid) return;

  if (isPidAlive(state.pid)) {
    console.log(`[reattach] keyhunt still running as PID ${state.pid} — resuming monitoring`);
    trackedPid   = state.pid;
    startTime    = state.startTime || Date.now();
    config       = { ...DEFAULT_CONFIG, ...(state.config || {}) };
    tailOutBuf   = '';
    tailErrBuf   = '';

    // Read how far the log files have progressed and catch up
    try { tailOutOffset = fs.statSync(STDOUT_LOG).size; } catch (_) { tailOutOffset = 0; }
    try { tailErrOffset = fs.statSync(STDERR_LOG).size; } catch (_) { tailErrOffset = 0; }

    startMonitoring(state.pid, path.resolve(__dirname, state.workDir || '..'));
    console.log(`[reattach] tailing logs from byte ${tailOutOffset}`);
  } else {
    console.log(`[reattach] saved PID ${state.pid} is no longer alive — clearing state`);
    clearRunState();
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
loadPersisted();
tryReattach();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () =>
  console.log(`\n  BitMine Web UI →  http://localhost:${PORT}\n  Logs: ${LOG_DIR}\n`)
);
