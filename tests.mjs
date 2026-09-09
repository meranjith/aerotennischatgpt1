import assert from 'node:assert/strict';
import {orientationToQuaternion,qInv,qMul,qRotate} from './motion-engine.js';
import {NORMAL_MS,FAST_MS,durationForSpeed,shotIsValidForSide,sanitizeShot} from './rally-core.js';
import {TennisMatch} from './game-logic.js';

function run(){
  for(let i=0;i<10;i++){
    const q=orientationToQuaternion(0,0,0);
    assert.ok(Math.abs(Math.hypot(q.w,q.x,q.y,q.z)-1)<1e-9);
    const fx=qRotate({w:0,x:1,y:0,z:0},{x:0,y:0,z:1});
    assert.ok(fx.z < -0.999);
    const flip={w:0,x:1,y:0,z:0};
    assert.ok(qRotate(flip,{x:0,y:0,z:1}).z < -0.999);
    const identity=qMul(qInv(q),q);
    assert.ok(Math.abs(identity.w-1)<1e-9);

    assert.equal(durationForSpeed('normal'),NORMAL_MS);
    assert.equal(durationForSpeed('fast'),FAST_MS);
    assert.equal(durationForSpeed('garbage'),NORMAL_MS);
    assert.equal(shotIsValidForSide('right','screen'),true);
    assert.equal(shotIsValidForSide('right','back'),false);
    assert.equal(shotIsValidForSide('left','back'),true);
    assert.equal(shotIsValidForSide('left','screen'),false);

    const sh=sanitizeShot({pointId:7,seq:3,target:1,side:'left',speed:'fast',duration:9999});
    assert.deepEqual(sh,{type:'SHOT',pointId:7,seq:3,target:1,side:'left',speed:'fast',duration:FAST_MS});

    const m=new TennisMatch();
    assert.equal(m.pointLabel(),'LOVE - LOVE');
    m.point(0);m.point(0);m.point(0);assert.equal(m.pointLabel(),'40 - LOVE');
    m.point(1);m.point(1);m.point(1);assert.equal(m.pointLabel(),'DEUCE');
    m.point(0);assert.equal(m.pointLabel(),'ADVANTAGE P1');
    m.point(1);assert.equal(m.pointLabel(),'DEUCE');
    m.point(0);m.point(0);assert.equal(m.games[0],1);assert.equal(m.server,1);
  }
}
run();
console.log('10x theoretical logic pass: OK');
