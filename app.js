import {MotionEngine} from './motion-engine.js';
import {AudioEngine} from './audio-engine.js';
import {TennisMatch} from './game-logic.js';

const $=id=>document.getElementById(id);
const motion=new MotionEngine();
const audio=new AudioEngine();
const match=new TennisMatch();
let wakeLock=null, mode='lobby', localPlayer=0, peer=null, conn=null, roomCode='', ballTimer=null, hitWindow=null;
let incomingSide=null, incomingFrom=null, incomingServe=false, incomingDuration=1000, impactAt=0, rallyToken=null, pointActive=false;

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
  conn.on('open',()=>{
    mode='game';
    show('screenGame');
    $('modeLabel').textContent='LIVE MATCH';
    $('serveLabel').textContent=`${match.server===0?'PLAYER 1':'PLAYER 2'} TO SERVE`;
    toast('Peer connection established.');
    if(localPlayer===1 && conn.open)conn.send({type:'ready'});
    if(localPlayer===0)beginPoint();
  });
  conn.on('data',msg=>{
    if(!msg || mode!=='game')return;
    if(msg.type==='point'){
      if(rallyToken && msg.token && msg.token!==rallyToken)return;
      if(!pointActive && !rallyToken)return;
      resolvePoint(msg.winner,true,msg.side||null,false,msg.token||rallyToken);
      return;
    }
    if(msg.type==='start'){
      if(msg.target!==localPlayer)return;
      startIncomingBall(msg.side,msg.duration||1000,null,true,msg.token);
      return;
    }
    if(msg.type==='shot'){
      if(msg.target!==localPlayer)return;
      if(!rallyToken || msg.token!==rallyToken)return;
      startIncomingBall(msg.side,msg.duration,msg.from,false,msg.token);
      return;
    }
    if(msg.type==='ready'){
      if(localPlayer===0 && !pointActive)beginPoint();
    }
  });
}
function createRoom(){
  const code=randomCode(); roomCode=code; initPeer(`aerotennis-${code}` ,true); $('roomBox').classList.remove('hidden'); $('roomCode').textContent=code; $('roomStatus').textContent='Waiting for Player 2…'; toast(`Match code ${code}`);
}
function joinRoom(code){
  roomCode=code; peer=new Peer(undefined,{debug:0}); peer.on('open',()=>{conn=peer.connect(`aerotennis-${code}`,{reliable:true});localPlayer=1;wireConnection();}); peer.on('error',e=>toast('Could not join that room. Check the code and host status.'));
}

