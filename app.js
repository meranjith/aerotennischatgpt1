import {MotionEngine} from './motion-engine.js?v=20260909a';
import {AudioEngine} from './audio-engine.js?v=20260909a';
import {TennisMatch} from './game-logic.js?v=20260909a';
import {NORMAL_MS,FAST_MS,durationForSpeed,shotIsValidForSide,nextRandomSide,sanitizeShot} from './rally-core.js?v=20260909a';

const $=id=>document.getElementById(id);
const motion=new MotionEngine();
const audio=new AudioEngine();
const match=new TennisMatch();

const app={
  mode:'lobby', practice:false, player:0,
  side:null, duration:NORMAL_MS, impactAt:0,
  pointId:0, shotSeq:0, activeBall:false,
  peer:null, conn:null, host:false,
  timers:{launch:null,miss:null,nextPoint:null},
  lastResolvedPoint:-1,
  ready:false,
  ballToken:0,
  returnToken:0,
  lastSwingAt:0
};

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function show(id){document.querySelectorAll('.screen').forEach(x=>x.classList.remove('active'));$(id).classList.add('active');}
function toast(m){$('toast').textContent=m;$('toast').classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>$('toast').classList.remove('show'),2200);}
function updateDebug(s){$('dbgAcc').textContent=s.rawForwardAccel.toFixed(2);$('dbgFwd').textContent=s.forwardAccel.toFixed(2);$('dbgFace').textContent=`${s.face.toUpperCase()} (${s.faceDot.toFixed(2)})`;$('dbgRot').textContent=(s.rotRate||0).toFixed(1);$('dbgConf').textContent=`${s.confidence||0}%`;}
function updateScore(){
  const label=match.pointLabel();
  if(label==='DEUCE'){$('p1Score').textContent='40';$('p2Score').textContent='40';return;}
  const [a,b]=label.split(' - ');$('p1Score').textContent=a?.replace('LOVE','0')||'0';$('p2Score').textContent=b?.replace('LOVE','0')||'0';
}
async function speak(text){if(!('speechSynthesis' in window))return;speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.rate=.9;u.pitch=.8;speechSynthesis.speak(u);}
async function wake(){if(!('wakeLock' in navigator))return;try{window.__aeroWake=await navigator.wakeLock.request('screen');}catch{}}
async function ensureReady(){await audio.init();await motion.requestPermission();await wake();return motion.state.calibrated;}

motion.on(s=>{
  updateDebug(s);
  if(app.mode==='calibrating')$('calReadout').textContent=`α ${(s.orientation.alpha||0).toFixed(0)}° · β ${(s.orientation.beta||0).toFixed(0)}° · γ ${(s.orientation.gamma||0).toFixed(0)}° · ${s.face.toUpperCase()} ${s.faceDot.toFixed(2)}`;
  if(app.mode==='game' && s.swing)handleSwing();
});

$('audioTestBtn').onclick=async()=>{try{await audio.init();audio.stereoTest();$('audioStatus').textContent='LEFT tone → RIGHT tone. Headphones must separate them.';setTimeout(()=>{setButtons(true);$('audioStatus').textContent='Stereo test completed.';},1450);}catch(e){toast(e.message);}};
$('calibrateBtn').onclick=async()=>{try{await audio.init();await motion.requestPermission();show('screenCalibration');app.mode='calibrating';}catch(e){toast(e.message);}};
$('captureCalibrationBtn').onclick=()=>{try{motion.calibrate();app.mode='lobby';show('screenLobby');toast('Calibration saved. Screen-forward is your neutral racket pose.');}catch(e){toast(e.message);}};
$('cancelCalibrationBtn').onclick=()=>{app.mode='lobby';show('screenLobby');};
$('debugBtn').onclick=()=>$('debugPanel').classList.toggle('hidden');
$('quitBtn').onclick=()=>stopGame();
$('practiceBtn').onclick=async()=>{try{if(!motion.state.calibrated){if(!await ensureReady()){show('screenCalibration');app.mode='calibrating';return;}}else await audio.init();startPractice();}catch(e){toast(e.message);}};
$('createBtn').onclick=async()=>{try{if(!motion.state.calibrated){if(!await ensureReady()){show('screenCalibration');app.mode='calibrating';return;}}else await audio.init();startHost();}catch(e){toast(e.message);}};
$('joinBtn').onclick=()=>{$('joinBox').classList.toggle('hidden');$('roomInput').focus();};
$('confirmJoinBtn').onclick=async()=>{const code=$('roomInput').value.replace(/\D/g,'');if(code.length!==6)return toast('Enter a 6-digit code.');try{if(!motion.state.calibrated){if(!await ensureReady()){show('screenCalibration');app.mode='calibrating';return;}}else await audio.init();startJoin(code);}catch(e){toast(e.message);}};

