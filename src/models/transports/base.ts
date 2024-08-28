import EJSON from "ejson";
import { EventEmitter } from "events";
import { MoopsyRawServerToClientMessageType } from "@moopsyjs/core";
import { MoopsyClient } from "../client";
import React from "react";

export enum TransportStatus {
  disconnected = "disconnected",
  connecting = "connecting",
  connected = "connected"
}

export abstract class TransportBase {
  public abstract readonly connect: () => void;
  public abstract readonly send: (message: string) => void;
  /**
   * Terminate the transport, cleanup, block any further requests
   */
  public abstract readonly terminate: () => void;
  public abstract readonly v: (message: string) => void;
  public abstract readonly client: MoopsyClient;
  /**
   * Disconnect any current connection, but preserve the transport
   */
  public abstract readonly disconnect: () => void;
  public abstract readonly type: "websocket" | "http";
  public readonly baseURL: string;

  public readonly emitter = new EventEmitter();
  public lastPing: Date = new Date();
  public status: TransportStatus = TransportStatus.disconnected;
  public connectedAt: Date | null = null;
  public failureCount: number = 0;
  public reconnectPending: boolean = false;
  public terminated: boolean = false;

  private stabilityCheckInterval: number | null = null;

  public constructor(baseURL: string, private readonly onRequestSwitchTransport:(newTransport: "websocket" | "http") => void) {
    this.baseURL = baseURL;
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
    this.v(`Updating status to: ${status}`);
    this.status = status;
    this.emit.statusChange(status);
    if(status === TransportStatus.connected) {
      this.connectedAt = new Date();
      this.failureCount = 0;
    }
  };

  public readonly pinged = (): void => {
    this.lastPing = new Date();
  };  

  public readonly handleIncomingMessage = (incoming: string): void => {
    this.pinged();
    const data: MoopsyRawServerToClientMessageType = EJSON.parse(incoming);
    this.client.incomingMessageEmitter.emit(data.event, data.data);
  };    

  public readonly requestReconnect = (): void => {
    if(this.reconnectPending === true) {
      return;
    }

    const delay = Math.min(2500, this.failureCount * 500);

    this.v(`Will reconnect in ${delay}ms...`);
    this.reconnectPending = true;

    setTimeout(() => {
      this.v("Attempting to reconnect...");
      void this.connect();
    }, delay);
  };    

  public readonly handleConnectionFailure = (): void => {
    this.v("Connection failure detected.");
    this.failureCount++;

    if(this.status !== TransportStatus.disconnected) {
      this.disconnect();
    }

    if(this.failureCount > 3 && this.type === "websocket") {
      this.client.axios.get(`${this.baseURL}/api/status`)
        .then((res) => {
          if(res.data === "OK") {
          // Server is reachable via HTTP, so terminate this Websocket Transport and switch to HTTP
            this.terminate();
            this.onRequestSwitchTransport("http");
          }
          else {
            // Something's wrong, let's reconnect in a bit
            setTimeout(() => {
              this.requestReconnect();
            }, 1000);
          }
        })
        .catch(() => {
          // Something's wrong, let's reconnect in a bit
          setTimeout(() => {
            this.requestReconnect();
          }, 1000);
        });
    }
    else {
      this.requestReconnect();
    }
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
      this.v("Checking stability...");
      
      if(this.lastPing.valueOf() < (Date.now() - 10000)) {
        this.handleConnectionFailure();
      }      
    }, 5000);
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
}

