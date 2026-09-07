import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { containmentBindingHash, type ContainmentBinding } from "../containment.ts";
import type { UnactivatedLaunchContext, UnactivatedLaunchOutcome, UnactivatedLaunchRecoveryPort } from "../unactivated-launch-recovery.ts";
import { dockerLaunchPayload, readDockerLaunch, reserveLaunchAbortKill, sealUnactivatedLaunch } from "./docker-launch.ts";
import type { DockerCliContainmentSupervisor } from "./docker-containment.ts";

export class DockerUnactivatedLaunchRecovery implements UnactivatedLaunchRecoveryPort {
  private readonly options: { exchangeRoot: string; image: string; containment: DockerCliContainmentSupervisor };
  constructor(options: DockerUnactivatedLaunchRecovery["options"]) {
    if (!isAbsolute(options.exchangeRoot) || !/^sha256:[a-f0-9]{64}$/u.test(options.image)) throw Error("abort_configuration_invalid");
    this.options = options;
  }
  async recover(binding: ContainmentBinding, context: UnactivatedLaunchContext): Promise<UnactivatedLaunchOutcome> {
    const current = () => { context.signal?.throwIfAborted(); context.assertCurrent(); };
    try {
      current();
      if (binding.commandId !== undefined || !/^[a-f0-9]{64}$/u.test(context.coordinatorFingerprint)) throw Error("abort_not_authorized");
      const name = "omb-task-" + createHash("sha256").update(JSON.stringify(binding)).digest("hex").slice(0, 48);
      const directory = join(this.options.exchangeRoot, name), record = readDockerLaunch(directory);
      if (record.launch.image !== this.options.image) throw Error("abort_image_not_current");
      const supervisor = this.options.containment;
      const before = await supervisor.inspectUnactivatedLaunch(record.launch, binding, directory, record.containerId); current();
      if (before.state !== "observed") throw Error("abort_identity_unconfirmed");
      const deniedGateHash = sealUnactivatedLaunch(directory, record.launch); current();
      if (before.status === "active") {
        reserveLaunchAbortKill(directory, record.launch, before.containerId); current();
        await supervisor.stopUnactivatedLaunch(record.launch, binding, directory, before.containerId, current); current();
      }
      const after = await supervisor.inspectUnactivatedLaunch(record.launch, binding, directory, before.containerId); current();
      if (after.state !== "observed" || after.status === "active" || sealUnactivatedLaunch(directory, record.launch) !== deniedGateHash)
        throw Error("abort_exit_unconfirmed");
      // Do NOT remove container or directory: this gate also denies a delayed
      // start that was already submitted to the daemon by the old coordinator.
      return { state: "aborted_before_activation", containerId: before.containerId, bindingHash: containmentBindingHash(binding),
        launchHash: createHash("sha256").update(dockerLaunchPayload(record.launch)).digest("hex"), deniedGateHash };
    } catch { return { state: "blocked", reason: "unactivated_launch_unconfirmed" }; }
  }
}
