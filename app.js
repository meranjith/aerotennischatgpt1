import { MotionEngine } from './motion-engine.js';
import { AudioEngine } from './audio-engine.js';
import { TennisMatch } from './game-logic.js';

const $ = id => document.getElementById(id);
const motion = new MotionEngine();
const audio = new AudioEngine();
const match = new TennisMatch();
let wakeLock = null,
  mode = 'lobby',
  localPlayer = 0,
  peer = null,
  conn = null,
  roomCode = '',
  ballTimer = null,
  hitWindow = null,
  nextApproachDuration = null; // NEW: stores the ball speed for the next rally

function show(id) {
  for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
  $(id).classList.add('active');
}
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2400);
}
function setEnabled(v) {
  for (const id of ['practiceBtn', 'createBtn', 'joinBtn', 'calibrateBtn']) $(id).disabled = !v;
}
function updateDebug(s) {
  $('dbgAcc').textContent = `${s.accel.x.toFixed(1)},${s.accel.y.toFixed(1)},${s.accel.z.toFixed(1)}`;
  $('dbgFwd').textContent = `${s.forwardAccel.toFixed(2)} / ${s.rawForwardAccel.toFixed(2)}`;
  $('dbgFace').textContent = `${s.face.toUpperCase()} (${s.faceDot.toFixed(2)})`;
  $('dbgRot').textContent = (s.rotRate || 0).toFixed(2);
  $('dbgConf').textContent = `${s.confidence}%`;
}
function requireLandscape() {
  return matchMedia('(orientation:landscape)').matches;
}

async function ensureReady() {
  await audio.init();
  try {
    await motion.requestPermission();
  } catch (e) {
    toast(e.message || 'Motion permission failed.');
    throw e;
  }
  if (!motion.state.calibrated) show('screenCalibration');
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch {}
  }
}

motion.on(s => {
  updateDebug(s);
  if (mode === 'calibrating')
    $('calReadout').textContent = `α ${(s.orientation.alpha || 0).toFixed(0)}° · β ${(s.orientation.beta || 0).toFixed(0)}° · γ ${(s.orientation.gamma || 0).toFixed(0)}° · face ${s.face}`;
  if (mode === 'game' && s.swing) handleSwing();
});

async function doAudioTest() {
  try {
    await audio.init();
    audio.stereoTest();
    $('audioStatus').textContent = 'Listen: LEFT tone, then RIGHT tone. Your earbuds must clearly separate them.';
    setTimeout(() => {
      if (confirm('Did you clearly hear LEFT then RIGHT?')) {
        setEnabled(true);
        $('audioStatus').textContent = 'Stereo test passed. Motion controls unlocked.';
      } else {
        $('audioStatus').textContent = 'Test failed. Connect stereo headphones and try again.';
      }
    }, 1450);
  } catch (e) {
    toast(e.message);
  }
}

$('audioTestBtn').onclick = doAudioTest;
$('calibrateBtn').onclick = async () => {
  try {
    await ensureReady();
    mode = 'calibrating';
    show('screenCalibration');
  } catch {}
};
$('captureCalibrationBtn').onclick = () => {
  try {
    motion.calibrate();
    mode = 'lobby';
    show('screenLobby');
    toast('Calibration saved: screen-forward = racket forward.');
  } catch (e) {
    toast(e.message);
  }
};
$('cancelCalibrationBtn').onclick = () => {
  mode = 'lobby';
  show('screenLobby');
};

$('practiceBtn').onclick = async () => {
  try {
    await audio.init();
    await motion.requestPermission();
    if (!motion.state.calibrated) {
      mode = 'calibrating';
      show('screenCalibration');
      return;
    }
    await startGame('practice', 0);
  } catch {}
};
$('createBtn').onclick = async () => {
  try {
    await audio.init();
    await motion.requestPermission();
    if (!motion.state.calibrated) {
      mode = 'calibrating';
      show('screenCalibration');
      return;
    }
    createRoom();
  } catch {}
};
$('joinBtn').onclick = () => {
  $('joinBox').classList.toggle('hidden');
  $('roomInput').focus();
};
$('confirmJoinBtn').onclick = async () => {
  const code = $('roomInput').value.replace(/\D/g, '');
  if (code.length !== 6) {
    toast('Enter a 6-digit code.');
    return;
  }
  try {
    await audio.init();
    await motion.requestPermission();
    if (!motion.state.calibrated) {
      mode = 'calibrating';
      show('screenCalibration');
      return;
    }
    joinRoom(code);
  } catch {}
};
$('debugBtn').onclick = () => {
  $('debugPanel').classList.toggle('hidden');
};
$('quitBtn').onclick = () => {
  stopGame();
  show('screenLobby');
};

