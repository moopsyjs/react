import { MoopsyError } from "@moopsyjs/core";

export class TimeoutError extends MoopsyError {
  public constructor(context?: string) {
    super(408, context == null ? "Request Timeout" : `Request Timeout: ${context}`);
  }
}