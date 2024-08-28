import { UseMoopsyQueryRetVal } from "./models/client";
export {
  MoopsyClientAuthExtension,
  MoopsyClientAuthExtensionState,
  MoopsyClientAuthExtensionState as MoopsyAuthState
} from "./models/client-extensions/auth-extension";
export { MoopsyClient, type UseMoopsyQueryRetVal, type UseMoopsyMutationRetVal } from "./models/client";
export type UseMoopsyQueryRetValAny = UseMoopsyQueryRetVal<any>;
export type AnyMoopsyQuery = UseMoopsyQueryRetVal<any>;
export type { WebsocketTransport } from "./models/transports/websocket-transport";
export { TransportStatus } from "./models/transports/base";
export type { PubSubSubscription } from "./models/pubsub-subscription";
export { MoopsyMutation } from "./models/mutation";
export { TimeoutError } from "./models/errors/timeout-error";
export { NetworkError } from "./models/errors/network-error";
export * from "./lib/is-moopsy-error";