import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,chmodSync,symlinkSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,it,expect} from 'vitest';
import {clearProviderOwnedHome} from './provider-home-cleanup.ts';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),'provider-home-cleanup-'));roots.push(root);const home=join(root,'home');mkdirSync(home,{mode:0o700});return{root,home};}
describe('provider-owned home cleanup',()=>{
  it('clears private nested directories using the owning identity, retaining the supervisor-owned envelope',async()=>{
    const{home}=fixture();mkdirSync(join(home,'private'));writeFileSync(join(home,'private','state'),'synthetic');chmodSync(join(home,'private'),0o000);
    await clearProviderOwnedHome({home,uid:process.getuid!(),gid:process.getgid!()});
    expect(existsSync(home)).toBe(true);expect(readdirSync(home)).toEqual([]);
  });
  it('unlinks a nested symlink without following it or modifying an outside file',async()=>{
    const{root,home}=fixture(),outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep'),'keep');symlinkSync(outside,join(home,'link'));
    await clearProviderOwnedHome({home,uid:process.getuid!(),gid:process.getgid!()});
    expect(readFileSync(join(outside,'keep'),'utf8')).toBe('keep');expect(readdirSync(home)).toEqual([]);
  });
  it('rejects a symlink root and leaves its target unchanged',async()=>{
    const{root,home}=fixture();writeFileSync(join(home,'keep'),'keep');const link=join(root,'link');symlinkSync(home,link);
    await expect(clearProviderOwnedHome({home:link,uid:process.getuid!(),gid:process.getgid!()})).rejects.toThrow('provider_home_cleanup_failed');
    expect(readFileSync(join(home,'keep'),'utf8')).toBe('keep');
  });
  it('rejects the wrong execution identity without deleting contents',async()=>{
    const{home}=fixture();writeFileSync(join(home,'keep'),'keep');
    await expect(clearProviderOwnedHome({home,uid:process.getuid!()+1,gid:process.getgid!()})).rejects.toThrow('provider_home_cleanup_failed');
    expect(readFileSync(join(home,'keep'),'utf8')).toBe('keep');
  });
});
