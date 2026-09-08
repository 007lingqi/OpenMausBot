import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CONTAINED_CANDIDATE_ROOT } from "./contained-patch-protocol.ts";
import { runContainedPatchWorker, superviseContainedProposal } from "./contained-patch-worker-core.ts";
import { CodexReadOnlyPatchProvider } from "./docker-patch-agent.ts";
import { relayLaunchConfiguration, type ManagedService } from "./docker-service-supervisor.ts";

function relayProcess(child: ChildProcess, url: string): ManagedService {
  const exited = new Promise<number>(resolve => { child.once("error", () => resolve(1)); child.once("exit", code => resolve(code ?? 1)); });
  child.stdin?.on("error", () => {});
  const ready = new Promise<void>((resolve, reject) => {
    let output = "", done = false;
    const fail = () => { if (!done) { done = true; reject(Error("contained_relay_unavailable")); } };
    child.once("error", fail); child.once("exit", fail);
    if (!child.stdout) return fail();
    child.stdout.once("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      if (done) return;
      if (Buffer.byteLength(output) + chunk.length > 4096) return fail();
      output += chunk.toString("utf8");
      if (!output.includes("\n")) return;
      try {
        const report = JSON.parse(output.trim());
        if (report.event !== "model_channel_ready" || report.mode !== "relay" || report.url !== url) return fail();
        done = true; resolve();
      } catch { fail(); }
    });
  });
  return { exited, ready, stop: () => { child.stdin?.end(); } };
}

export async function runContainedWorkerMain(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || !existsSync("/.dockerenv")) throw Error("contained_worker_container_required");
  const privateRoot = lstatSync("/run/omb-private"), control = lstatSync("/run/omb-control");
  if (!privateRoot.isDirectory() || privateRoot.uid !== 0 || (privateRoot.mode & 0o777) !== 0o700 ||
    !control.isDirectory() || control.uid !== 0 || (control.mode & 0o777) !== 0o711) throw Error("contained_private_mount_invalid");
  const config = relayLaunchConfiguration({ OMB_OPENCODEX_RELAY_ENABLED: "1", OMB_OPENCODEX_RELAY_PORT: "18100",
    OMB_OPENCODEX_RELAY_SOCKET: "/run/omb-channel/model.sock", OMB_OPENCODEX_RELAY_UID: environment.OMB_OPENCODEX_RELAY_UID,
    OMB_OPENCODEX_RELAY_GID: environment.OMB_OPENCODEX_RELAY_GID })!;
  const stop = new AbortController(), abort = () => stop.abort();
  process.once("SIGTERM", abort); process.once("SIGINT", abort);
  try {
    await runContainedPatchWorker({ controlDirectory: "/run/omb-control", candidateRoot: CONTAINED_CANDIDATE_ROOT, signal: stop.signal,
      propose: async request => {
        // This callback is unreachable before the coordinator has registered
        // the real task proof and opened the model gate.
        const provider = new CodexReadOnlyPatchProvider({ model: "gpt-6-astra", reasoningEffort: "medium", openCodexEndpoint: config.url,
          exchangeRoot: "/tmp/provider-state", providerHome: "/tmp", providerUid: 10001, providerGid: 10001,
          launcher: { executable: "/usr/bin/setpriv", args: ["--reuid=10001", "--regid=10001", "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs"] } });
        const channel = "/opt/openmausbot/collaboration/operations/opencodex-model-channel.js";
        return superviseContainedProposal({ signal: request.signal,
          startRelay: () => relayProcess(spawn("/usr/bin/setpriv", [...config.args, process.execPath, channel, ...config.channelArgs],
            { env: config.environment, stdio: ["pipe", "pipe", "ignore"] }), config.url),
          propose: () => provider.propose(request), interrupt: () => provider.interrupt(request.runId),
        });
      },
    });
  } finally { process.off("SIGTERM", abort); process.off("SIGINT", abort); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // Exiting PID 1 tears down the entire task namespace, even double-forked
  // provider processes or a frozen relay. Never run this entrypoint on a host.
  runContainedWorkerMain().then(() => process.exit(0), () => { process.stderr.write("contained_task_failed\n"); process.exit(1); });
}
