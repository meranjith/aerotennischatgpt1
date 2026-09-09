import {MotionEngine} from './motion-engine.js';
import {AudioEngine} from './audio-engine.js';
import {TennisMatch} from './game-logic.js';

const $=id=>document.getElementById(id);
const motion=new MotionEngine();
const audio=new AudioEngine();
const match=new TennisMatch();
let wakeLock=null, mode='lobby', localPlayer=0, peer=null, conn=null, roomCode='', ballTimer=null, hitWindow=null;
let incomingSide=null, incomingDuration=1000, impactAt=0, rallyId=0, rallyInProgress=false;

function show(id){for(const el of document.querySelectorAll('.screen'))el.classList.remove('active');$(id).classList.add('active');}
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),2400);}
function setEnabled(v){for(const id of ['practiceBtn','createBtn','joinBtn','calibrateBtn'])$(id).disabled=!v;}
function updateDebug(s){$('dbgAcc').textContent=`${s.accel.x.toFixed(1)},${s.accel.y.toFixed(1)},${s.accel.z.toFixed(1)}`;$('dbgFwd').textContent=`${s.forwardAccel.toFixed(2)} / ${s.rawForwardAccel.toFixed(2)}`;$('dbgFace').textContent=`${s.face.toUpperCase()} (${s.faceDot.toFixed(2)})`;$('dbgRot').textContent=(s.rotRate||0).toFixed(2);$('dbgConf').textContent=`${s.confidence}%`;}
function requireLandscape(){return matchMedia('(orientation:landscape)').matches;}

async function ensureReady(){
  await audio.init();
  try{await motion.requestPermission();}catch(e){toast(e.message||'Motion permission failed.');throw e;}
  if(!motion.state.calibrated) show('screenCalibration');
  if('wakeLock' in navigator){try{wakeLock=await navigator.wakeLock.request('screen');}catch{}}
}

motion.on(s=>{
  updateDebug(s);
  if(mode==='calibrating') $('calReadout').textContent=`α ${(s.orientation.alpha||0).toFixed(0)}° · β ${(s.orientation.beta||0).toFixed(0)}° · γ ${(s.orientation.gamma||0).toFixed(0)}° · face ${s.face}`;
  if(mode==='game' && s.swing) handleSwing();
});

async function doAudioTest(){
  try{await audio.init();audio.stereoTest();$('audioStatus').textContent='Listen: LEFT tone, then RIGHT tone. Your earbuds must clearly separate them.';setTimeout(()=>{if(confirm('Did you clearly hear LEFT then RIGHT?')){setEnabled(true);$('audioStatus').textContent='Stereo test passed. Motion controls unlocked.';}else{$('audioStatus').textContent='Test failed. Connect stereo headphones and try again.';}},1450);}catch(e){toast(e.message);}
}

$('audioTestBtn').onclick=doAudioTest;
$('calibrateBtn').onclick=async()=>{try{await ensureReady();mode='calibrating';show('screenCalibration');}catch{}};
$('captureCalibrationBtn').onclick=()=>{try{motion.calibrate();mode='lobby';show('screenLobby');toast('Calibration saved: screen-forward = racket forward.');}catch(e){toast(e.message);}};
$('cancelCalibrationBtn').onclick=()=>{mode='lobby';show('screenLobby');};

$('practiceBtn').onclick=async()=>{try{await audio.init();await motion.requestPermission();if(!motion.state.calibrated){mode='calibrating';show('screenCalibration');return;}await startGame('practice',0);}catch{}};
$('createBtn').onclick=async()=>{try{await audio.init();await motion.requestPermission();if(!motion.state.calibrated){mode='calibrating';show('screenCalibration');return;}createRoom();}catch{}};
$('joinBtn').onclick=()=>{$('joinBox').classList.toggle('hidden');$('roomInput').focus();};
$('confirmJoinBtn').onclick=async()=>{const code=$('roomInput').value.replace(/\D/g,'');if(code.length!==6){toast('Enter a 6-digit code.');return;}try{await audio.init();await motion.requestPermission();if(!motion.state.calibrated){mode='calibrating';show('screenCalibration');return;}joinRoom(code);}catch{}};
$('debugBtn').onclick=()=>{$('debugPanel').classList.toggle('hidden');};
$('quitBtn').onclick=()=>{stopGame();show('screenLobby');};

