// Installed beside a fixed, verified bundle; never import the mutable build tree.
// launchd restarts unexpected process death. Configuration/startup/cleanup errors
// instead park here with a static failure event, without retrying any operation.
const stop=new AbortController();
const terminate=()=>stop.abort();
process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
try{
 const channel=await import('./opencodex-model-channel.mjs');
 const args=process.argv.slice(2),config=channel.parseModelChannelArgs(args);
 if(config.mode!=='bridge'||!config.stateFile)throw new Error('service_configuration_invalid');
 if(!stop.signal.aborted)await channel.runModelChannel(args);
}catch{
 process.stderr.write('model_channel_service_failed\n');
 if(!stop.signal.aborted){
  const keepAlive=setInterval(()=>{},60000);
  try{await new Promise(resolve=>stop.signal.addEventListener('abort',resolve,{once:true}));}
  finally{clearInterval(keepAlive);}
 }
}finally{
 process.off('SIGTERM',terminate);process.off('SIGINT',terminate);
}
