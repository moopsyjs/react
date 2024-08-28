import { MoopsyRawClientToServerMessageType } from "@moopsyjs/core";

export class MoopsyRequest {
  public constructor(public readonly message: MoopsyRawClientToServerMessageType, public readonly requireAuth: boolean) {}
}