function setButtons(v){['practiceBtn','createBtn','joinBtn','calibrateBtn'].forEach(id=>$(id).disabled=!v);}
function clearTimers(){for(const k of Object.keys(app.timers))clearTimeout(app.timers[k]);app.timers={launch:null,miss:null,nextPoint:null};app.ballToken++;app.returnToken++;audio.stopApproach();}
function setGameLabels(){ $('modeLabel').textContent=app.practice?'WALL MODE':'LIVE MATCH';$('p1Name').textContent='P1';$('p2Name').textContent=app.practice?'WALL':'P2';updateScore(); }
function prepareGame(){
  clearTimers();
  try{screen.orientation?.lock?.('landscape').catch?.(()=>{});}catch{}match.reset();app.pointId=0;app.shotSeq=0;app.lastResolvedPoint=-1;app.activeBall=false;app.side=null;app.duration=NORMAL_MS;app.lastSwingAt=0;app.ballToken=0;app.returnToken=0;
  app.mode='game';motion.resetForGame();show('screenGame');setGameLabels();$('serveLabel').textContent='PLAYER 1 TO SERVE';
}
async function startPractice(){app.practice=true;app.player=0;app.host=false;app.conn=null;app.peer=null;prepareGame();await speak('Wall mode ready.');queuePracticeBall(NORMAL_MS);}

function queuePracticeBall(duration){
  clearTimeout(app.timers.launch);clearTimeout(app.timers.miss);audio.stopApproach();
  const token=++app.ballToken;
  const side=nextRandomSide();
  app.timers.launch=setTimeout(()=>{if(token===app.ballToken)startBall(side,duration);},650);
}

function startBall(side,duration){
  if(app.mode!=='game')return;
  clearTimeout(app.timers.miss);
  audio.stopApproach();
  const token=++app.ballToken;
  app.side=side==='left'?'left':'right';
  app.duration=duration===FAST_MS?FAST_MS:NORMAL_MS;
  app.impactAt=performance.now()+app.duration;
  app.activeBall=true;
  $('audioState').textContent='BALL APPROACHING';
  $('directionState').textContent=app.side.toUpperCase();
  audio.ballApproach(app.side,app.duration);
  $('pulse').animate([{transform:'scale(.55)',opacity:.12},{transform:'scale(1.05)',opacity:.5}],{duration:app.duration,easing:'ease-out'});
  app.timers.miss=setTimeout(()=>{if(token===app.ballToken&&app.activeBall)receiverMiss();},app.duration+380);
}

function handleSwing(){
  if(!app.activeBall || !app.side)return;
  const swing=motion.consumeSwing();
  if(!swing)return;
  // A swing can only resolve the current ball once. The wider window compensates
  // for Bluetooth/audio latency and mobile sensor sampling without allowing a
  // swing from the previous ball to count.
  if(swing.t<=app.lastSwingAt)return;
  app.lastSwingAt=swing.t;
  const faceOK=shotIsValidForSide(app.side,swing.face);
  const dt=swing.t-app.impactAt;
  const timingOK=dt>=-360 && dt<=420;
  if(!faceOK || !timingOK){
    app.activeBall=false;app.ballToken++;clearTimeout(app.timers.miss);audio.stopApproach();audio.miss();
    $('audioState').textContent=!faceOK?'MISS — WRONG RACKET FACE':'MISS — TOO EARLY / LATE';
    receiverMiss();
    return;
  }

  app.activeBall=false;app.ballToken++;clearTimeout(app.timers.miss);audio.stopApproach();audio.hit(app.side,swing.quality);
  const speed=swing.speed==='fast'?'fast':'normal';
  const nextDuration=durationForSpeed(speed);
  $('audioState').textContent=`${app.side==='right'?'FOREHAND':'BACKHAND'} · ${speed.toUpperCase()}`;

  if(app.practice){
    const token=++app.returnToken;
    app.timers.nextPoint=setTimeout(()=>{if(token===app.returnToken)queuePracticeReturn(nextDuration);},650);
  }else{
    const nextSide=nextRandomSide();
    app.shotSeq++;
    sendPeer({type:'SHOT',pointId:app.pointId,seq:app.shotSeq,target:app.player^1,side:nextSide,speed,duration:nextDuration});
  }
}
function queuePracticeReturn(duration){
  if(app.mode!=='game'||!app.practice)return;
  const side=nextRandomSide();
  startBall(side,duration);
}
function receiverMiss(){
  if(!app.activeBall && !app.practice && app.lastResolvedPoint===app.pointId)return;
  app.activeBall=false;
  if(app.practice){
    const token=++app.returnToken;
    app.timers.nextPoint=setTimeout(()=>{if(token===app.returnToken)queuePracticeBall(NORMAL_MS);},900);
    return;
  }
  const winner=app.player^1;
  // Resolve locally first so both peers update immediately; the remote copy
  // is idempotent because resolvePointRemote guards on pointId.
  if(app.lastResolvedPoint!==app.pointId) resolvePointRemote(winner);
  sendPeer({type:'POINT',pointId:app.pointId,winner});
}

