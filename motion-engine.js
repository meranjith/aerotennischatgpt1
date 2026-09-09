// AeroTennis v2 motion controller.
// Design goal: classify ONLY two strokes (forehand/backhand) and two speeds
// (normal/fast). Orientation is taken from DeviceOrientation; no integrated
// gyro quaternion is used, eliminating drift from repeated gyro integration.

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function len3(v) { return Math.hypot(v.x, v.y, v.z); }
function dot3(a, b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
function norm3(v) {
  const m = len3(v) || 1;
  return {x:v.x/m, y:v.y/m, z:v.z/m};
}
function cross3(a,b) { return {x:a.y*b.z-a.z*b.y, y:a.z*b.x-a.x*b.z, z:a.x*b.y-a.y*b.x}; }

function qMul(a,b) {
  return {
    w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z,
    x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,
    y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
    z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w
  };
}
function qInv(q) { return {w:q.w,x:-q.x,y:-q.y,z:-q.z}; }
function qNorm(q) {
  const m=Math.hypot(q.w,q.x,q.y,q.z)||1;
  return {w:q.w/m,x:q.x/m,y:q.y/m,z:q.z/m};
}
function qRotate(q,v) {
  const p={w:0,x:v.x,y:v.y,z:v.z};
  const r=qMul(qMul(q,p),qInv(q));
  return {x:r.x,y:r.y,z:r.z};
}

// DeviceOrientation's alpha/beta/gamma representation converted to a
// quaternion using the standard intrinsic Z-X-Y sequence.
function orientationToQuaternion(alpha,beta,gamma) {
  const a=(alpha||0)*DEG/2, b=(beta||0)*DEG/2, g=(gamma||0)*DEG/2;
  const sa=Math.sin(a), ca=Math.cos(a);
  const sb=Math.sin(b), cb=Math.cos(b);
  const sg=Math.sin(g), cg=Math.cos(g);
  return qNorm({
    w: ca*cb*cg + sa*sb*sg,
    x: ca*sb*cg + sa*cb*sg,
    y: ca*cb*sg - sa*sb*cg,
    z: sa*cb*cg - ca*sb*sg
  });
}

export class MotionEngine {
  constructor() {
    this.state = {
      permission:false,
      calibrated:false,
      referenceQ:null,
      currentQ:null,
      faceDot:1,
      face:'screen',
      forwardAccel:0,
      rawForwardAccel:0,
      rotRate:0,
      confidence:0,
      swing:null,
      orientation:{alpha:0,beta:0,gamma:0}
    };

    this.listeners=[];
    this.boundOrientation=e=>this._onOrientation(e);
    this.boundMotion=e=>this._onMotion(e);
    this.lastMotionTime=0;
    this.lastForward=0;
    this.filteredForward=0;
    this.gravityDevice=null;
    this.peak=0;
    this.peakTime=0;
    this.peakFaceDot=1;
    this.armedAt=0;
    this.refractoryUntil=0;
    this.samples=[];
    this.lastOrientationAt=0;
  }

  on(fn) { this.listeners.push(fn); return ()=>{this.listeners=this.listeners.filter(x=>x!==fn);}; }
  emit() { for(const fn of this.listeners) fn(this.state); }

  async requestPermission() {
    if (!window.isSecureContext) throw new Error('AeroTennis requires HTTPS (GitHub Pages is supported).');

    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const p=await DeviceOrientationEvent.requestPermission(true);
      if(p!=='granted') throw new Error('Orientation permission denied.');
    }
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const p=await DeviceMotionEvent.requestPermission();
      if(p!=='granted') throw new Error('Motion permission denied.');
    }

    window.addEventListener('deviceorientation',this.boundOrientation,{passive:true});
    // Some browsers expose an absolute variant; use it when available, but
    // keep the normal event as the universal fallback.
    window.addEventListener('deviceorientationabsolute',this.boundOrientation,{passive:true});
    window.addEventListener('devicemotion',this.boundMotion,{passive:true});
    this.state.permission=true;
    return true;
  }

  calibrate() {
    if(!this.state.currentQ) throw new Error('Waiting for orientation sensor data. Hold the phone still and try again.');
    this.state.referenceQ=qNorm(this.state.currentQ);
    this.state.calibrated=true;
    this._resetDetector();
    this._updateFace();
    this.emit();
  }

  _resetDetector() {
    this.samples=[];
    this.filteredForward=0;
    this.lastForward=0;
    this.peak=0;
    this.peakTime=0;
    this.armedAt=0;
    this.refractoryUntil=performance.now()+250;
  }

  _onOrientation(e) {
    if(!Number.isFinite(e.alpha)||!Number.isFinite(e.beta)||!Number.isFinite(e.gamma)) return;
    const q=orientationToQuaternion(e.alpha,e.beta,e.gamma);
    this.state.currentQ=q;
    this.state.orientation={alpha:e.alpha,beta:e.beta,gamma:e.gamma};
    this.lastOrientationAt=performance.now();
    if(this.state.calibrated) this._updateFace();
    this.emit();
  }

  _updateFace() {
    const ref=this.state.referenceQ, cur=this.state.currentQ;
    if(!ref||!cur) return;
    const rel=qMul(qInv(ref),cur);
    const screenForward=qRotate(rel,{x:0,y:0,z:1});
    const d=clamp(screenForward.z,-1,1);
    this.state.faceDot=d;
    // Wide deadband + hysteresis: edge is never accepted as a stroke face.
    const prev=this.state.face;
    if(prev==='screen') this.state.face=d < 0.05 ? 'edge' : 'screen';
    else if(prev==='back') this.state.face=d > -0.05 ? 'edge' : 'back';
    else this.state.face=d >= 0.12 ? 'screen' : d <= -0.12 ? 'back' : 'edge';
  }

  _onMotion(e) {
    if(!this.state.calibrated || !this.state.currentQ) return;
    const now=performance.now();
    const dt=Math.max(0.001,Math.min(0.08,(now-this.lastMotionTime||16)/1000));
    this.lastMotionTime=now;

    const aRaw=e.acceleration;
    const aInc=e.accelerationIncludingGravity;
    let aDev=null;
    if(aRaw && [aRaw.x,aRaw.y,aRaw.z].every(Number.isFinite)) {
      aDev={x:aRaw.x,y:aRaw.y,z:aRaw.z};
    } else if(aInc && [aInc.x,aInc.y,aInc.z].every(Number.isFinite)) {
      // Estimate gravity from the calibrated Earth direction transformed into
      // the phone frame, then remove it from accelerationIncludingGravity.
      const rel=qMul(qInv(this.state.referenceQ),this.state.currentQ);
      const gravityWorld={x:0,y:-9.80665,z:0};
      const gravityRel=qRotate(qInv(rel),gravityWorld);
      aDev={x:aInc.x-gravityRel.x,y:aInc.y-gravityRel.y,z:aInc.z-gravityRel.z};
    } else return;

    const ref=this.state.referenceQ, cur=this.state.currentQ;
    const rel=qMul(qInv(ref),cur);
    const aRef=qRotate(qInv(rel),aDev);
    const rawFwd=aRef.z;

    // Low-pass physical acceleration only enough to suppress sensor spikes;
    // preserve the impact peak.
    const alpha=clamp(dt/0.055,0.08,0.85);
    this.filteredForward += alpha*(rawFwd-this.filteredForward);
    const fwd=Math.max(0,this.filteredForward);
    const rr=e.rotationRate;
    const rot=rr ? Math.hypot(rr.alpha||0,rr.beta||0,rr.gamma||0) : 0;

    this.state.rawForwardAccel=rawFwd;
    this.state.forwardAccel=fwd;
    this.state.rotRate=rot;
    this.state.confidence=Math.round(clamp((fwd/8)*100,0,100));

    this.samples.push({t:now,f:fwd,dot:this.state.faceDot,rot});
    while(this.samples.length && now-this.samples[0].t>180) this.samples.shift();

    this._detectSwing(now);
    this.emit();
  }

  _detectSwing(now) {
    if(now<this.refractoryUntil || now-this.lastMotionTime<0) return;

    // The arm threshold is deliberately reachable on real phones. We then
    // wait for a local peak instead of declaring a hit on the first sample.
    const TRIGGER=2.8;
    const PEAK_MIN=4.0;
    const RELEASE_RATIO=0.70;
    const WINDOW=150;

    const f=this.filteredForward;
    if(f>=TRIGGER && !this.armedAt) {
      this.armedAt=now;
      this.peak=f;
      this.peakTime=now;
      this.peakFaceDot=this.state.faceDot;
    }

    if(!this.armedAt) return;

    if(f>this.peak) {
      this.peak=f;
      this.peakTime=now;
      this.peakFaceDot=this.state.faceDot;
    }

    const elapsed=now-this.armedAt;
    const released=f <= this.peak*RELEASE_RATIO;
    const timedOut=elapsed>=WINDOW;

    if((released||timedOut) && this.peak>=PEAK_MIN) {
      const peakSample=this.samples.reduce((best,s)=>Math.abs(s.t-this.peakTime)<Math.abs(best.t-this.peakTime)?s:best,this.samples[0]||{t:now,dot:this.state.faceDot,f:this.peak,rot:this.state.rotRate});
      const quality=clamp((this.peak-PEAK_MIN)/7,0,1);
      const speedFast=this.peak>=6.6;
      const faceDot=peakSample.dot;
      const face=faceDot>=0.12?'screen':faceDot<=-0.12?'back':'edge';

      this.state.swing={
        t:this.peakTime,
        forwardAccel:this.peak,
        faceDot,
        face,
        rotRate:peakSample.rot,
        quality,
        speed:speedFast?'fast':'normal'
      };
      this.armedAt=0;
      this.peak=0;
      this.refractoryUntil=now+260;
    }
  }

  consumeSwing() {
    const s=this.state.swing;
    this.state.swing=null;
    return s;
  }

  snapshot() { return typeof structuredClone==='function' ? structuredClone(this.state) : JSON.parse(JSON.stringify(this.state)); }
}

export { orientationToQuaternion, qMul, qInv, qRotate, norm3, dot3, cross3, clamp };
