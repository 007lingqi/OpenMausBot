import {
  DWClient,
  TOPIC_CARD,
  TOPIC_ROBOT,
  type DWClientDownStream,
} from "dingtalk-stream";

import type { DingTalkStreamSdkPort, MaybePromise } from "./ports.ts";
import type { DingTalkStreamEnvelope } from "./types.ts";

export interface DingTalkStreamClientPort {
  connected: boolean;
  reconnecting: boolean;
  registered: boolean;
  registerCallbackListener(topic: string, callback: (message: DWClientDownStream) => void): void;
  connect(): Promise<void>;
  disconnect(): void;
  socketCallBackResponse(messageId: string, result: { status: string }): void;
  onSystem(message: DWClientDownStream): void;
}

export type DingTalkStreamClientFactory = (options: {
  clientId: string;
  clientSecret: string;
  debug: boolean;
  keepAlive: boolean;
  autoReconnect: boolean;
}) => DingTalkStreamClientPort;

function envelope(message: DWClientDownStream): DingTalkStreamEnvelope {
  return {
    type: message.type,
    headers: {
      messageId: message.headers.messageId,
      topic: message.headers.topic,
      ...(message.headers.eventId ? { eventId: message.headers.eventId } : {}),
      ...(message.headers.time ? { time: message.headers.time } : {}),
    },
    data: message.data,
  };
}

/** The runtime maintenance loop owns recovery; never race a vendor reconnect timer. */
export class RealDingTalkStreamSdk implements DingTalkStreamSdkPort {
  private readonly client: DingTalkStreamClientPort;
  private readonly subscriptions = new Set<"robot" | "card">();
  private readonly onHandlerError: (error: unknown) => void;
  private reconnectPromise: Promise<{ connected: boolean }> | null = null;
  private stopped = true;
  private lifecycleGeneration = 0;
  private nextAttemptAt = 0;
  private failedAttempts = 0;

  constructor(
    credentials: { clientId: string; clientSecret: string },
    onHandlerError: (error: unknown) => void = () => {},
    createClient: DingTalkStreamClientFactory = (options) => new DWClient(options),
  ) {
    this.onHandlerError = onHandlerError;
    this.client = createClient({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      debug: false,
      keepAlive: true,
      autoReconnect: false,
    });
    const vendorOnSystem = this.client.onSystem.bind(this.client);
    this.client.onSystem = (message) => {
      vendorOnSystem(message);
      if (message.headers.topic === "disconnect") void this.reconnect();
    };
  }

  subscribe(topic: "robot" | "card", handler: (message: DingTalkStreamEnvelope) => MaybePromise<void>): void {
    if (this.subscriptions.has(topic)) throw new Error(`dingtalk_${topic}_handler_already_registered`);
    this.subscriptions.add(topic);
    const sdkTopic = topic === "robot" ? TOPIC_ROBOT : TOPIC_CARD;
    this.client.registerCallbackListener(sdkTopic, (message) => {
      void Promise.resolve(handler(envelope(message))).catch((error: unknown) => this.onHandlerError(error));
    });
  }

  connect(): Promise<{ connected: boolean }> {
    if (this.stopped) {
      this.lifecycleGeneration += 1;
      this.stopped = false;
      this.nextAttemptAt = 0;
      this.failedAttempts = 0;
    }
    return this.reconnect();
  }

  reconnect(): Promise<{ connected: boolean }> {
    if (this.stopped) return Promise.resolve({ connected: false });
    if (this.reconnectPromise) return this.reconnectPromise;
    if (this.state() === "connected") {
      this.failedAttempts = 0;
      return Promise.resolve({ connected: true });
    }
    const now = Date.now();
    if (now < this.nextAttemptAt) return Promise.resolve({ connected: false });
    const generation = this.lifecycleGeneration;
    this.reconnectPromise = Promise.resolve()
      .then(() => {
        if (!this.stopped && generation === this.lifecycleGeneration) return this.client.connect();
      })
      .then(() => {
        if (this.stopped || generation !== this.lifecycleGeneration) {
          this.client.disconnect();
          return { connected: false };
        }
        if (this.client.connected) {
          this.nextAttemptAt = 0;
        } else {
          // The pinned SDK may swallow connection errors rather than reject.
          this.deferRetry();
        }
        const connected = this.state() === "connected";
        if (connected) this.failedAttempts = 0;
        return { connected };
      })
      .catch((error: unknown) => {
        if (!this.stopped && generation === this.lifecycleGeneration) this.deferRetry();
        this.onHandlerError(error);
        return { connected: false };
      })
      .finally(() => {
        this.reconnectPromise = null;
      });
    return this.reconnectPromise;
  }

  state(): "connected" | "reconnecting" | "stopped" {
    if (this.stopped) return "stopped";
    // connect() obtains an authenticated ticket for the requested subscriptions
    // before opening this socket. REGISTERED is an optional SDK system frame,
    // not a required gateway handshake (the official Python SDK does not await
    // it either). Waiting for it disconnects valid idle streams every 30s.
    // The SDK heartbeat/close/error handlers clear connected on transport loss;
    // chat allowlisting, persistence and Owner authorization remain downstream.
    return this.client.connected ? "connected" : "reconnecting";
  }

  private deferRetry(): void {
    this.nextAttemptAt = Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(this.failedAttempts, 6));
    this.failedAttempts += 1;
  }

  disconnect(): void {
    this.stopped = true;
    this.lifecycleGeneration += 1;
    this.client.disconnect();
  }

  acknowledge(transportMessageId: string): void {
    if (!this.client.connected) {
      void this.reconnect();
      throw new Error("dingtalk_stream_not_connected");
    }
    try {
      this.client.socketCallBackResponse(transportMessageId, { status: "SUCCESS" });
    } catch (error) {
      // An open flag can be stale when socket.send fails. Close before retrying.
      this.client.disconnect();
      this.nextAttemptAt = 0;
      void this.reconnect();
      throw error;
    }
  }
}
