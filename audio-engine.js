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
    if(!this.ctx) throw new Error('Audio not initialized');

    // Exactly one approach voice may exist at a time.
    // A duplicate call while a voice is already playing is ignored so an
    // accidental second event can never switch the ball from one ear to the other.
    if(this.current?.active) return duration;

    const t=this.ctx.currentTime;
    const sec=Math.max(0.05,duration/1000);
    const voice=++this.activeVoice;
    const isLeft=side==='left';

    // One mono approach source is deliberately hard-routed into exactly one
    // stereo output channel. There is no pan interpolation and therefore no
    // possibility of the approach itself moving from left to right.
    const merger=this.ctx.createChannelMerger(2);
    const leftBus=this.ctx.createGain();
    const rightBus=this.ctx.createGain();
    leftBus.gain.setValueAtTime(isLeft?1:0,t);
    rightBus.gain.setValueAtTime(isLeft?0:1,t);
    leftBus.connect(merger,0,0);
    rightBus.connect(merger,0,1);
    merger.connect(this.master);

    const g=this.ctx.createGain();
    const filter=this.ctx.createBiquadFilter();
    const osc=this.ctx.createOscillator();
    filter.type='bandpass';
    filter.frequency.setValueAtTime(1500,t);
    filter.Q.setValueAtTime(.75,t);

    // Exact 1-second approach envelope.
    g.gain.setValueAtTime(.0001,t);
    g.gain.exponentialRampToValueAtTime(.035,t+Math.min(.18,sec*.10));
    g.gain.exponentialRampToValueAtTime(.18,t+sec*.72);
    g.gain.exponentialRampToValueAtTime(.8,t+sec);

    // The pitch rises as the ball gets closer, giving distance/proximity information.
    osc.type='sawtooth';
    osc.frequency.setValueAtTime(95,t);
    osc.frequency.exponentialRampToValueAtTime(340,t+sec);
    osc.detune.setValueAtTime(isLeft?-4:4,t);

    const noise=this.ctx.createBufferSource();
    const buf=this.ctx.createBuffer(
      1,
      Math.max(1,Math.floor(this.ctx.sampleRate*sec)),
      this.ctx.sampleRate
    );
    const data=buf.getChannelData(0);
    for(let i=0;i<data.length;i++){
      const fade=1-(i/data.length);
      data[i]=(Math.random()*2-1)*Math.pow(Math.max(0,fade),1.4);
    }
    noise.buffer=buf;

    const ng=this.ctx.createGain();
    ng.gain.setValueAtTime(.0001,t);
    ng.gain.exponentialRampToValueAtTime(.05,t+sec*.65);
    ng.gain.exponentialRampToValueAtTime(.52,t+sec);

    noise.connect(ng).connect(filter);
    osc.connect(filter).connect(g);
    g.connect(isLeft?leftBus:rightBus);

    let active=true;
    const stop=()=>{
      if(!active) return;
      active=false;
      if(this.current?.voice===voice) this.current=null;

      const now=this.ctx.currentTime;

      // HARD MUTE THE ROUTE FIRST. This prevents any stale audio from being
      // heard from the old ear while the AudioBuffer/Oscillator nodes stop.
      try{leftBus.gain.cancelScheduledValues(now);leftBus.gain.setValueAtTime(0,now);}catch{}
      try{rightBus.gain.cancelScheduledValues(now);rightBus.gain.setValueAtTime(0,now);}catch{}
      try{g.gain.cancelScheduledValues(now);g.gain.setValueAtTime(.0001,now);}catch{}

      try{noise.stop(now+.005);}catch{}
      try{osc.stop(now+.005);}catch{}
    };

    noise.start(t);
    osc.start(t);
    osc.stop(t+sec+.02);

    this.current={voice,active:true,stop};

    // Release ownership at the natural end. No later callback may resurrect it.
    setTimeout(()=>{
      if(this.current?.voice!==voice) return;
      stop();
    },Math.ceil(sec*1000)+80);

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