function randomCode() {
  return String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
}
function initPeer(id, host = false) {
  if (typeof Peer === 'undefined') {
    toast('Peer connection library unavailable.');
    return;
  }
  peer = new Peer(id, { debug: 0 });
  peer.on('open', () => {
    if (host) {
      roomCode = id.slice(-6);
      $('roomCode').textContent = roomCode;
      $('roomBox').classList.remove('hidden');
      $('roomStatus').textContent = 'Waiting for Player 2…';
    }
  });
  peer.on('connection', c => {
    if (conn) {
      c.close();
      return;
    }
    conn = c;
    localPlayer = 0;
    wireConnection();
  });
  peer.on('error', e => toast(`Connection: ${e.type || e.message || 'error'}`));
}
function wireConnection() {
  if (!conn) return;
  conn.on('open', () => {
    mode = 'game';
    show('screenGame');
    $('modeLabel').textContent = 'LIVE MATCH';
    $('serveLabel').textContent = 'PLAYER 1 TO SERVE';
    toast('Peer connection established.');
    if (localPlayer === 1 && conn.open) conn.send({ type: 'ready' });
    if (localPlayer === 0) beginPoint();
  });
  conn.on('data', msg => {
    if (msg?.type === 'point') {
      // Store the approach speed if provided
      if (msg.approachDuration) nextApproachDuration = msg.approachDuration;
      resolvePoint(msg.winner, true);
      return;
    }
    if (msg?.type === 'rally') {
      // Use the approach duration sent by the host
      beginPoint(msg.side, true, msg.approachDuration || 1000);
      return;
    }
    if (msg?.type === 'ready') {
      if (localPlayer === 0) beginPoint();
    }
  });
}
function createRoom() {
  const code = randomCode();
  roomCode = code;
  initPeer(`aerotennis-${code}`, true);
  $('roomBox').classList.remove('hidden');
  $('roomCode').textContent = code;
  $('roomStatus').textContent = 'Waiting for Player 2…';
  toast(`Match code ${code}`);
}
function joinRoom(code) {
  roomCode = code;
  peer = new Peer(undefined, { debug: 0 });
  peer.on('open', () => {
    conn = peer.connect(`aerotennis-${code}`, { reliable: true });
    localPlayer = 1;
    wireConnection();
  });
  peer.on('error', e => toast('Could not join that room. Check the code and host status.'));
}

async function startGame(newMode, player) {
  mode = 'game';
  localPlayer = player;
  show('screenGame');
  $('modeLabel').textContent = newMode === 'practice' ? 'WALL MODE' : 'LIVE MATCH';
  $('p1Name').textContent = 'P1';
  $('p2Name').textContent = newMode === 'practice' ? 'WALL' : 'P2';
  updateScore();
  await speak(`Ready. ${localPlayer === 0 ? 'Player 1' : 'Player 2'} to serve.`);
  beginPoint();
}
function updateScore() {
  $('p1Score').textContent = match
    .pointLabel()
    .split(' - ')[0]
    .replace('LOVE', '0')
    .replace('15', '15')
    .replace('30', '30')
    .replace('40', '40')
    .replace('DEUCE', '40')
    .replace('ADVANTAGE P1', '40');
  $('p2Score').textContent =
    match
      .pointLabel()
      .split(' - ')[1]
      ?.replace('LOVE', '0')
      .replace('15', '15')
      .replace('30', '30')
      .replace('40', '40')
      .replace('ADVANTAGE P2', '40') || '40';
}
async function speak(t) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(t);
  u.rate = 0.88;
  u.pitch = 0.78;
  speechSynthesis.speak(u);
}

function beginPoint(sideOverride = null, remoteStart = false, approachDurationOverride = null) {
  clearTimeout(ballTimer);
  clearTimeout(hitWindow);
  audio.stopApproach();
  $('audioState').textContent = 'LISTEN';
  $('directionState').textContent = '—';
  if (mode !== 'game') return;

  const side = sideOverride || (Math.random() < 0.5 ? 'left' : 'right');

  // Determine approach duration:
  // 1) explicit override from remote rally message
  // 2) stored speed from the last hit (if any)
  // 3) otherwise random (50% fast / 50% normal)
  let approachDuration;
  if (approachDurationOverride) {
    approachDuration = approachDurationOverride;
  } else if (nextApproachDuration) {
    approachDuration = nextApproachDuration;
  } else {
    approachDuration = Math.random() < 0.5 ? 500 : 1000;
  }
  beginPoint.approachDuration = approachDuration;
  nextApproachDuration = null; // clear after using

  // Show side + speed indicator
  $('directionState').textContent =
    side.toUpperCase() + (approachDuration < 700 ? ' · FAST' : ' · NORMAL');

  const delay = remoteStart ? 120 : 900 + Math.random() * 900;
  if (!remoteStart && conn?.open) {
    conn.send({ type: 'rally', side, approachDuration });
  }

  ballTimer = setTimeout(() => {
    audio.ballApproach(side, approachDuration);
    $('audioState').textContent = 'BALL APPROACHING';
    $('pulse').animate(
      [
        { transform: 'scale(.55)', opacity: 0.12 },
        { transform: 'scale(1.05)', opacity: 0.5 },
      ],
      { duration: approachDuration, easing: 'cubic-bezier(.2,.8,.1,1)' }
    );
    hitWindow = setTimeout(() => resolvePoint(null, false, side), approachDuration + 360);
    beginPoint.side = side;
    beginPoint.impactAt = performance.now() + approachDuration;
  }, delay);
}

