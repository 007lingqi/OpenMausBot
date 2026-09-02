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

/** The only vendor import; the wrapper adds liveness recovery around the SDK's reconnect backoff. */
export class RealDingTalkStreamSdk implements DingTalkStreamSdkPort {
  private readonly client: DingTalkStreamClientPort;
  private readonly subscriptions = new Set<"robot" | "card">();
  private readonly onHandlerError: (error: unknown) => void;
  private reconnectPromise: Promise<{ connected: boolean }> | null = null;
  private stopped = true;
  private lifecycleGeneration = 0;

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

  async connect(): Promise<{ connected: boolean }> {
    const generation = ++this.lifecycleGeneration;
    this.stopped = false;
    await this.client.connect();
    if (this.stopped || generation !== this.lifecycleGeneration) {
      this.client.disconnect();
      return { connected: false };
    }
    return { connected: this.state() === "connected" };
  }

  reconnect(): Promise<{ connected: boolean }> {
    if (this.stopped) return Promise.resolve({ connected: false });
    if (this.reconnectPromise) return this.reconnectPromise;
    const generation = this.lifecycleGeneration;
    this.reconnectPromise = Promise.resolve()
      .then(() => this.client.connect())
      .then(() => {
        if (this.stopped || generation !== this.lifecycleGeneration) {
          this.client.disconnect();
          return { connected: false };
        }
        return { connected: this.state() === "connected" };
      })
      .catch((error: unknown) => {
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
    return this.client.connected && !this.client.reconnecting ? "connected" : "reconnecting";
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
      void this.reconnect();
      throw error;
    }
  }
}
