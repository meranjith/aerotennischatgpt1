import {MotionEngine} from './motion-engine.js';
import {AudioEngine} from './audio-engine.js';
import {TennisMatch} from './game-logic.js';

const $=id=>document.getElementById(id);
const motion=new MotionEngine();
const audio=new AudioEngine();
const match=new TennisMatch();
let wakeLock=null, mode='lobby', localPlayer=0, peer=null, conn=null, roomCode='', ballTimer=null, hitWindow=null;
let incomingSide=null, incomingDuration=1000, impactAt=0, rallyToken=0;

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
    if(msg?.type==='rally'){startRemoteBall(msg.side,msg.duration||1000,msg.token);return;}
    if(msg?.type==='ready'){if(localPlayer===0)beginPoint();}
    if(msg?.type==='shot'){startRemoteBall(msg.side,msg.duration||1000,msg.token);return;}
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
const NORMAL_DURATION=1000;
const FAST_DURATION=500;
const FAST_SWING_THRESHOLD=0.58;

function swingSpeedScore(ev){
  const accel=Number(ev?.forwardAccel)||0;
  const rot=Math.abs(Number(ev?.rotRate)||0);
  const accelScore=clampNumber((Math.max(0,accel)-1.5)/8.5,0,1);
  const rotationScore=clampNumber(rot/4.5,0,1);
  return clampNumber(0.72*accelScore+0.28*rotationScore,0,1);
}

function durationFromSpeed(score){
  return Number(score)>=FAST_SWING_THRESHOLD ? FAST_DURATION : NORMAL_DURATION;
}

function beginPoint(sideOverride=null, remoteStart=false){
  clearTimeout(ballTimer); clearTimeout(hitWindow); audio.stopApproach();
  $('audioState').textContent='LISTEN'; $('directionState').textContent='—';
  if(mode!=='game')return;

  // PRACTICE PATH IS KEPT IDENTICAL TO THE KNOWN-GOOD BUILD.
  const side=sideOverride || (Math.random()<.5?'left':'right');
  $('directionState').textContent=side.toUpperCase();
  const delay=remoteStart ? 120 : 900+Math.random()*900;

  if(!remoteStart && conn?.open) conn.send({type:'rally',side,duration:NORMAL_DURATION,token:++rallyToken});

  ballTimer=setTimeout(()=>{
    incomingSide=side;
    incomingDuration=NORMAL_DURATION;
    impactAt=performance.now()+NORMAL_DURATION;
    audio.ballApproach(side,NORMAL_DURATION);
    $('audioState').textContent='BALL APPROACHING';
    $('pulse').animate([{transform:'scale(.55)',opacity:.12},{transform:'scale(1.05)',opacity:.5}],{duration:NORMAL_DURATION,easing:'cubic-bezier(.2,.8,.1,1)'});
    hitWindow=setTimeout(()=>resolvePoint(null,false,side),1360);
  },delay);
}

function startRemoteBall(side,duration,token){
  if(mode!=='game')return;
  clearTimeout(ballTimer); clearTimeout(hitWindow); audio.stopApproach();
  const cleanSide=side==='left'?'left':'right';
  incomingSide=cleanSide;
  incomingDuration=Number(duration)===FAST_DURATION?FAST_DURATION:NORMAL_DURATION;
  if(token!=null)rallyToken=token;
  impactAt=performance.now()+incomingDuration;
  $('directionState').textContent=cleanSide.toUpperCase();
  $('audioState').textContent='BALL APPROACHING';
  audio.ballApproach(cleanSide,incomingDuration);
  $('pulse').animate([{transform:'scale(.55)',opacity:.12},{transform:'scale(1.05)',opacity:.5}],{duration:incomingDuration,easing:'cubic-bezier(.2,.8,.1,1)'});
  hitWindow=setTimeout(()=>resolvePoint(null,false,cleanSide),incomingDuration+360);
}

