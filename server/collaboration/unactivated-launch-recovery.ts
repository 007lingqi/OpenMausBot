import type { ContainmentBinding } from "./containment.ts";

export interface UnactivatedLaunchContext {
  coordinatorFingerprint: string;
  assertCurrent(): void;
  signal?: AbortSignal;
}
export type UnactivatedLaunchOutcome = { state: "blocked"; reason: string } | {
  state: "aborted_before_activation";
  containerId: string;
  bindingHash: string;
  launchHash: string;
  deniedGateHash: string;
};
export interface UnactivatedLaunchRecoveryPort {
  /** Caller has verified the original coordinator stopped and there is no task
   * proof. MUST await mutations; never abandon kill or file persistence on timeout. */
  recover(binding: ContainmentBinding, context: UnactivatedLaunchContext): Promise<UnactivatedLaunchOutcome>;
}
