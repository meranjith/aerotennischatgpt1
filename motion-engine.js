// AeroTennis motion engine.
// The important rule: a swing is emitted ONCE, at the local acceleration peak.
// Face is measured from the calibrated screen normal, not from raw alpha/beta/gamma.

const DEG=Math.PI/180;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const qMul=(a,b)=>({w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z,x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w});
const qInv=q=>({w:q.w,x:-q.x,y:-q.y,z:-q.z});
const qNorm=q=>{const n=Math.hypot(q.w,q.x,q.y,q.z)||1;return {w:q.w/n,x:q.x/n,y:q.y/n,z:q.z/n};};
const qRotate=(q,v)=>{const p={w:0,x:v.x,y:v.y,z:v.z},r=qMul(qMul(q,p),qInv(q));return {x:r.x,y:r.y,z:r.z};};
const dot3=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
const norm3=v=>{const n=Math.hypot(v.x,v.y,v.z)||1;return {x:v.x/n,y:v.y/n,z:v.z/n};};
const cross3=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});

// DeviceOrientation rotation, following the browser's Z-X-Y convention.
function orientationToQuaternion(alpha=0,beta=0,gamma=0){
  const a=alpha*DEG/2,b=beta*DEG/2,g=gamma*DEG/2;
  const sa=Math.sin(a),ca=Math.cos(a),sb=Math.sin(b),cb=Math.cos(b),sg=Math.sin(g),cg=Math.cos(g);
  return qNorm({
    w:ca*cb*cg-sa*sb*sg,
    x:ca*sb*cg+sa*cb*sg,
    y:ca*cb*sg-sa*sb*cg,
    z:sa*cb*cg+ca*sb*sg
  });
}

export class MotionEngine {
  constructor(){
    this.state={permission:false,calibrated:false,referenceQ:null,currentQ:null,faceDot:1,face:'screen',forwardAccel:0,rawForwardAccel:0,rotRate:0,confidence:0,swing:null,orientation:{alpha:0,beta:0,gamma:0}};
    this.listeners=[];this.lastMotionTime=0;this.filteredForward=0;this.peak=0;this.peakTime=0;this.armedAt=0;this.refractoryUntil=0;this.samples=[];this.lastOrientationAt=0;
    this.boundOrientation=e=>this._onOrientation(e);this.boundMotion=e=>this._onMotion(e);
  }
  on(fn){this.listeners.push(fn);return()=>{this.listeners=this.listeners.filter(x=>x!==fn);};}
  emit(){for(const fn of this.listeners)fn(this.state);}

  async requestPermission(){
    if(!window.isSecureContext)throw new Error('AeroTennis requires HTTPS.');
    if(typeof DeviceOrientationEvent!=='undefined'&&typeof DeviceOrientationEvent.requestPermission==='function'){
      if(await DeviceOrientationEvent.requestPermission()!=='granted')throw new Error('Orientation permission denied.');
    }
    if(typeof DeviceMotionEvent!=='undefined'&&typeof DeviceMotionEvent.requestPermission==='function'){
      if(await DeviceMotionEvent.requestPermission()!=='granted')throw new Error('Motion permission denied.');
    }
    if(!this.state.permission){
      window.addEventListener('deviceorientation',this.boundOrientation,{passive:true});
      window.addEventListener('deviceorientationabsolute',this.boundOrientation,{passive:true});
      window.addEventListener('devicemotion',this.boundMotion,{passive:true});
    }
    this.state.permission=true;return true;
  }

  calibrate(){
    if(!this.state.currentQ)throw new Error('Waiting for orientation sensor data. Hold the phone still.');
    this.state.referenceQ=qNorm(this.state.currentQ);this.state.calibrated=true;this._resetDetector();this._updateFace();this.emit();
  }
  resetForGame(){this.state.swing=null;this._resetDetector();}
  _resetDetector(){this.samples=[];this.filteredForward=0;this.peak=0;this.peakTime=0;this.armedAt=0;this.refractoryUntil=performance.now()+350;this.lastMotionTime=0;}

  _onOrientation(e){
    if(!Number.isFinite(e.alpha)||!Number.isFinite(e.beta)||!Number.isFinite(e.gamma))return;
    this.state.currentQ=orientationToQuaternion(e.alpha,e.beta,e.gamma);
    this.state.orientation={alpha:e.alpha,beta:e.beta,gamma:e.gamma};this.lastOrientationAt=performance.now();
    if(this.state.calibrated)this._updateFace();this.emit();
  }

