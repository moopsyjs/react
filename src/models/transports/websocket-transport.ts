import { io, Socket } from "socket.io-client";

import { TransportBase, TransportStatus } from "./base";
import { sanitizeBaseURL } from "../utils/sanitize-base-url";
import { MoopsyClient } from "../client";
import { MoopsyError } from "@moopsyjs/core";
import { generateMutationId } from "../mutation";

export class WebsocketTransport extends TransportBase {
  type = "websocket" as const;
  private socket: Socket | null = null;

  public constructor (public readonly client: MoopsyClient, baseURL: string, onRequestSwitchTransport:(newTransport: "websocket" | "http") => void) {
    super(
      sanitizeBaseURL(baseURL),
      onRequestSwitchTransport
    );
  }

  public readonly v = (message: string): void => {
    this.client._debug(`[WebsocketTransport] ${message}`);
  };

  private readonly failActiveCalls = (): void => {
    for(const call of this.client.activeCalls) {
      call.declareFailure(
        new MoopsyError(1, "Connection Interrupted")
      );
    }
  };

  readonly disconnect = (): void => {
    this.v("Disconnecting...");

    this.failActiveCalls();
    
    if(this.socket != null) {
      this.socket.disconnect();
    }

    this.socket = null;
    this.updateStatus(TransportStatus.disconnected);
    this.stopStabilityCheckInterval();
  };

  public connectionId: string | null = null;
  public readonly connect = (): void => {
    if(this.status === TransportStatus.connected) {
      return this.v("Not connect()'ing as already connected");
    }

    if(this.socket != null) {
      this.v("connect() was called on a WebsocketTransport that has an active socket");
      throw new Error("connect() was called on a WebsocketTransport that has an active socket");
    }

    const connectionId = generateMutationId();
    this.connectionId = connectionId;

    const connectTimeout = setTimeout(() => {
      if(this.connectionId === connectionId) {
        this.v("Connection attempt timed out.");
        this.reconnectPending = false;
        this.handleConnectionFailure();
      }
    }, 3500);

    this.updateStatus(TransportStatus.connecting);
    this.v(`Connecting via websocket to: ${this.baseURL}...`);

    const socket = io(this.baseURL, {
      path: "/seamless_socketio",
      forceNew: true,
      reconnection: false,
      autoConnect: false,
      transports: ["websocket", "webtransport"],
      timeout: 2500,
    });  
    
    socket.connect();

    socket.on("connect", () => {
      clearTimeout(connectTimeout);
      this.v("Connected via websocket.");

      this.reconnectPending = false;
      this.updateStatus(TransportStatus.connected);
      this.pinged();
      this.kickoffStabilityCheckInterval();
    });

    socket.on("connect_error", (error: Error) => {
      clearTimeout(connectTimeout);
      this.v(`Failed to connect via websocket: ${error.toString()}`);
      this.client.errorOutFn?.("Failed to connect via websocket", error);

      this.reconnectPending = false;
      this.handleConnectionFailure();
    });

    socket.on("disconnect", () => {
      clearTimeout(connectTimeout);
      if(this.status === TransportStatus.disconnected) {
        return;
      }
      
      this.handleConnectionFailure();
    });   
    
    socket.on("message", this.handleIncomingMessage);

    this.socket = socket;
  };

  public readonly send = (message: string): void => {
    if(this.socket == null) {
      throw new Error("Websocket is null");
    }

    this.socket.send(message);
  };

  public readonly terminate = (): void => {
    this.disconnect();
    this.terminated = true;
  };
}