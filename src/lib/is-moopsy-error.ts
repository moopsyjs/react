import { MoopsyError } from "@moopsyjs/core";

export function isMoopsyError (input: any): input is MoopsyError {
  return "_isMoopsyError" in input && input._isMoopsyError === true;
}