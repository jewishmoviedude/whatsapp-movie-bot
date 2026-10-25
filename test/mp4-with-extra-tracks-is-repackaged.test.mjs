// "Daniel Sloss - Live Shows - S01E01-02" was an H.264/AAC mp4 carrying over
// a dozen mov_text subtitle tracks. The bot judged it "already a compatible
// mp4" and posted it untouched on 2026-10-12, and WhatsApp told every member
// who opened it "This file was sent in an unusual format that may indicate it
// is dangerous, corrupted, or otherwise not supported on WhatsApp" (A. Ito's
// #issue #group04; the operator: "Can you look into another way for encoding
// files that get this error?"). An mp4 with anything beyond one video and one
// sound is now repackaged with just those two (a remux: seconds, no quality
// lost), and only a clean one is sent as it is.
import { planConversion } from '../src/media/ffmpeg.js';

let fails = 0;
const ok = (c, n) => { if (!c) { fails++; console.error('FAIL', n); } else console.log('ok', n); };

const cfg = { maxOutputBytes: 2_000_000_000, strategy: 'auto' };
const sloss = { size: 328_222_445, container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264' }, audio: { codec: 'aac' }, extraStreams: 18 };

const p = planConversion(sloss, cfg);
ok(p.action === 'remux' && /18 more stream/.test(p.reason), `an mp4 with 18 subtitle tracks is remuxed (${p.action}: ${p.reason})`);
ok(planConversion({ ...sloss, extraStreams: 0 }, cfg).action === 'copy', 'a clean mp4 is still sent as it is');
ok(planConversion({ ...sloss, extraStreams: undefined }, cfg).action === 'copy', 'a probe from before extraStreams existed is read as clean');
ok(planConversion({ ...sloss, extraStreams: 2 }, { ...cfg, strategy: 'copy-only' }).action === 'remux', 'copy-only remuxes it too, since a remux is a copy');
ok(planConversion({ ...sloss, extraStreams: 0 }, { ...cfg, strategy: 'copy-only' }).action === 'copy', 'copy-only still copies a clean mp4');
ok(planConversion({ ...sloss, size: 3e9 }, cfg).action === 'encode', 'too big is still encoded, extra tracks or not');
ok(planConversion({ ...sloss, video: { codec: 'hevc' } }, cfg).action === 'encode', 'a codec phones cannot play is still encoded');

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
