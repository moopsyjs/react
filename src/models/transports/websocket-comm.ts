import { TransportBase, TransportStatus } from "./base";
import { sanitizeBaseURL } from "../utils/sanitize-base-url";
import { MoopsyClient } from "../client";
import { MoopsyError } from "@moopsyjs/core";

export class WebsocketComm extends TransportBase {
  public type = "websocket" as const;
  private socket: WebSocket | null = null;
  private hasConnectedBefore: boolean = false;

  public constructor (public readonly client: MoopsyClient, baseURL: string, onRequestSwitchTransport:(newTransport: "websocket" | "http" | "socketio") => void) {
    super(
      sanitizeBaseURL(baseURL),
      onRequestSwitchTransport
    );
  }

  public readonly v = (message: string): void => {
    this.client._debug(`[WebsocketComm] ${message}`);
  };

  private readonly failActiveCalls = (): void => {
    for(const call of this.client.activeCalls) {
      call.declareFailure(
        new MoopsyError(1, "Connection Interrupted")
      );
    }
  };

  public readonly disconnect = (): void => {
    this.v("Disconnecting...");

    this.failActiveCalls();
    
    if(this.socket != null) {
      this.socket.close();
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
      this.v("connect() was called on a WebsocketComm that has an active socket");
      throw new Error("connect() was called on a WebsocketComm that has an active socket");
    }

    const connectionId = this.client.generateId();
    this.connectionId = connectionId;

    const connectTimeout = setTimeout(() => {
      if(this.connectionId === connectionId) {
        this.v("Connection attempt timed out.");
        this.reconnectPending = false;
        this.handleConnectionFailure();
      }
    }, 3500);

    this.updateStatus(TransportStatus.connecting);
    
    const socketURL = new URL(this.baseURL, window.location.href);
    socketURL.pathname = "/moopsy_ws";
    
    this.v(`Connecting via websocket to: ${socketURL.toString()}...`);

    const socket = new WebSocket(socketURL);

    socket.addEventListener("open", () => {
      clearTimeout(connectTimeout);
      this.hasConnectedBefore = true;
      this.v("Connected via websocket.");

      this.reconnectPending = false;
      this.updateStatus(TransportStatus.connected);
      this.pinged();
      this.kickoffStabilityCheckInterval();
    });

    socket.addEventListener("error", (event) => {
      clearTimeout(connectTimeout);
      this.v(`Failed to connect via websocket: ${event.type}`);

      this.reconnectPending = false;

      if(!this.hasConnectedBefore) {
        this.terminate();
        this.onRequestSwitchTransport("socketio");
      }
      else {  
        this.handleConnectionFailure();
      }
    });

    socket.addEventListener("close", () => {
      clearTimeout(connectTimeout);
      this.v("Socket closed.");

      if(this.status === TransportStatus.disconnected) {
        return;
      }
      
      this.handleConnectionFailure();
    });   
    
    socket.addEventListener("message", v => {
      this.handleIncomingMessage(v.data);
    });

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