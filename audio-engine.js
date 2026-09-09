// AeroTennis v2 audio engine.
// One approach = one AudioBufferSourceNode. The buffer itself contains the
// complete left/right routed waveform, so direction can never jump mid-sound.

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}

function mulberry32(seed){
  return ()=>{
    let t=seed+=0x6D2B79F5;
    t=Math.imul(t^t>>>15,t|1);
    t^=t+Math.imul(t^t>>>7,t|61);
    return ((t^t>>>14)>>>0)/4294967296;
  };
}

export class AudioEngine {
  constructor(){
    this.ctx=null;
    this.master=null;
    this.currentApproach=null;
    this.approachSerial=0;
    this.masterGain=0.78;
    this.unlocked=false;
  }

  async init(){
    if(this.ctx){
      if(this.ctx.state==='suspended') await this.ctx.resume();
      return;
    }
    const Ctx=window.AudioContext||window.webkitAudioContext;
    if(!Ctx) throw new Error('Web Audio is not supported on this phone/browser.');
    this.ctx=new Ctx({latencyHint:'interactive'});
    this.master=this.ctx.createGain();
    this.master.gain.value=this.masterGain;
    this.master.connect(this.ctx.destination);
    this.unlocked=true;

    const resume=()=>{
      if(this.ctx?.state==='suspended') this.ctx.resume().catch(()=>{});
    };
    document.addEventListener('visibilitychange',resume,{passive:true});
    window.addEventListener('focus',resume,{passive:true});
  }

  async resume(){
    if(!this.ctx) await this.init();
    if(this.ctx.state==='suspended') await this.ctx.resume();
  }

  stereoTest(){
    if(!this.ctx) throw new Error('Audio not initialized.');
    const now=this.ctx.currentTime;
    this._playToneBuffer(-1,now,440,.32);
    this._playToneBuffer(1,now+.65,660,.32);
  }

  _playToneBuffer(side,start,freq,gain){
    const n=Math.floor(this.ctx.sampleRate*.34);
    const buf=this.ctx.createBuffer(2,n,this.ctx.sampleRate);
    const left=buf.getChannelData(0), right=buf.getChannelData(1);
    for(let i=0;i<n;i++){
      const p=i/n;
      const env=Math.sin(Math.PI*p)**1.5;
      const s=Math.sin(2*Math.PI*freq*i/this.ctx.sampleRate)*gain*env;
      if(side<0) left[i]=s; else right[i]=s;
    }
    const src=this.ctx.createBufferSource();
    src.buffer=buf; src.connect(this.master); src.start(start);
  }

  _createApproachBuffer(side,duration){
    const n=Math.max(1,Math.round(this.ctx.sampleRate*duration/1000));
    const buf=this.ctx.createBuffer(2,n,this.ctx.sampleRate);
    const target=buf.getChannelData(side==='left'?0:1);
    const random=mulberry32(side==='left'?0xA3107:0xB6209);

    // Stateful filtered noise + tonal air component. This is rendered into the
    // buffer once; playback itself has no moving filters or gain automation.
    let low=0, band=0;
    for(let i=0;i<n;i++){
      const t=i/this.ctx.sampleRate;
      const p=i/Math.max(1,n-1);
      const white=random()*2-1;
      low += (white-low)*0.018;
      const hp=white-low;
      band += (hp-band)*0.12;
      const air=band*0.72 + low*0.16;
      const freq=105 + 185*p;
      const tonal=Math.sin(2*Math.PI*freq*t)*(0.10+0.26*p);
      const granular=Math.sin(2*Math.PI*(520+720*p)*t + Math.sin(2*Math.PI*7*t)*0.8)*(0.015+0.06*p);
      const ramp=Math.pow(p,2.65);
      const attack=Math.min(1,p/0.015);
      const release=Math.min(1,(1-p)/0.025);
      const env=Math.max(0,Math.min(1,attack,release));
      target[i]=(air*0.20+tonal+granular)*ramp*env;
    }
    // Explicitly zero the non-target channel for every sample.
    const other=buf.getChannelData(side==='left'?1:0);
    other.fill(0);
    return buf;
  }

  ballApproach(side,duration){
    if(!this.ctx) throw new Error('Audio not initialized.');
    if(this.ctx.state==='suspended') this.ctx.resume().catch(()=>{});
    const cleanSide=side==='left'?'left':'right';
    const cleanDuration=duration===500?500:1000;

    // Only one approach voice is allowed. A duplicate request is ignored rather
    // than stopping/restarting the current ball.
    if(this.currentApproach?.active) return false;

    const id=++this.approachSerial;
    const source=this.ctx.createBufferSource();
    source.buffer=this._createApproachBuffer(cleanSide,cleanDuration);
    source.connect(this.master);

    const startedAt=this.ctx.currentTime;
    const seconds=cleanDuration/1000;
    const state={id,active:true,side:cleanSide,duration:cleanDuration,source};
    this.currentApproach=state;

    source.onended=()=>{
      if(this.currentApproach?.id===id){
        this.currentApproach.active=false;
        this.currentApproach=null;
      }
    };
    source.start(startedAt);
    source.stop(startedAt+seconds);
    return true;
  }

  stopApproach(){
    const a=this.currentApproach;
    if(!a) return;
    this.currentApproach=null;
    a.active=false;
    try{a.source.onended=null;}catch{}
    try{a.source.stop();}catch{}
  }

  _oneShotStereoBuffer(kind,side,quality=0.8){
    const sr=this.ctx.sampleRate;
    const duration=kind==='hit'?0.18:0.16;
    const n=Math.floor(sr*duration);
    const buf=this.ctx.createBuffer(2,n,sr);
    const out=buf.getChannelData(side===null?0:(side==='left'?0:1));
    const random=mulberry32(kind==='hit'?0x51A7:0xB00D);
    const mono=kind==='hit'?out:null;
    if(kind==='hit'){
      for(let i=0;i<n;i++){
        const t=i/sr;
        const env=Math.exp(-t/0.032);
        const click=(random()*2-1)*0.75*env;
        const body=Math.sin(2*Math.PI*(145-65*(t/duration))*t)*0.24*env;
        out[i]=(click+body)*(0.65+0.35*quality);
      }
      const other=buf.getChannelData(side==='left'?1:0); other.fill(0);
    } else {
      const l=buf.getChannelData(0),r=buf.getChannelData(1);
      for(let i=0;i<n;i++){
        const s=(Math.random()*2-1)*Math.exp(-i/(sr*0.025))*0.10;
        l[i]=s; r[i]=s;
      }
    }
    return buf;
  }

  hit(side,quality=0.8){
    if(!this.ctx)return;
    this.stopApproach();
    const src=this.ctx.createBufferSource();
    src.buffer=this._oneShotStereoBuffer('hit',side,quality);
    src.connect(this.master); src.start();
  }

  miss(){
    if(!this.ctx)return;
    const src=this.ctx.createBufferSource();
    src.buffer=this._oneShotStereoBuffer('miss',null);
    src.connect(this.master); src.start();
  }
}