const NORMAL_DURATION=1000;
const FAST_DURATION=500;
const FAST_SWING_THRESHOLD=0.58;
function swingSpeedScore(ev){
  // Relative stroke speed: forward thrust is dominant, wrist rotation is a
  // secondary indicator. This does NOT alter swing detection or face logic.
  const accelScore=clampNumber((Math.max(0,Number(ev.forwardAccel)||0)-1.5)/8.5,0,1);
  const rotationScore=clampNumber((Math.abs(Number(ev.rotRate)||0))/4.5,0,1);
  return clampNumber(0.72*accelScore+0.28*rotationScore,0,1);
}
function durationFromSpeed(score){
  // Only two gameplay speeds for now:
  // Normal shot = exactly 1.0 s, Fast shot = exactly 0.5 s.
  // The threshold is deliberately centralized so it can be tuned later
  // without touching swing detection or face discrimination.
  return Number(score) >= FAST_SWING_THRESHOLD ? FAST_DURATION : NORMAL_DURATION;
}
function clearBallState(){
  clearTimeout(ballTimer);
  clearTimeout(hitWindow);
  ballTimer=null;
  hitWindow=null;
  audio.stopApproach();
  incomingSide=null;
  incomingFrom=null;
  incomingServe=false;
  incomingDuration=1000;
  impactAt=0;
}
function makeRallyToken(){
  return `p${match.gameNumber}-${match.pointCount+1}`;
}
function beginPoint(){
  clearBallState();
  if(mode!=='game')return;

  pointActive=true;
  rallyToken=makeRallyToken();
  const server=match.server;
  const side=Math.random()<.5?'left':'right';
  const duration=1000; // neutral serve speed; the serve itself determines the next ball speed.
  $('audioState').textContent='READY';
  $('directionState').textContent=server===localPlayer?'SERVE':'WAITING';
  $('serveLabel').textContent=`${server===0?'PLAYER 1':'PLAYER 2'} TO SERVE`;

  if(mode==='practice' || server===localPlayer){
    const delay=mode==='practice' ? 700 : 900+Math.random()*900;
    ballTimer=setTimeout(()=>startIncomingBall(side,duration,null,true,rallyToken),delay);
  }else if(conn?.open){
    conn.send({type:'start',target:server,side,duration,token:rallyToken});
  }
}
function startIncomingBall(side,duration=1000,from=null,serve=false,token=null){
  if(mode!=='game')return;
  if(token && rallyToken && token!==rallyToken)return;

  clearTimeout(ballTimer);
  clearTimeout(hitWindow);
  ballTimer=null;
  hitWindow=null;
  audio.stopApproach();

  if(token)rallyToken=token;
  pointActive=true;
  incomingSide=side==='left'?'left':'right';
  incomingFrom=(Number.isInteger(from)?from:null);
  incomingServe=Boolean(serve);
  incomingDuration=Number(duration)===FAST_DURATION ? FAST_DURATION : NORMAL_DURATION;

  $('audioState').textContent='BALL APPROACHING';
  $('directionState').textContent=incomingSide.toUpperCase();

  // Audio and impact timing share exactly the same duration.
  audio.ballApproach(incomingSide,incomingDuration);
  $('pulse').animate(
    [{transform:'scale(.55)',opacity:.12},{transform:'scale(1.05)',opacity:.5}],
    {duration:incomingDuration,easing:'cubic-bezier(.2,.8,.1,1)'}
  );

  impactAt=performance.now()+incomingDuration;
  const timeout=incomingDuration+360;
  hitWindow=setTimeout(()=>missIncomingBall(),timeout);
}
function missIncomingBall(){
  if(!incomingSide || !pointActive)return;
  const winner=incomingServe ? (match.server^1) : incomingFrom;
  const token=rallyToken;
  if(winner!==0 && winner!==1){
    // Defensive fallback: if an inconsistent remote state is ever received,
    // award the point to the opponent of the current player rather than
    // silently continuing a broken rally.
    resolvePoint(localPlayer^1,false,incomingSide,false,token);
  }else{
    resolvePoint(winner,false,incomingSide,false,token);
  }
}
async function startGame(newMode,player){
  mode='game';localPlayer=player;show('screenGame');$('modeLabel').textContent=newMode==='practice'?'WALL MODE':'LIVE MATCH';$('p1Name').textContent='P1';$('p2Name').textContent=newMode==='practice'?'WALL':'P2';updateScore();await speak(`Ready. ${localPlayer===0?'Player 1':'Player 2'} to serve.`);beginPoint();}
