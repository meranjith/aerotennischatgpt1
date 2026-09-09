// Pure, deterministic rally rules used by both practice and multiplayer.
export const NORMAL_MS=1000;
export const FAST_MS=500;

export function normalizeSide(v){ return v==='left'?'left':'right'; }
export function normalizeSpeed(v){ return v==='fast'?'fast':'normal'; }
export function durationForSpeed(v){ return normalizeSpeed(v)==='fast'?FAST_MS:NORMAL_MS; }
export function shotIsValidForSide(side,face){
  return normalizeSide(side)==='right' ? face==='screen' : face==='back';
}
export function nextRandomSide(rng=Math.random){ return rng()<0.5?'left':'right'; }
export function sanitizeShot(msg){
  return {
    type:'SHOT',
    pointId:Number.isInteger(msg?.pointId)?msg.pointId:0,
    seq:Number.isInteger(msg?.seq)?msg.seq:0,
    target:msg?.target===1?1:0,
    side:normalizeSide(msg?.side),
    speed:normalizeSpeed(msg?.speed),
    duration:durationForSpeed(msg?.speed)
  };
}
