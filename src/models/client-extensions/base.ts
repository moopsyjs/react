import { MoopsyClient } from "../client";

/**
 * A client extension should accept the client and hook onto it and provide functionality
 */
export class MoopsyClientExtensionBase {
  public client: MoopsyClient;

  public constructor(client: MoopsyClient) {
    this.client = client;
  }
}