function handleSwing() {
  const ev = motion.consumeSwing();
  if (!ev) return;

  const side = beginPoint.side;
  if (!side) return;

  const faceDot = Number.isFinite(ev.faceDot) ? ev.faceDot : 0;
  const now = performance.now();
  const impactAt = beginPoint.impactAt || now;
  const dt = Math.abs((ev.t || now) - impactAt);

  // The SENSOR ENGINE gives us the actual face orientation at the stroke.
  const requiredFace = side === 'right' ? 1 : -1;
  const faceDotThreshold = 0.2;
  const correctFace =
    requiredFace === 1 ? faceDot >= faceDotThreshold : faceDot <= -faceDotThreshold;

  // Timing window scales with approach duration (min 300ms)
  const approachDuration = beginPoint.approachDuration || 1000;
  const timingWindowMs = Math.max(300, approachDuration * 0.7);
  const timingScore = clampNumber(1 - dt / timingWindowMs, 0, 1);

  const valid = correctFace && timingScore > 0.04;

  if (valid) {
    // Determine swing speed: fast if forwardAccel >= 4.0
    const swingSpeed = ev.forwardAccel >= 4.0 ? 500 : 1000;
    nextApproachDuration = swingSpeed;

    audio.hit(side, ev.quality);
    $('audioState').textContent = side === 'right' ? 'FOREHAND HIT' : 'BACKHAND HIT';
    resolvePoint(localPlayer, false, side, true);
    return;
  }

  audio.miss();
  // For a failed swing, set next ball to normal speed
  nextApproachDuration = 1000;
  if (!correctFace) {
    $('audioState').textContent =
      side === 'left'
        ? `MISS — BACKHAND REQUIRED (face ${faceDot.toFixed(2)})`
        : `MISS — FOREHAND REQUIRED (face ${faceDot.toFixed(2)})`;
  } else {
    $('audioState').textContent = 'MISS — TOO EARLY / LATE';
  }
  setTimeout(() => beginPoint(), 800);
}

function clampNumber(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function resolvePoint(winner, remote = false, side = null, hit = false) {
  clearTimeout(ballTimer);
  clearTimeout(hitWindow);
  audio.stopApproach();

  if (winner === null) {
    audio.miss();
    $('audioState').textContent = 'MISS';
    nextApproachDuration = 1000; // no swing → normal speed next ball
    setTimeout(beginPoint, 850);
    return;
  }

  const result = match.point(winner);
  updateScore();
  $('audioState').textContent = hit ? 'CLEAN HIT' : 'POINT';
  $('directionState').textContent = side ? side.toUpperCase() : '—';

  if (!remote && conn?.open) {
    conn.send({ type: 'point', winner, approachDuration: nextApproachDuration || 1000 });
  }

  const winnerText = winner === 0 ? 'Player 1' : 'Player 2';
  if (result.gameWon) {
    $('serveLabel').textContent = `${winnerText} WON THE GAME · ${match.server === 0 ? 'PLAYER 1' : 'PLAYER 2'} SERVES`;
    if (result.matchWon) {
      speak(`${winnerText} wins the match.`);
      return;
    }
  } else {
    $('serveLabel').textContent = `${match.pointLabel()} · ${match.server === 0 ? 'PLAYER 1' : 'PLAYER 2'} TO SERVE`;
  }
  setTimeout(() => {
    if (mode === 'game') beginPoint();
  }, 1150);
}

function stopGame() {
  mode = 'lobby';
  clearTimeout(ballTimer);
  clearTimeout(hitWindow);
  audio.stopApproach();
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  if (conn) {
    try {
      conn.close();
    } catch {}
  }
  if (peer) {
    try {
      peer.destroy();
    } catch {}
  }
  conn = null;
  peer = null;
  roomCode = '';
  nextApproachDuration = null;
  $('joinBox').classList.add('hidden');
  $('roomBox').classList.add('hidden');
}

// Register PWA service worker only on HTTPS (GitHub Pages is HTTPS).
if ('serviceWorker' in navigator && location.protocol === 'https:')
  navigator.serviceWorker.register('./sw.js').catch(() => {});