function randomCode(){return String(Math.floor(Math.random()*1e6)).padStart(6,'0');}
function startHost(){
  app.practice=false;app.host=true;app.player=0;app.pointId=0;app.shotSeq=0;
  const code=randomCode();$('roomCode').textContent=code;$('roomBox').classList.remove('hidden');$('roomStatus').textContent='Waiting for Player 2…';
  app.peer=new Peer(`aero2v2-${code}`,{debug:0});
  app.peer.on('connection',c=>{if(app.conn){c.close();return;}app.conn=c;wireConnection();});
  app.peer.on('error',e=>toast(`Connection: ${e.type||e.message||'error'}`));
}
function startJoin(code){
  app.practice=false;app.host=false;app.player=1;
  app.peer=new Peer(undefined,{debug:0});
  app.peer.on('open',()=>{app.conn=app.peer.connect(`aero2v2-${code}`,{reliable:true,serialization:'json'});wireConnection();});
  app.peer.on('error',()=>toast('Could not join the room.'));
}
function wireConnection(){
  app.conn.on('open',async()=>{
    app.ready=true;prepareGame();$('serveLabel').textContent='PLAYER 1 TO SERVE';toast('Players connected.');
    if(app.host){await speak('Player 1 to serve.');beginPointAsServer();}
  });
  app.conn.on('data',msg=>onPeerMessage(msg));
  app.conn.on('close',()=>toast('Opponent disconnected.'));
}
function beginPointAsServer(){
  if(app.mode!=='game'||!app.host)return;
  app.pointId+=1;app.shotSeq=0;
  const side=nextRandomSide();
  $('serveLabel').textContent=`${match.server===0?'PLAYER 1':'PLAYER 2'} TO SERVE`;
  if(match.server===app.player){
    startBall(side,NORMAL_MS);
  }else{
    sendPeer({type:'SERVE',pointId:app.pointId,target:match.server,side,duration:NORMAL_MS});
  }
}
function sendPeer(m){if(app.conn?.open)app.conn.send(m);}
function onPeerMessage(raw){
  if(app.mode!=='game'||!raw)return;
  if(raw.type==='SERVE'){
    if(raw.target!==app.player||raw.pointId<app.pointId)return;
    app.pointId=raw.pointId;app.shotSeq=0;startBall(raw.side,NORMAL_MS);return;
  }
  if(raw.type==='SHOT'){
    const msg=sanitizeShot(raw);
    if(msg.target!==app.player||msg.pointId!==app.pointId)return;
    if(msg.seq<=app.shotSeq)return;
    app.shotSeq=msg.seq;startBall(msg.side,msg.duration);return;
  }
  if(raw.type==='POINT'){
    if(raw.pointId!==app.pointId||raw.pointId===app.lastResolvedPoint)return;
    resolvePointRemote(raw.winner);return;
  }
}
function resolvePointRemote(winner){
  if(app.lastResolvedPoint===app.pointId)return;
  app.lastResolvedPoint=app.pointId;clearTimers();app.activeBall=false;
  const result=match.point(winner);updateScore();
  $('audioState').textContent=winner===app.player?'POINT WON':'POINT LOST';
  $('serveLabel').textContent=`${match.server===0?'PLAYER 1':'PLAYER 2'} TO SERVE`;
  if(result.matchWon){speak(`${winner===0?'Player 1':'Player 2'} wins the match.`);return;}
  app.timers.nextPoint=setTimeout(()=>{if(app.host)beginPointAsServer();},1150);
}
function stopGame(){
  clearTimers();app.mode='lobby';app.practice=false;app.activeBall=false;show('screenLobby');
  try{app.conn?.close();app.peer?.destroy();}catch{}
  app.conn=null;app.peer=null;
  if(window.__aeroWake){window.__aeroWake.release().catch(()=>{});window.__aeroWake=null;}
}

// Keep AudioContext awake after focus/visibility changes.
document.addEventListener('visibilitychange',()=>{if(!document.hidden)audio.resume().catch(()=>{});},{passive:true});
window.addEventListener('focus',()=>audio.resume().catch(()=>{}),{passive:true});
