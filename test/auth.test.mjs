/* Multi-admin auth: migration (no lockout), login, account CRUD.
   Run: node test/auth.test.mjs */
import { hashPassword } from '../src/util/crypto.js';
import {
  migrateIfNeeded, needsSetup, setupSuperAdmin, authenticate,
  listAdmins, addAdmin, removeAdmin, resetPassword, findAdmin,
} from '../src/web/auth.js';

let pass=0,fail=0;
const ok=(c,m)=>{c?(pass++,console.log(`  ok   ${m}`)):(fail++,console.log(`  FAIL ${m}`));};

// Minimal in-memory ConfigStore matching the real deep-merge update().
function mockStore(web={}) {
  const cfg={ web:{ admins:[], adminPasswordHash:'', ...web } };
  return {
    get:()=>cfg,
    update:(patch)=>{ if(patch.web) Object.assign(cfg.web, patch.web); return cfg; },
  };
}

console.log('=== migration: legacy password -> super-admin, NO lockout ===');
{
  const cs = mockStore({ adminPasswordHash: hashPassword('oldsecret123') });
  ok(needsSetup(cs)===false, 'legacy password counts as configured (not first-run)');
  migrateIfNeeded(cs);
  const list=listAdmins(cs);
  ok(list.length===1 && list[0].username==='superadmin' && list[0].role==='superadmin', 'created the superadmin account');
  ok(cs.get().web.adminPasswordHash==='', 'legacy hash cleared after migration');
  // THE CRITICAL CHECK: the old password still logs in
  ok(!!authenticate(cs,'superadmin','oldsecret123'), 'OLD PASSWORD STILL WORKS (no lockout)');
  ok(!!authenticate(cs,'','oldsecret123'), 'blank username defaults to superadmin');
  ok(!authenticate(cs,'superadmin','wrong'), 'wrong password rejected');
}

console.log('=== fresh setup ===');
{
  const cs = mockStore();
  ok(needsSetup(cs)===true, 'no accounts -> needs setup');
  setupSuperAdmin(cs, 'brandnew123');
  ok(needsSetup(cs)===false, 'after setup, no longer first-run');
  ok(!!authenticate(cs,'superadmin','brandnew123'), 'setup password authenticates');
  let threw=false; try{ setupSuperAdmin(cs,'x'); }catch{threw=true;}
  // setup on an already-configured store is prevented at the API layer; here just check short pw
  const cs2=mockStore(); try{ setupSuperAdmin(cs2,'short'); }catch{threw=true;}
  ok(threw, 'short password rejected');
}

console.log('=== account CRUD (super-admin) ===');
{
  const cs = mockStore(); setupSuperAdmin(cs,'superpass123');
  addAdmin(cs,'moe','moepass123','admin');
  ok(!!authenticate(cs,'moe','moepass123'), 'added admin can log in');
  ok(authenticate(cs,'moe','moepass123').role==='admin', 'added admin has admin role');
  ok(findAdmin(cs,'MOE'), 'username lookup is case-insensitive');

  let dup=false; try{ addAdmin(cs,'moe','other12345'); }catch{dup=true;}
  ok(dup,'duplicate username rejected');
  let badu=false; try{ addAdmin(cs,'bad user!','pass12345'); }catch{badu=true;}
  ok(badu,'invalid username rejected');

  resetPassword(cs,'moe','newmoepass9');
  ok(!authenticate(cs,'moe','moepass123') && !!authenticate(cs,'moe','newmoepass9'),'reset password works');

  removeAdmin(cs,'moe');
  ok(!authenticate(cs,'moe','newmoepass9'),'removed admin cannot log in');
}

console.log('=== cannot remove the last super-admin ===');
{
  const cs = mockStore(); setupSuperAdmin(cs,'superpass123');
  let threw=false; try{ removeAdmin(cs,'superadmin'); }catch{threw=true;}
  ok(threw,'last super-admin is protected');
  addAdmin(cs,'admin2','adminpass12','superadmin');
  removeAdmin(cs,'superadmin');   // now allowed, another super exists
  ok(listAdmins(cs).length===1 && listAdmins(cs)[0].username==='admin2','can remove a super-admin when another exists');
}

console.log('=== password hashes never appear in listAdmins ===');
{
  const cs=mockStore(); setupSuperAdmin(cs,'superpass123');
  ok(listAdmins(cs).every(a=>!('passwordHash' in a)),'listAdmins strips passwordHash');
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
