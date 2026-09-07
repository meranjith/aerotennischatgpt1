function clamp(x,a,b){return Math.max(a,Math.min(b,x));}

export class AudioEngine {
  constructor(){this.ctx=null;this.master=null;this.ambient=null;this.current=null;this.activeVoice=0;}

  async init(){
    if(this.ctx){if(this.ctx.state==='suspended') await this.ctx.resume();return;}
    const C=window.AudioContext||window.webkitAudioContext;
    if(!C)throw new Error('Web Audio is not supported on this browser.');
    this.ctx=new C();
    this.master=this.ctx.createGain(); this.master.gain.value=.72; this.master.connect(this.ctx.destination);
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
    this.stopApproach();
    const t=this.ctx.currentTime;
    const sec=duration/1000;
    const voice=++this.activeVoice;

    const merger=this.ctx.createChannelMerger(2);
    const leftBus=this.ctx.createGain(), rightBus=this.ctx.createGain();

    // HARD left/right isolation. The non-target ear receives zero signal.
    leftBus.gain.value=side==='left'?1:0;
    rightBus.gain.value=side==='right'?1:0;
    leftBus.connect(merger,0,0);
    rightBus.connect(merger,0,1);
    merger.connect(this.master);

    const g=this.ctx.createGain();
    const filter=this.ctx.createBiquadFilter();
    const osc=this.ctx.createOscillator();

    filter.type='bandpass';
    filter.frequency.value=1500;
    filter.Q.value=.75;

    // 1.0 s approach envelope. The audio routing remains hard-isolated to one ear.
    g.gain.setValueAtTime(.0001,t);
    g.gain.exponentialRampToValueAtTime(.035,t+Math.min(.18,sec*.10));
    g.gain.exponentialRampToValueAtTime(.18,t+sec*.72);
    g.gain.exponentialRampToValueAtTime(.8,t+sec);

    osc.type='sawtooth';
    osc.frequency.setValueAtTime(95,t);
    osc.frequency.exponentialRampToValueAtTime(340,t+sec);
    osc.detune.value=side==='left'?-4:4;

    // Short broadband component gives the approach a less synthetic, more ball-like texture.
    const noise=this.ctx.createBufferSource();
    const buf=this.ctx.createBuffer(1,Math.max(1,Math.floor(this.ctx.sampleRate*.8)),this.ctx.sampleRate);
    const data=buf.getChannelData(0);
    for(let i=0;i<data.length;i++) data[i]=(Math.random()*2-1)*Math.pow(1-i/data.length,1.4);
    noise.buffer=buf;
    const ng=this.ctx.createGain();
    ng.gain.setValueAtTime(.0001,t);
    ng.gain.exponentialRampToValueAtTime(.05,t+sec*.65);
    ng.gain.exponentialRampToValueAtTime(.52,t+sec);

    noise.connect(ng).connect(filter);
    osc.connect(filter).connect(g);
    g.connect(side==='left'?leftBus:rightBus);

    // Prevent an old scheduled voice from surviving into a new point.
    const stop=()=>{
      if(voice!==this.activeVoice)return;
      const now=this.ctx.currentTime;
      try{
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(Math.max(g.gain.value,.0001),now);
        g.gain.exponentialRampToValueAtTime(.0001,now+.015);
      }catch{}
      try{noise.stop(now+.02);}catch{}
      try{osc.stop(now+.02);}catch{}
    };

    noise.start(t);
    osc.start(t);
    osc.stop(t+sec+.03);

    this.current={stop};
    return duration;
  }

  stopApproach(){
    if(this.current){
      const old=this.current;
      this.current=null;
      try{old.stop();}catch{}
    }
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