function randomCode(){return String(Math.floor(Math.random()*1e6)).padStart(6,'0');}
function initPeer(id,host=false){
  if(typeof Peer==='undefined'){toast('Peer connection library unavailable.');return;}
  peer=new Peer(id,{debug:0});
  peer.on('open',()=>{if(host){roomCode=id.slice(-6);$('roomCode').textContent=roomCode;$('roomBox').classList.remove('hidden');$('roomStatus').textContent='Waiting for Player 2…';}});
  peer.on('connection',c=>{if(conn){c.close();return;}conn=c;localPlayer=0;wireConnection();});
  peer.on('error',e=>toast(`Connection: ${e.type||e.message||'error'}`));
}
function wireConnection(){
  if(!conn)return;
  conn.on('open',()=>{mode='game';show('screenGame');$('modeLabel').textContent='LIVE MATCH';$('serveLabel').textContent='PLAYER 1 TO SERVE';toast('Peer connection established.');if(localPlayer===1 && conn.open)conn.send({type:'ready'});if(localPlayer===0)beginPoint();});
  conn.on('data',msg=>{
    if(msg?.type==='point'){resolvePoint(msg.winner,true);return;}
    if(msg?.type==='rally'){startRemoteBall(msg.side,1000,msg.id);return;}
    if(msg?.type==='shot'){startRemoteBall(msg.side,msg.duration,msg.id);return;}
    if(msg?.type==='ready'){if(localPlayer===0)beginPoint();}
  });
}
function createRoom(){
  const code=randomCode(); roomCode=code; initPeer(`aerotennis-${code}` ,true); $('roomBox').classList.remove('hidden'); $('roomCode').textContent=code; $('roomStatus').textContent='Waiting for Player 2…'; toast(`Match code ${code}`);
}
function joinRoom(code){
  roomCode=code; peer=new Peer(undefined,{debug:0}); peer.on('open',()=>{conn=peer.connect(`aerotennis-${code}`,{reliable:true});localPlayer=1;wireConnection();}); peer.on('error',e=>toast('Could not join that room. Check the code and host status.'));
}

async function startGame(newMode,player){
  mode='game';localPlayer=player;show('screenGame');$('modeLabel').textContent=newMode==='practice'?'WALL MODE':'LIVE MATCH';$('p1Name').textContent='P1';$('p2Name').textContent=newMode==='practice'?'WALL':'P2';updateScore();await speak(`Ready. ${localPlayer===0?'Player 1':'Player 2'} to serve.`);beginPoint();}
function updateScore(){ $('p1Score').textContent=match.pointLabel().split(' - ')[0].replace('LOVE','0').replace('15','15').replace('30','30').replace('40','40').replace('DEUCE','40').replace('ADVANTAGE P1','40'); $('p2Score').textContent=match.pointLabel().split(' - ')[1]?.replace('LOVE','0').replace('15','15').replace('30','30').replace('40','40').replace('ADVANTAGE P2','40')||'40'; }
async function speak(t){ if(!('speechSynthesis' in window))return; speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(t);u.rate=.88;u.pitch=.78;speechSynthesis.speak(u); }
function beginPoint(sideOverride=null, remoteStart=false){
  clearTimeout(ballTimer); clearTimeout(hitWindow); audio.stopApproach();
  $('audioState').textContent='LISTEN'; $('directionState').textContent='—';
  if(mode!=='game')return;

  // KEEP THIS PRACTICE/TRAINING PATH UNCHANGED:
  // random side, 1-second approach, local hit detection.
  const side=sideOverride || (Math.random()<.5?'left':'right');$('directionState').textContent=side.toUpperCase();
  const delay=remoteStart ? 120 : 900+Math.random()*900;

  // Only an actual multiplayer host sends the initial ball.
  if(!remoteStart && conn?.open) conn.send({type:'rally',side,id:++rallyId});

  ballTimer=setTimeout(()=>{
    incomingSide=side;
    incomingDuration=1000;
    impactAt=performance.now()+1000;
    rallyInProgress=Boolean(conn?.open);
    audio.ballApproach(side,1000);
    $('audioState').textContent='BALL APPROACHING';
    $('pulse').animate([{transform:'scale(.55)',opacity:.12},{transform:'scale(1.05)',opacity:.5}],{duration:1000,easing:'cubic-bezier(.2,.8,.1,1)'});
    hitWindow=setTimeout(()=>resolvePoint(null,false,side),1360);
    beginPoint.side=side;
    beginPoint.impactAt=impactAt;
  },delay);
}

function startRemoteBall(side,duration,id){
  if(mode!=='game' || !conn?.open)return;

  clearTimeout(ballTimer);
  clearTimeout(hitWindow);
  audio.stopApproach();

  const cleanSide=side==='left'?'left':'right';
  const cleanDuration=Number(duration)===500 ? 500 : 1000;

  incomingSide=cleanSide;
  incomingDuration=cleanDuration;
  impactAt=performance.now()+cleanDuration;
  rallyInProgress=true;
  rallyId=id ?? rallyId;
  beginPoint.side=cleanSide;
  beginPoint.impactAt=impactAt;

  $('audioState').textContent='BALL APPROACHING';
  $('directionState').textContent=cleanSide.toUpperCase();
  audio.ballApproach(cleanSide,cleanDuration);
  $('pulse').animate([
    {transform:'scale(.55)',opacity:.12},
    {transform:'scale(1.05)',opacity:.5}
  ],{
    duration:cleanDuration,
    easing:'cubic-bezier(.2,.8,.1,1)'
  });

  // Give the receiver a small grace period after the impact time before
  // declaring a miss; this is independent of shot speed and does not alter
  // the required 500/1000 ms approach duration.
  hitWindow=setTimeout(
    ()=>resolvePoint(null,false,cleanSide),
    cleanDuration+360
  );
}

