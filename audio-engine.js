function clamp(x,a,b){return Math.max(a,Math.min(b,x));}

export class AudioEngine {
  constructor(){this.ctx=null;this.master=null;this.ambient=null;this.current=null;this.activeVoice=0;this._boundResume=()=>this._resumeIfNeeded();}

  async init(){
    if(this.ctx){if(this.ctx.state==='suspended') await this.ctx.resume();return;}
    const C=window.AudioContext||window.webkitAudioContext;
    if(!C)throw new Error('Web Audio is not supported on this browser.');
    this.ctx=new C();
    this.master=this.ctx.createGain(); this.master.gain.value=.72; this.master.connect(this.ctx.destination);
    document.addEventListener('visibilitychange',this._boundResume,{passive:true});
    window.addEventListener('pageshow',this._boundResume,{passive:true});
    window.addEventListener('focus',this._boundResume,{passive:true});
  }

  _resumeIfNeeded(){
    if(this.ctx?.state==='suspended') this.ctx.resume().catch(()=>{});
  }

  stereoTest(){
    if(!this.ctx)throw new Error('Audio not initialized');
    this._tone(-1,480,0.45,0.28); setTimeout(()=>this._tone(1,760,0.45,0.28),700);
  }

  _tone(pan,freq,dur,gain){
    const t=this.ctx.currentTime;
    const osc=this.ctx.createOscillator(), g=this.ctx.createGain();
    const left=this.ctx.createGain(), right=this.ctx.createGain();
    const merger=this.ctx.createChannelMerger(2);

    // Explicit channel routing: do not depend on browser-specific StereoPanner behavior.
    left.gain.value=pan<0?1:0;
    right.gain.value=pan>0?1:0;

    osc.frequency.value=freq;
    g.gain.setValueAtTime(.0001,t);
    g.gain.exponentialRampToValueAtTime(gain,t+.02);
    g.gain.exponentialRampToValueAtTime(.0001,t+dur);

    osc.connect(g);
    g.connect(left); g.connect(right);
    left.connect(merger,0,0); right.connect(merger,0,1);
    merger.connect(this.master);
    osc.start(t); osc.stop(t+dur+.03);
  }

  ballApproach(side,duration=1000){
    if(!this.ctx) throw new Error('Audio not initialized');
    this._resumeIfNeeded();
    if(this.current?.active) return duration;

    const sec=Math.max(0.05,duration/1000);
    const t=this.ctx.currentTime;
    const voice=++this.activeVoice;
    const isLeft=side==='left';

    // One immutable stereo buffer for the entire approach.
    // The requested ear contains the complete signal; the opposite ear is zero.
    // No live panning, oscillator, filter, gain envelope, or second source exists.
    const frames=Math.ceil(this.ctx.sampleRate*sec)+32;
    const buffer=this.ctx.createBuffer(2,frames,this.ctx.sampleRate);
    const L=buffer.getChannelData(0);
    const R=buffer.getChannelData(1);

    let seed=(voice*1664525+1013904223)>>>0;
    const rnd=()=>{
      seed=(1664525*seed+1013904223)>>>0;
      return (seed/4294967296)*2-1;
    };

    for(let i=0;i<frames;i++){
      const p=Math.min(1,i/(frames-1));
      const envIn=Math.min(1,p/0.08);
      const envOut=Math.min(1,(1-p)/0.055);
      const env=envIn*envOut;

      // Airy tennis-ball approach: filtered-ish noise approximation + rising body tone.
      const white=rnd();
      const air=rnd()*0.55 + white*0.45;
      const freq=92 + 250*Math.pow(p,1.65);
      const phase=2*Math.PI*freq*(i/this.ctx.sampleRate);
      const tonal=(Math.sin(phase)*0.42 + Math.sin(phase*1.97)*0.13);

      // Progressive intensity: quiet at distance, clearly louder at impact.
      const intensity=0.018 + 0.78*Math.pow(p,1.55);
      const sample=(air*0.13 + tonal*0.16)*intensity*env;

      if(isLeft) L[i]=sample;
      else R[i]=sample;
    }

    const src=this.ctx.createBufferSource();
    src.buffer=buffer;
    src.connect(this.master);

    let active=true;
    const finish=()=>{
      if(!active)return;
      active=false;
      if(this.current?.voice===voice)this.current=null;
    };

    src.onended=finish;
    this.current={voice,active:true,stop:()=>{
      if(!active)return;
      try{src.stop();}catch{}
      finish();
    }};

    src.start(t);
    return duration;
  }

  stopApproach(){
    const cur=this.current;
    if(!cur)return;
    // Clear ownership BEFORE stopping nodes so any re-entrant call cannot
    // attach to the old voice.
    this.current=null;
    try{cur.stop();}catch{}
  }

  hit(side,quality=0.7){
    this.stopApproach();
    const t=this.ctx.currentTime;
    const isLeft=side==='left';
    const merger=this.ctx.createChannelMerger(2);
    const leftBus=this.ctx.createGain(), rightBus=this.ctx.createGain();
    leftBus.gain.value=isLeft?1:0; rightBus.gain.value=isLeft?0:1;
    leftBus.connect(merger,0,0); rightBus.connect(merger,0,1); merger.connect(this.master);

    // Tennis-ball strike: short noisy felt contact + low resonant body thump.
    const noise=this.ctx.createBufferSource();
    const buf=this.ctx.createBuffer(1,this.ctx.sampleRate*.15,this.ctx.sampleRate);
    const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*Math.exp(-i/this.ctx.sampleRate/.032);
    noise.buffer=buf;
    const ng=this.ctx.createGain();
    ng.gain.setValueAtTime(.45+.45*quality,t);
    ng.gain.exponentialRampToValueAtTime(.0001,t+.11);
    noise.connect(ng).connect(isLeft?leftBus:rightBus);
    noise.start(t);

    const o=this.ctx.createOscillator(),og=this.ctx.createGain();
    o.type='sine';
    o.frequency.setValueAtTime(145,t);
    o.frequency.exponentialRampToValueAtTime(72,t+.16);
    og.gain.setValueAtTime(.12+.12*quality,t);
    og.gain.exponentialRampToValueAtTime(.0001,t+.18);
    o.connect(og).connect(isLeft?leftBus:rightBus);
    o.start(t); o.stop(t+.2);
  }

  miss(){ this._tone(0,130,0.18,.12); }
}
