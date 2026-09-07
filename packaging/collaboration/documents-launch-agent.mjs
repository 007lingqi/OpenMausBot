// Installed beside a fixed verified bundle. Failures park without reissuing reads or creating a restart loop.
const stop = new AbortController(), terminate = () => stop.abort();
process.once('SIGTERM', terminate); process.once('SIGINT', terminate);
try {
  const channel = await import('./online-document-bridge.mjs');
  const args = process.argv.slice(2), config = channel.parseOnlineDocumentChannelArgs(args);
  if (config.mode !== 'bridge' || !config.stateFile) throw new Error('service_configuration_invalid');
  if (!stop.signal.aborted) await channel.runOnlineDocumentChannel(args);
} catch {
  process.stderr.write('document_channel_service_failed\n');
  if (!stop.signal.aborted) {
    const keepAlive = setInterval(() => {}, 60000);
    try { await new Promise(resolve => stop.signal.addEventListener('abort', resolve, { once: true })); }
    finally { clearInterval(keepAlive); }
  }
} finally { process.off('SIGTERM', terminate); process.off('SIGINT', terminate); }