function updateScore(){ $('p1Score').textContent=match.pointLabel().split(' - ')[0].replace('LOVE','0').replace('15','15').replace('30','30').replace('40','40').replace('DEUCE','40').replace('ADVANTAGE P1','40'); $('p2Score').textContent=match.pointLabel().split(' - ')[1]?.replace('LOVE','0').replace('15','15').replace('30','30').replace('40','40').replace('ADVANTAGE P2','40')||'40'; }
async function speak(t){ if(!('speechSynthesis' in window))return; speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(t);u.rate=.88;u.pitch=.78;speechSynthesis.speak(u); }
function handleSwing(){
  const ev=motion.consumeSwing();
  if(!ev || !incomingSide || !pointActive)return;

  const side=incomingSide;
  const faceDot=Number.isFinite(ev.faceDot)?ev.faceDot:0;
  const now=performance.now();
  const dt=Math.abs((ev.t||now)-impactAt);

  // Preserve the proven face discrimination exactly:
  // RIGHT ball -> screen-forward; LEFT ball -> back-panel-forward.
  const requiredFace=side==='right' ? 1 : -1;
  const faceDotThreshold=0.20;
  const correctFace=requiredFace===1
    ? faceDot>=faceDotThreshold
    : faceDot<=-faceDotThreshold;

  // Faster shots require a tighter reaction window. The sensor detection itself
  // is unchanged; only the acceptable timing window follows ball speed.
  const timingWindowMs=clampNumber(incomingDuration*0.65,300,800);
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
    const token=rallyToken;
    setTimeout(()=>{
      if(pointActive && incomingSide)missIncomingBall();
    },120);
    return;
  }

  const speed=swingSpeedScore(ev);
  const nextDuration=durationFromSpeed(speed);
  const nextSide=Math.random()<.5?'left':'right';
  const token=rallyToken;
  const from=localPlayer;

  audio.hit(side,ev.quality);
  $('audioState').textContent=`${side==='right'?'FOREHAND':'BACKHAND'} HIT · ${(speed*100).toFixed(0)}% SPEED`;

  // The current ball has been struck; it is no longer ours. Only the next
  // receiver is allowed to generate a point outcome.
  clearTimeout(ballTimer);
  clearTimeout(hitWindow);
  ballTimer=null;
  hitWindow=null;
  audio.stopApproach();
  incomingSide=null;
  incomingFrom=null;
  incomingServe=false;
  impactAt=0;

  if(mode==='practice'){
    // Wall return: the same measured swing speed controls the return flight.
    pointActive=true;
    setTimeout(()=>startIncomingBall(nextSide,nextDuration,localPlayer,false,token),120);
    return;
  }

  if(conn?.open){
    conn.send({
      type:'shot',
      target:localPlayer^1,
      from,
      side:nextSide,
      duration:nextDuration,
      speed,
      token
    });
  }
}

function clampNumber(v,a,b){return Math.max(a,Math.min(b,v));}
function resolvePoint(winner,remote=false,side=null,hit=false,token=null){
  if(token && rallyToken && token!==rallyToken)return;
  if(!pointActive)return;

  clearBallState();
  pointActive=false;
  const resolvedToken=rallyToken;
  rallyToken=null;

  if(winner===null){
    audio.miss();
    $('audioState').textContent='MISS';
    setTimeout(()=>{if(mode==='game')beginPoint();},850);
    return;
  }

  const result=match.point(winner);
  updateScore();
  $('audioState').textContent=hit?'CLEAN HIT':'POINT';
  $('directionState').textContent=side?side.toUpperCase():'—';

  if(!remote&&conn?.open)conn.send({type:'point',winner,side,token:resolvedToken});

  const winnerText=winner===0?'Player 1':'Player 2';
  if(result.gameWon){
    $('serveLabel').textContent=`${winnerText} WON THE GAME · ${match.server===0?'PLAYER 1':'PLAYER 2'} SERVES`;
    if(result.matchWon){speak(`${winnerText} wins the match.`);return;}
  }else{
    $('serveLabel').textContent=`${match.pointLabel()} · ${match.server===0?'PLAYER 1':'PLAYER 2'} TO SERVE`;
  }
  setTimeout(()=>{if(mode==='game')beginPoint();},1150);
}
function stopGame(){mode='lobby';clearBallState();pointActive=false;rallyToken=null;clearTimeout(ballTimer);clearTimeout(hitWindow);audio.stopApproach();if(wakeLock){wakeLock.release().catch(()=>{});wakeLock=null;}if(conn){try{conn.close()}catch{}}if(peer){try{peer.destroy()}catch{}}conn=null;peer=null;roomCode='';$('joinBox').classList.add('hidden');$('roomBox').classList.add('hidden');}

// Register PWA service worker only on HTTPS (GitHub Pages is HTTPS).
if('serviceWorker' in navigator && location.protocol==='https:') navigator.serviceWorker.register('./sw.js').catch(()=>{});
