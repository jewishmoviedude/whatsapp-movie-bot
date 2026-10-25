/* History upsert dedup. Run: node test/history.test.mjs */
import plugin from '../src/plugins/movie-requests/index.js';
let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  ok   '+m)):(fail++,console.log('  FAIL '+m));};
const data={history:[]};
const ctx={store:{get:(k,d)=>data[k]??d, set:(k,v)=>{data[k]=v;}}};
const rec={id:'m1',status:'queued',title:'X'};
plugin.upsertHistory(ctx,rec);
ok(data.history.length===1,'first upsert adds');
rec.status='sent';
plugin.upsertHistory(ctx,rec);
ok(data.history.length===1,'same id updates in place (no duplicate)');
ok(data.history[0].status==='sent','reflects latest status');
// snapshot, not live ref: mutating rec after upsert must not change stored
rec.status='mutated-later';
ok(data.history[0].status==='sent','stored a snapshot, not a live reference');
plugin.upsertHistory(ctx,{id:'m2',status:'sent'});
ok(data.history.length===2 && data.history[0].id==='m2','new id unshifts to front');
console.log(pass+' passed, '+fail+' failed'); process.exit(fail?1:0);
