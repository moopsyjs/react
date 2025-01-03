import { type Axios } from "axios";

import { stringToU8Array, toBase64 } from "../../utils";
import { MoopsyClient } from "../client";
import { sanitizeBaseURL } from "../utils/sanitize-base-url";
import { TransportBase, TransportStatus } from "./base";

function encodeArrayBuffer (arrayBuffer: ArrayBuffer): string {
  return [...new Uint8Array(arrayBuffer)].join(".");
}

export class HTTPTransport extends TransportBase {
  type = "http" as const;
  private connectionId: string | null = null;
  private privateKey: CryptoKey | null = null;
  private axios: Axios;
  private fetchInterval: number | null = null;

  public terminated: boolean = false;
  public status: TransportStatus = TransportStatus.disconnected;

  public constructor (public readonly client: MoopsyClient, baseURL: string, onRequestSwitchTransport:(newTransport: "websocket" | "http" | "socketio") => void) {
    super(
      sanitizeBaseURL(baseURL),
      onRequestSwitchTransport
    );
    this.axios = client.axios;
  }

  public readonly v = (message: string): void => {
    this.client._debug(`[@moopsyjs/react::HTTPTransport] ${message}`);
  };  

  public readonly send = async <T>(message: string): Promise<T> => {
    if(this.connectionId === null) {
      throw new Error("Connection ID is null");
    }

    const privateKey = this.privateKey;

    if(privateKey === null) {
      throw new Error("Private key is null");
    }

    const signatureBuffer: ArrayBuffer = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      globalThis.TextEncoder == null ? stringToU8Array(message) : new TextEncoder().encode(message)
    );
    const signature = encodeArrayBuffer(signatureBuffer);

    const { data } = await this.axios.post(
      `${this.baseURL}/_moopsyjs/http/message`,
      {
        data: message,
        signature
      },
      {
        headers: {
          "x-seamless-connection-id": this.connectionId,
        }
      }
    );

    return data;
  };  

  readonly disconnect = (): void => {
    //
  };

  public readonly terminate = (): void => {
    this.terminated = true;

    // We leave the HTTP fetch interval open for 30s to allow any requests already sent to complete
    setTimeout(() => {
      if(this.fetchInterval !== null) {
        clearInterval(this.fetchInterval);
        this.fetchInterval = null;
      }
    }, 1000 * 30);
  };

  public readonly connect = async (): Promise<void> => {
    const establishURL = `${this.baseURL}/_moopsyjs/http/establish`;

    try {
      const keypair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
      const exportedPublicKey: JsonWebKey = await crypto.subtle.exportKey("jwk", keypair.publicKey);
      exportedPublicKey.key_ops = ["verify"];
      const publicKey = toBase64(JSON.stringify(exportedPublicKey));
      
      this.privateKey = keypair.privateKey;

      const { data: { connectionId } } = await this.axios.post<{ connectionId: string }>(
        establishURL,
        {},
        {
          headers: {
            "x-seamless-publickey": publicKey,
            "x-seamless-publickey-type": "ecdsa"
          }
        }
      );

      this.connectionId = connectionId;

      this.updateStatus(TransportStatus.connected);
      this.pinged();

      this.fetchInterval = setInterval(async () => {
        const incomingMessages: string[] = await this.send<string[]>("check-outbox");

        for(const incoming of incomingMessages) {
          this.handleIncomingMessage(incoming);
        }
      }, 2000);

      this.kickoffStabilityCheckInterval();
    }
    catch(e: any) {
      console.warn("Failed to establish HTTP connection via " + establishURL, "response" in e ? e.response : e);
      this.handleConnectionFailure("establish-failure");
    }
  };
}