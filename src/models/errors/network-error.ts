import { MoopsyError } from "@moopsyjs/core";

export class NetworkError extends MoopsyError {
  public constructor(context?: string) {
    super(1, context == null ? "Network Error" : `Network Error: ${context}`);
  }
}