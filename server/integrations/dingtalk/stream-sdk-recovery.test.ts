import { describe, expect, it, vi } from "vitest";
import type { DWClientDownStream } from "dingtalk-stream";

import {
  RealDingTalkStreamSdk,
  type DingTalkStreamClientPort,
} from "./stream-sdk.ts";

class FakeDingTalkClient implements DingTalkStreamClientPort {
  connected: boolean;
  reconnecting: boolean;
  registered = false;
  registerOnConnect = true;
  failConnect = false;
  swallowFailure = false;
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
    if (this.failConnect) {
      if (this.swallowFailure) return;
      throw new Error("offline");
    }
    this.connected = true;
    this.registered = this.registerOnConnect;
    this.reconnecting = false;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
    this.registered = false;
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
  it("keeps an authenticated transport usable when DingTalk sends no REGISTERED frame", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDingTalkClient();
      client.registerOnConnect = false;
      const sdk = new RealDingTalkStreamSdk({ clientId: "id", clientSecret: "secret" }, undefined, () => client);
      await sdk.connect();
      for (let tick = 0; tick < 90; tick++) {
        await vi.advanceTimersByTimeAsync(1_000);
        await sdk.reconnect();
      }
      expect(sdk.state()).toBe("connected");
      expect(client.connectCalls).toBe(1);
      expect(client.disconnectCalls).toBe(0);
      sdk.disconnect();
    } finally { vi.useRealTimers(); }
  });

  it("does not require the optional registered flag or start a vendor reconnect timer", async () => {
    const client = new FakeDingTalkClient();
    client.registerOnConnect = false;
    const factory = vi.fn(() => client);
    const sdk = new RealDingTalkStreamSdk({ clientId: "id", clientSecret: "secret" }, undefined, factory);
    expect(await sdk.connect()).toEqual({ connected: true });
    client.reconnecting = true;
    for (let tick = 0; tick < 60; tick++) await sdk.reconnect();
    expect(client.connectCalls).toBe(1);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ autoReconnect: false }));
    client.registered = true;
    client.reconnecting = false;
    expect(sdk.state()).toBe("connected");
    await sdk.reconnect();
    expect(client.connectCalls).toBe(1);
    sdk.disconnect();
  });

  it("retries actual transport loss, not the absence of a REGISTERED frame", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDingTalkClient();
      client.registerOnConnect = false;
      const sdk = new RealDingTalkStreamSdk({ clientId: "id", clientSecret: "secret" }, undefined, () => client);
      await sdk.connect();
      await vi.advanceTimersByTimeAsync(29_999);
      await sdk.reconnect();
      expect(client.connectCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await sdk.reconnect();
      expect(client.connectCalls).toBe(1);
      expect(client.disconnectCalls).toBe(0);
      client.connected = false;
      client.registered = true; // A stale flag must never make a lost socket ready.
      expect(sdk.state()).toBe("reconnecting");
      await sdk.reconnect();
      expect(client.connectCalls).toBe(2);
      expect(client.disconnectCalls).toBe(0);
      sdk.disconnect();
    } finally { vi.useRealTimers(); }
  });

  it("backs off failed connections and cancels recovery after shutdown", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDingTalkClient();
      client.failConnect = true;
      const sdk = new RealDingTalkStreamSdk({ clientId: "id", clientSecret: "secret" }, undefined, () => client);
      expect(await sdk.connect()).toEqual({ connected: false });
      for (let tick = 0; tick < 60; tick++) await sdk.reconnect();
      expect(client.connectCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await sdk.reconnect();
      expect(client.connectCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(1_999);
      await sdk.reconnect();
      expect(client.connectCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      client.failConnect = false;
      await sdk.reconnect();
      expect(sdk.state()).toBe("connected");
      sdk.disconnect();
      await vi.advanceTimersByTimeAsync(60_000);
      await sdk.reconnect();
      expect(client.connectCalls).toBe(3);
    } finally { vi.useRealTimers(); }
  });

  it("also backs off swallowed SDK failures and caps the interval at one minute", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeDingTalkClient();
      client.failConnect = true;
      client.swallowFailure = true;
      const sdk = new RealDingTalkStreamSdk({ clientId: "id", clientSecret: "secret" }, undefined, () => client);
      await sdk.connect();
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
        const calls = client.connectCalls;
        await vi.advanceTimersByTimeAsync(delay - 1);
        await sdk.reconnect();
        expect(client.connectCalls).toBe(calls);
        await vi.advanceTimersByTimeAsync(1);
        await Promise.all([sdk.reconnect(), sdk.reconnect(), sdk.reconnect()]);
        expect(client.connectCalls).toBe(calls + 1);
      }
      sdk.disconnect();
    } finally { vi.useRealTimers(); }
  });

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