function handleSwing(){
  const ev=motion.consumeSwing();
  if(!ev)return;

  const side=incomingSide;
  if(!side)return;

  const faceDot=Number.isFinite(ev.faceDot)?ev.faceDot:0;
  const now=performance.now();
  const dt=Math.abs((ev.t||now)-impactAt);

  // UNCHANGED swing discrimination.
  const requiredFace=side==='right' ? 1 : -1;
  const faceDotThreshold=0.20;
  const correctFace=requiredFace===1 ? faceDot>=faceDotThreshold : faceDot<=-faceDotThreshold;
  const timingWindowMs=800;
  const timingScore=clampNumber(1-(dt/timingWindowMs),0,1);
  const valid=correctFace && timingScore>0.04;

  if(!valid){
    audio.miss();
    $('audioState').textContent=!correctFace
      ? (side==='left'?`MISS — BACKHAND REQUIRED (face ${faceDot.toFixed(2)})`:`MISS — FOREHAND REQUIRED (face ${faceDot.toFixed(2)})`)
      : 'MISS — TOO EARLY / LATE';
    setTimeout(()=>beginPoint(),800);
    return;
  }

  // PRACTICE MODE: EXACTLY THE OLD BEHAVIOR. Speed is NOT injected here.
  if(!conn?.open){
    audio.hit(side,ev.quality);
    $('audioState').textContent=side==='right'?'FOREHAND HIT':'BACKHAND HIT';
    resolvePoint(localPlayer,false,side,true);
    return;
  }

  // LIVE MULTIPLAYER: the outgoing shot gets exactly NORMAL (1.0 s) or FAST (0.5 s).
  const speed=swingSpeedScore(ev);
  const nextDuration=durationFromSpeed(speed);
  const nextSide=Math.random()<0.5?'left':'right';
  const token=rallyToken;

  audio.hit(side,ev.quality);
  $('audioState').textContent=`${side==='right'?'FOREHAND':'BACKHAND'} HIT · ${nextDuration===FAST_DURATION?'FAST':'NORMAL'}`;

  clearTimeout(ballTimer); clearTimeout(hitWindow); audio.stopApproach();
  incomingSide=null; impactAt=0;

  conn.send({type:'shot',side:nextSide,duration:nextDuration,token});
}

function clampNumber(v,a,b){return Math.max(a,Math.min(b,v));}
function resolvePoint(winner,remote=false,side=null,hit=false){
  clearTimeout(ballTimer);clearTimeout(hitWindow);audio.stopApproach();
  if(winner===null){audio.miss();$('audioState').textContent='MISS';setTimeout(beginPoint,850);return;}
  const result=match.point(winner);updateScore();$('audioState').textContent=hit?'CLEAN HIT':'POINT';$('directionState').textContent=side?side.toUpperCase():'—';
  if(!remote&&conn?.open)conn.send({type:'point',winner});
  const winnerText=winner===0?'Player 1':'Player 2';
  if(result.gameWon){$('serveLabel').textContent=`${winnerText} WON THE GAME · ${match.server===0?'PLAYER 1':'PLAYER 2'} SERVES`;
    if(result.matchWon){speak(`${winnerText} wins the match.`);return;}
  } else $('serveLabel').textContent=`${match.pointLabel()} · ${match.server===0?'PLAYER 1':'PLAYER 2'} TO SERVE`;
  setTimeout(()=>{if(mode==='game')beginPoint();},1150);
}
function stopGame(){mode='lobby';clearTimeout(ballTimer);clearTimeout(hitWindow);audio.stopApproach();if(wakeLock){wakeLock.release().catch(()=>{});wakeLock=null;}if(conn){try{conn.close()}catch{}}if(peer){try{peer.destroy()}catch{}}conn=null;peer=null;roomCode='';$('joinBox').classList.add('hidden');$('roomBox').classList.add('hidden');}

// Register PWA service worker only on HTTPS (GitHub Pages is HTTPS).
if('serviceWorker' in navigator && location.protocol==='https:') navigator.serviceWorker.register('./sw.js').catch(()=>{});
