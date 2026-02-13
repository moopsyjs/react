import * as React from "react";
import EJSON from "ejson";

import { sanitizeBaseURL } from "../utils/sanitize-base-url";
import { MoopsyClient } from "../client";
import { MoopsyError, MoopsyRawServerToClientMessageType } from "@moopsyjs/core";
import { getWebsocketURL } from "../../lib/url-polyfill";
import { EventEmitter } from "events";

export enum TransportStatus {
  disconnected = "disconnected",
  connecting = "connecting",
  connected = "connected"
}

export class WebsocketComm {
  public type = "websocket" as const;
  private socket: WebSocket | null = null;
  private hasConnectedBefore: boolean = false;
  public lastPing: Date = new Date();
  public status: TransportStatus = TransportStatus.disconnected;
  public connectedAt: Date | null = null;
  public failureCount: number = 0;
  public reconnectPending: boolean = false;
  public terminated: boolean = false;
  public lastReconnectAttempt: Date | null = null;
  private stabilityCheckInterval: number | null = null;
  public readonly baseURL: string;
  public readonly emitter = new EventEmitter();


  public constructor (public readonly client: MoopsyClient, baseURL: string) {
    this.baseURL = sanitizeBaseURL(baseURL);
  }

  public readonly emit = {
    statusChange: (status: TransportStatus) => {
      if(this.terminated) return;
      this.emitter.emit("statusChange", status);
    }
  };

  public readonly on = {
    statusChange: (cb: (status: TransportStatus) => void): void => {
      this.emitter.on("statusChange", cb);
    }
  };  

  public readonly off = {
    statusChange: (cb: (status: TransportStatus) => void): void => {
      this.emitter.off("statusChange", cb);
    }
  };    

  public readonly updateStatus = (status: TransportStatus): void => {
    if(this.terminated) return;

    this.v(`Updating status to: ${status}`);

    if(status === TransportStatus.connected) {
      // Clear the outbox before emitting status to prevent calls made as side-effects of status change getting cleared
      this.client.clearOutboxBeforeReconnection();
    }

    this.status = status;
    this.emit.statusChange(status);
    
    if(status === TransportStatus.connected) {
      this.connectedAt = new Date();
      this.failureCount = 0;

      void this.client.handleOutboxFlushRequest();
    }
  };

  public readonly pinged = (): void => {
    this.lastPing = new Date();
  };  

  public readonly handleIncomingMessage = (incoming: string): void => {
    this.pinged();
    const data: MoopsyRawServerToClientMessageType = EJSON.parse(incoming);
    this.client.incomingMessageEmitter.emit(data.event, data.data);

    if(data.event === "ping") {
      this.v("Received pong");
      this.send(
        EJSON.stringify({ event: "pong" })
      );
    }
  };    

  public readonly requestReconnect = async (): Promise<void> => {
    if(this.reconnectPending === true) {
      if(this.lastReconnectAttempt != null && this.lastReconnectAttempt < new Date(Date.now() - 30000)) {
        this.v("Reconnect has been pending for over 30 seconds, going to try reconnecting again.");
      }
      else {
        return;
      }
    }

    this.reconnectPending = true;
    this.lastReconnectAttempt = new Date();

    // eslint-disable-next-line no-constant-condition
    while(true) {
      try {
        const { data } = await this.client.axios.get(`${this.baseURL}/api/status`);
      
        if(data === "OK") {
          break;
        }
      }
      catch {
        // Ignore errors
      }
      finally {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    this.v("Attempting to reconnect...");
    void this.connect();
  };    

  public readonly handleConnectionFailure = (reason: string): void => {
    this.v("Connection failure detected: " + reason);
    this.failureCount++;

    if(this.status !== TransportStatus.disconnected) {
      this.disconnect(3900, "connection-failure" + reason);
    }

    void this.requestReconnect();
  };

  public readonly stopStabilityCheckInterval = (): void => {
    if(this.stabilityCheckInterval) {
      clearInterval(this.stabilityCheckInterval);
      this.stabilityCheckInterval = null;
    }
  };

  public readonly kickoffStabilityCheckInterval = (): void => {
    this.v("Kicking off stability check interval...");

    if(this.stabilityCheckInterval) {
      this.v("Clearing existing stability check interval...");
      clearInterval(this.stabilityCheckInterval);
    }

    this.stabilityCheckInterval = setInterval(() => {      
      if(this.lastPing.valueOf() < (Date.now() - 7500)) {
        this.v(`Connection is unstable, last ping was ${Date.now() - this.lastPing.valueOf()}ms ago, declaring failure.`);
        this.handleConnectionFailure("stability-check");
      }
      else {
        this.v(`Connection is stable, last ping was ${Date.now() - this.lastPing.valueOf()}ms ago.`);
      }

      this.send(
        EJSON.stringify({ event: "ping" })
      );
    }, 3000) as any as number;
  };

  public readonly awaitConnected = () => {
    return new Promise<void>((resolve) => {
      if(this.status === TransportStatus.connected) {
        resolve();
      }
      else {
        const handler = (status: TransportStatus) => {
          if(status === TransportStatus.connected) {
            resolve();
            this.off.statusChange(handler);
          }
        };

        this.on.statusChange(handler);
      }
    });
  };

  public readonly useStatus = (): TransportStatus => {
    const [v,s] = React.useState(this.status);

    React.useEffect(() => {
      const onStatusChange = (status: TransportStatus) => s(status);

      this.on.statusChange(onStatusChange);

      return () => {
        this.off.statusChange(onStatusChange);
      };
    }, []);

    return v;
  };

  public readonly useIsConnected = (): boolean => {
    return this.useStatus() === TransportStatus.connected;
  };    

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

  public readonly disconnect = (code: number, reason: string): void => {
    this.v("Disconnecting...");

    this.failActiveCalls();
    
    if(this.socket != null) {
      this.socket.close(code, reason);
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
        this.handleConnectionFailure("initial-connection-timeout");
      }
    }, 3500);

    this.updateStatus(TransportStatus.connecting);
    
    const socketURL = getWebsocketURL(this.baseURL);
    
    this.v(`Connecting via websocket to: ${socketURL.toString()}...`);

    const socket = new WebSocket(socketURL);

    socket.addEventListener("open", () => {
      if(socket !== this.socket) {
        return; // Socket replaced
      }

      clearTimeout(connectTimeout);
      this.hasConnectedBefore = true;
      this.v("Connected via websocket.");

      this.reconnectPending = false;
      this.updateStatus(TransportStatus.connected);
      this.pinged();
      this.kickoffStabilityCheckInterval();
    });

    socket.addEventListener("error", (event) => {
      if(socket !== this.socket) {
        return; // Socket replaced
      }

      clearTimeout(connectTimeout);
      this.v(`Failed to connect via websocket: ${event.type}`);

      this.reconnectPending = false;

      this.handleConnectionFailure("socket-error");
    });

    socket.addEventListener("close", (event) => {
      if(socket !== this.socket) {
        return; // Socket replaced
      }

      clearTimeout(connectTimeout);
      this.v(`Socket closed with code ${event.code} and reason ${event.reason}`);

      if(this.status === TransportStatus.disconnected) {
        return;
      }
      
      this.handleConnectionFailure("remote-close");
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
    this.disconnect(3901, "comm-termination");
    this.terminated = true;
  };
}