function isFastSwing(ev){
  // IMPORTANT: this is a classification only. The actual swing detector and
  // face/side mechanics remain in motion-engine.js and are not modified.
  const forward=Math.max(0,Number(ev?.forwardAccel)||0);
  return forward>=5.5;
}

function handleSwing(){
  const ev=motion.consumeSwing();
  if(!ev)return;

  // Keep using the exact working swing discrimination.
  const side=beginPoint.side;
  if(!side)return;

  const faceDot=Number.isFinite(ev.faceDot)?ev.faceDot:0;
  const now=performance.now();
  const pointImpactAt=beginPoint.impactAt||now;
  const dt=Math.abs((ev.t||now)-pointImpactAt);

  const requiredFace=side==='right' ? 1 : -1;
  const faceDotThreshold=0.20;
  const correctFace=requiredFace===1
    ? faceDot>=faceDotThreshold
    : faceDot<=-faceDotThreshold;

  const timingWindowMs=800;
  const timingScore=clampNumber(1-(dt/timingWindowMs),0,1);
  const valid=correctFace && timingScore>0.04;

  if(!valid){
    audio.miss();
    if(!correctFace){
      $('audioState').textContent=side==='left'
        ? `MISS — BACKHAND REQUIRED (face ${faceDot.toFixed(2)})`
        : `MISS — FOREHAND REQUIRED (face ${faceDot.toFixed(2)})`;
    }else{
      $('audioState').textContent='MISS — TOO EARLY / LATE';
    }
    setTimeout(()=>beginPoint(),800);
    return;
  }

  // PRACTICE MODE: preserve the known-good behavior exactly.
  if(!conn?.open){
    audio.hit(side,ev.quality);
    $('audioState').textContent=side==='right'?'FOREHAND HIT':'BACKHAND HIT';
    resolvePoint(localPlayer,false,side,true);
    return;
  }

  // LIVE MULTIPLAYER ONLY:
  // successful hit transfers the ball instead of ending the point.
  // Normal = exactly 1000 ms, Fast = exactly 500 ms.
  const nextDuration=isFastSwing(ev)?500:1000;
  const nextSide=Math.random()<0.5?'left':'right';
  const nextId=(rallyId||0)+1;
  rallyId=nextId;

  audio.hit(side,ev.quality);
  $('audioState').textContent=
    `${side==='right'?'FOREHAND':'BACKHAND'} HIT · ${nextDuration===500?'FAST':'NORMAL'}`;

  clearTimeout(ballTimer);
  clearTimeout(hitWindow);
  audio.stopApproach();
  incomingSide=null;
  incomingDuration=nextDuration;
  impactAt=0;
  rallyInProgress=true;

  conn.send({
    type:'shot',
    side:nextSide,
    duration:nextDuration,
    id:nextId
  });
}

function clampNumber(v,a,b){return Math.max(a,Math.min(b,v));}
function resolvePoint(winner,remote=false,side=null,hit=false){
  clearTimeout(ballTimer);clearTimeout(hitWindow);audio.stopApproach();
  incomingSide=null; incomingDuration=1000; impactAt=0; rallyInProgress=false;
  if(winner===null){audio.miss();$('audioState').textContent='MISS';setTimeout(beginPoint,850);return;}
  const result=match.point(winner);updateScore();$('audioState').textContent=hit?'CLEAN HIT':'POINT';$('directionState').textContent=side?side.toUpperCase():'—';
  if(!remote&&conn?.open)conn.send({type:'point',winner});
  const winnerText=winner===0?'Player 1':'Player 2';
  if(result.gameWon){$('serveLabel').textContent=`${winnerText} WON THE GAME · ${match.server===0?'PLAYER 1':'PLAYER 2'} SERVES`;
    if(result.matchWon){speak(`${winnerText} wins the match.`);return;}
  } else $('serveLabel').textContent=`${match.pointLabel()} · ${match.server===0?'PLAYER 1':'PLAYER 2'} TO SERVE`;
  setTimeout(()=>{if(mode==='game')beginPoint();},1150);
}
function stopGame(){mode='lobby';clearTimeout(ballTimer);clearTimeout(hitWindow);audio.stopApproach();incomingSide=null;incomingDuration=1000;impactAt=0;rallyInProgress=false;if(wakeLock){wakeLock.release().catch(()=>{});wakeLock=null;}if(conn){try{conn.close()}catch{}}if(peer){try{peer.destroy()}catch{}}conn=null;peer=null;roomCode='';$('joinBox').classList.add('hidden');$('roomBox').classList.add('hidden');}

// Register PWA service worker only on HTTPS (GitHub Pages is HTTPS).
if('serviceWorker' in navigator && location.protocol==='https:') navigator.serviceWorker.register('./sw.js').catch(()=>{});