  _updateFace(){
    const ref=this.state.referenceQ,cur=this.state.currentQ;if(!ref||!cur)return;
    // Compare the actual phone screen normal in world space. This avoids the
    // fragile assumption that alpha alone represents a front/back flip.
    const refNormal=qRotate(ref,{x:0,y:0,z:-1});
    const curNormal=qRotate(cur,{x:0,y:0,z:-1});
    const d=clamp(dot3(refNormal,curNormal),-1,1);
    this.state.faceDot=d;
    if(d>=0.35)this.state.face='screen';
    else if(d<=-0.35)this.state.face='back';
    else this.state.face='edge';
  }

  _onMotion(e){
    if(!this.state.calibrated||!this.state.currentQ)return;
    const now=performance.now();
    const dt=this.lastMotionTime?clamp((now-this.lastMotionTime)/1000,.005,.06):.016;this.lastMotionTime=now;
    let a=null;
    if(e.acceleration&&[e.acceleration.x,e.acceleration.y,e.acceleration.z].every(Number.isFinite))a={x:e.acceleration.x,y:e.acceleration.y,z:e.acceleration.z};
    else if(e.accelerationIncludingGravity&&[e.accelerationIncludingGravity.x,e.accelerationIncludingGravity.y,e.accelerationIncludingGravity.z].every(Number.isFinite)){
      // In the calibrated frame, gravity is known to point down in world space.
      const ref=this.state.referenceQ,cur=this.state.currentQ;
      const gDevice=qRotate(qInv(cur),{x:0,y:-9.80665,z:0});
      const inc=e.accelerationIncludingGravity;a={x:inc.x-gDevice.x,y:inc.y-gDevice.y,z:inc.z-gDevice.z};
    } else return;

    // Convert acceleration to the calibrated device frame.
    const rel=qMul(qInv(this.state.referenceQ),this.state.currentQ);
    const aRef=qRotate(rel,a);
    const raw=Math.abs(aRef.z);
    const alpha=clamp(dt/.045,.12,.9);
    this.filteredForward+=alpha*(raw-this.filteredForward);
    const f=Math.max(0,this.filteredForward);
    const rr=e.rotationRate;const rot=rr?Math.hypot(rr.alpha||0,rr.beta||0,rr.gamma||0):0;
    this.state.rawForwardAccel=raw;this.state.forwardAccel=f;this.state.rotRate=rot;this.state.confidence=Math.round(clamp((f/7)*100,0,100));
    this.samples.push({t:now,f,dot:this.state.faceDot,rot});while(this.samples.length&&now-this.samples[0].t>220)this.samples.shift();
    this._detectSwing(now);this.emit();
  }

  _detectSwing(now){
    if(now<this.refractoryUntil)return;
    const TRIGGER=2.6,PEAK_MIN=3.8,RELEASE=.68,WINDOW=220;
    const f=this.filteredForward;
    if(!this.armedAt&&f>=TRIGGER){this.armedAt=now;this.peak=f;this.peakTime=now;}
    if(!this.armedAt)return;
    if(f>this.peak){this.peak=f;this.peakTime=now;}
    const elapsed=now-this.armedAt;
    if((f<=this.peak*RELEASE||elapsed>=WINDOW)&&this.peak>=PEAK_MIN){
      const peak=this.samples.reduce((best,s)=>Math.abs(s.t-this.peakTime)<Math.abs(best.t-this.peakTime)?s:best,this.samples[0]);
      const quality=clamp((this.peak-PEAK_MIN)/6,0,1);
      this.state.swing={t:this.peakTime,forwardAccel:this.peak,faceDot:peak.dot,face:peak.dot>=0.35?'screen':peak.dot<=-0.35?'back':'edge',rotRate:peak.rot,quality,speed:this.peak>=6.3?'fast':'normal'};
      this.armedAt=0;this.peak=0;this.peakTime=0;this.refractoryUntil=now+380;
    }
  }
  consumeSwing(){const s=this.state.swing;this.state.swing=null;return s;}
  snapshot(){return structuredClone?structuredClone(this.state):JSON.parse(JSON.stringify(this.state));}
}
export {orientationToQuaternion,qMul,qInv,qRotate,norm3,dot3,cross3,clamp};
