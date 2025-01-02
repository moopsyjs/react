import { UseMoopsyQueryRetVal } from "./models/client";
export {
  AuthExtensionStatus,
  MoopsyClientAuthExtension,
  MoopsyClientAuthExtensionState,
  MoopsyClientAuthExtensionState as MoopsyAuthState
} from "./models/client-extensions/auth-extension";
export { MoopsyClient, type UseMoopsyQueryRetVal, type UseMoopsyMutationRetVal, type UseMoopsyMutationOptionsType } from "./models/client";
export type UseMoopsyQueryRetValAny = UseMoopsyQueryRetVal<any>;
export type AnyMoopsyQuery = UseMoopsyQueryRetVal<any>;
export type { WebsocketComm } from "./models/transports/websocket-comm";
export { TransportStatus } from "./models/transports/base";
export type { PubSubSubscription } from "./models/pubsub-subscription";
export { MoopsyMutation } from "./models/mutation";
export { TimeoutError } from "./models/errors/timeout-error";
export { NetworkError } from "./models/errors/network-error";
export * from "./lib/is-moopsy-error";
export type { ReadableMoopsyStream } from "./models/readable-moopsy-stream";