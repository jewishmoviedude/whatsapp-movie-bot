/* Conversion planning + size targeting.  Run: node test/media.test.mjs */
import { targetVideoBitrate, planConversion, fmtBytes, ENCODE_PROFILES, effectiveEncode } from '../src/media/ffmpeg.js';
let pass=0,fail=0;
const ok=(c,m)=>{c?(pass++,console.log(`  ok   ${m}`)):(fail++,console.log(`  FAIL ${m}`));};
const cfg={maxOutputBytes:1932735283,audioBitrateK:128,strategy:'auto',maxHeight:720};

console.log('=== size targeting stays under the 2GB WhatsApp cap ===');
for(const [label,mins] of [['80 min',80],['90 min',90],['2 hours',120],['2.5 hours',150],['3 hours',180],['3.5 hours',210],['4 hours',240]]){
  const secs=mins*60, bps=targetVideoBitrate(secs,cfg);
  const predicted=(bps+cfg.audioBitrateK*1000)*secs/8;
  ok(predicted<=cfg.maxOutputBytes,
    `${label.padEnd(9)} ${String(Math.round(bps/1000)).padStart(4)}kbps -> ${fmtBytes(predicted).padStart(8)} (${(predicted/cfg.maxOutputBytes*100).toFixed(1)}% of cap)`);
}

console.log('\n=== bitrate floor/ceiling ===');
ok(targetVideoBitrate(36000,cfg)===400000,'absurdly long input clamps to the 400kbps floor');
ok(targetVideoBitrate(60,cfg)===8000000,'very short input clamps to the 8Mbps ceiling');

console.log('\n=== conversion planning picks the cheapest route ===');
const mk=(size,container,v,a,h=1080)=>({size,container,video:{codec:v,height:h},audio:{codec:a}});
ok(planConversion(mk(1.2e9,'mov,mp4,m4a','h264','aac'),cfg).action==='copy','compatible mp4 under cap -> copy (instant)');
ok(planConversion(mk(1.2e9,'matroska,webm','h264','aac'),cfg).action==='remux','mkv, good codecs, under cap -> remux (seconds)');
ok(planConversion(mk(9e9,'matroska,webm','h264','aac'),cfg).action==='encode','9GB -> encode');
ok(planConversion(mk(1.2e9,'matroska,webm','hevc','ac3'),cfg).action==='encode','hevc/ac3 -> encode');
ok(planConversion(mk(1.2e9,'mov,mp4,m4a','h264','aac'),{...cfg,strategy:'always-transcode'}).action==='encode','always-transcode overrides');
ok(planConversion(mk(9e9,'matroska,webm','h264','aac'),{...cfg,strategy:'copy-only'}).action==='reject','copy-only + oversized -> reject, not a silent bad send');


console.log('=== encode profiles ===');
ok(effectiveEncode({encodeProfile:'fast'}).maxHeight===480 && effectiveEncode({encodeProfile:'fast'}).preset==='ultrafast','fast -> 480p/ultrafast');
ok(effectiveEncode({encodeProfile:'balanced'}).maxHeight===720 && effectiveEncode({encodeProfile:'balanced'}).preset==='veryfast','balanced -> 720p/veryfast');
ok(effectiveEncode({encodeProfile:'quality'}).preset==='faster','quality -> faster');
{ const c=effectiveEncode({encodeProfile:'custom',preset:'slow',maxHeight:1080}); ok(c.preset==='slow'&&c.maxHeight===1080,'custom -> raw fields'); }
{ const n=effectiveEncode({preset:'medium',maxHeight:576}); ok(n.preset==='medium'&&n.maxHeight===576,'no profile -> raw fields'); }
ok(Object.keys(ENCODE_PROFILES).length===3,'three named profiles');

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
