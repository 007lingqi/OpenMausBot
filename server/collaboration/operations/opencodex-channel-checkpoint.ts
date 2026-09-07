import {constants,closeSync,fstatSync,fsyncSync,lstatSync,openSync,readSync,realpathSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
import type {SshChannelCheckpoint,SshChannelCheckpointStore} from './opencodex-ssh-channel.ts';

/** Private host state only. Call after acquiring the channel's fixed listener
 * port, which is the single-writer lock. No request content or credentials. */
export function createChannelCheckpoint(options:{path:string;port:number}):SshChannelCheckpointStore {
  const unavailable=():never=>{throw new Error('ssh_channel_checkpoint_unavailable');};
  const path=options.path,parent=dirname(path),uid=process.getuid?.();
  if(uid===undefined||!isAbsolute(path)||resolve(path)!==path||path.includes('\0')||Buffer.byteLength(path)>512||
    !Number.isSafeInteger(options.port)||options.port<1||options.port>65535)unavailable();
  const checkParent=()=>{
    const stat=lstatSync(parent);
    if(!stat.isDirectory()||stat.uid!==uid||(stat.mode&0o777)!==0o700||realpathSync(parent)!==parent)unavailable();
  };
  const decode=(raw:string):SshChannelCheckpoint=>{
    const value=JSON.parse(raw);
    if(!value||Array.isArray(value)||typeof value!=='object'||
      Object.keys(value).sort().join(',')!=='attempts,generation,port,version'||value.version!==1||value.port!==options.port||
      typeof value.generation!=='string'||! /^[a-zA-Z0-9:_-]{1,200}$/.test(value.generation)||
      !Number.isInteger(value.attempts)||value.attempts<0||value.attempts>3)unavailable();
    return {generation:value.generation,attempts:value.attempts};
  };
  const disk=():{raw:string;value:SshChannelCheckpoint}|null=>{
    checkParent();
    let stat;
    try{stat=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    if(!stat.isFile()||stat.uid!==uid||(stat.mode&0o777)!==0o600||stat.nlink!==1||stat.size>4096)unavailable();
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const opened=fstatSync(fd);
      if(!opened.isFile()||opened.uid!==uid||(opened.mode&0o777)!==0o600||opened.nlink!==1||opened.size>4096||
        opened.dev!==stat.dev||opened.ino!==stat.ino)unavailable();
      const bytes=Buffer.alloc(4097),length=readSync(fd,bytes,0,bytes.length,0);
      if(length>4096||length!==opened.size)unavailable();
      const raw=bytes.subarray(0,length).toString('utf8');return {raw,value:decode(raw)};
    }finally{closeSync(fd);}
  };
  let saved:ReturnType<typeof disk>;
  try{saved=disk();}catch{return unavailable();}
  return {read:()=>saved?{...saved.value}:null,write(value){
    let temp:string|undefined,fd:number|undefined,directory:number|undefined;
    try{
      const raw=JSON.stringify({version:1,port:options.port,generation:value.generation,attempts:value.attempts})+'\n';
      const decoded=decode(raw);
      if(disk()?.raw!==saved?.raw)unavailable();
      temp=join(parent,`.${basename(path)}.${randomUUID()}.tmp`);
      fd=openSync(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      writeFileSync(fd,raw);fsyncSync(fd);closeSync(fd);fd=undefined;
      // Recheck ownership and the prior value before replacing anything.
      if(disk()?.raw!==saved?.raw)unavailable();
      renameSync(temp,path);temp=undefined;
      checkParent();directory=openSync(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      fsyncSync(directory);closeSync(directory);directory=undefined;
      saved={raw,value:decoded};
    }catch{unavailable();}
    finally{
      if(fd!==undefined)closeSync(fd);if(directory!==undefined)closeSync(directory);
      if(temp)try{unlinkSync(temp);}catch{/* Only our unique temporary file; never remove an existing checkpoint. */}
    }
  }};
}
