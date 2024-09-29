import { MoopsyRawClientToServerMessageType } from "@moopsyjs/core";

export class MoopsyRequest {
  public constructor(
    public readonly message: MoopsyRawClientToServerMessageType,
    public readonly requireAuth: boolean,
    /**
     * Whether this request will be preserved and retried following a reconnection
     * Should typically be true for mutations and false for queries
     */
    public readonly surviveReconnection: boolean,
  ) {}
}