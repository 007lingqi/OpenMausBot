import { describe, expect, it, vi } from "vitest";
import type { DWClientDownStream } from "dingtalk-stream";

import {
  RealDingTalkStreamSdk,
  type DingTalkStreamClientPort,
} from "./stream-sdk.ts";

class FakeDingTalkClient implements DingTalkStreamClientPort {
  connected: boolean;
  reconnecting: boolean;
  connectCalls: number;
  disconnectCalls: number;
  acknowledgeError: Error | null;
  connectGate: Promise<void> | null;

  constructor() {
    this.connected = false;
    this.reconnecting = false;
    this.connectCalls = 0;
    this.disconnectCalls = 0;
    this.acknowledgeError = null;
    this.connectGate = null;
  }

  registerCallbackListener(_topic: string, _callback: (message: DWClientDownStream) => void): void {}

  async connect(): Promise<void> {
    this.connectCalls += 1;
    await this.connectGate;
    this.connected = true;
    this.reconnecting = false;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  socketCallBackResponse(_messageId: string, _result: { status: string }): void {
    if (this.acknowledgeError) throw this.acknowledgeError;
  }

  onSystem(message: DWClientDownStream): void {
    if (message.headers.topic === "disconnect") this.connected = false;
  }
}

function systemDisconnect() {
  return {
    specVersion: "1.0",
    type: "SYSTEM",
    headers: {
      appId: "app",
      connectionId: "connection",
      contentType: "application/json",
      messageId: "message",
      time: "1",
      topic: "disconnect",
    },
    data: "{}",
  };
}

describe("real DingTalk Stream recovery wrapper", () => {
  it("reconnects when DingTalk sends a business-level disconnect frame", async () => {
    const client = new FakeDingTalkClient();
    const sdk = new RealDingTalkStreamSdk(
      { clientId: "id", clientSecret: "secret" },
      undefined,
      () => client,
    );
    await sdk.connect();

    client.onSystem(systemDisconnect());

    await vi.waitFor(() => expect(client.connectCalls).toBe(2));
    expect(sdk.state()).toBe("connected");
  });

  it("reconnects and preserves redelivery when callback acknowledgement fails", async () => {
    const client = new FakeDingTalkClient();
    const sdk = new RealDingTalkStreamSdk(
      { clientId: "id", clientSecret: "secret" },
      undefined,
      () => client,
    );
    await sdk.connect();
    client.acknowledgeError = new Error("socket_not_open");

    expect(() => sdk.acknowledge("transport-message")).toThrow("socket_not_open");

    await vi.waitFor(() => expect(client.connectCalls).toBe(2));
    expect(sdk.state()).toBe("connected");
  });

  it("does not reopen the socket when shutdown races an in-flight reconnect", async () => {
    const client = new FakeDingTalkClient();
    const sdk = new RealDingTalkStreamSdk(
      { clientId: "id", clientSecret: "secret" },
      undefined,
      () => client,
    );
    await sdk.connect();
    let releaseReconnect: (() => void) | undefined;
    client.connectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    client.acknowledgeError = new Error("socket_not_open");

    expect(() => sdk.acknowledge("transport-message")).toThrow("socket_not_open");
    await vi.waitFor(() => expect(client.connectCalls).toBe(2));
    sdk.disconnect();
    releaseReconnect!();
    await vi.waitFor(() => expect(client.connected).toBe(false));
    expect(sdk.state()).toBe("stopped");
  });
});
