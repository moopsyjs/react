import { MoopsyError, MoopsyRawClientToServerMessageEventEnum, MoopsySubscribeToTopicEventData, MoopsyTopicSpecTyping } from "@moopsyjs/core";
import { MoopsyClient } from "./client";
import { TransportStatus } from "./transports/base";
import { TypedEventEmitterV3 } from "@moopsyjs/toolkit";
import { MoopsyRequest } from "./request";

export class PubSubSubscription<Typing extends MoopsyTopicSpecTyping>{
  public destroyed: boolean = false;
  
  private client: MoopsyClient;
  private options: MoopsySubscribeToTopicEventData;
  private _emitter = new TypedEventEmitterV3<{ received: Typing["MessageType"] }>();
  private listeners = new Set<((m: Typing["MessageType"]) => void)>();

  public constructor(client: MoopsyClient, options: MoopsySubscribeToTopicEventData) {
    this.client = client;
    this.options = options;

    if(this.client.getTransportStatus() === TransportStatus.connected) {
      this._subscribe();
    }

    this.client.on.transportStatusChange(this._handleTransportStatusChange);
    this.client.incomingMessageEmitter.on(`publication.${this.options.topic}`, this._handleIncomingMessage);
    this.client.incomingMessageEmitter.on(`subscription-result.${this.options.topic}`, (data: true | { error: MoopsyError }) => {
      if(data === true) {
        this.client._debug(`[${this.options.topic}] Successfully subscribed`);
      }
      else {
        this.client._debug(`[${this.options.topic}] Failed to subscribe`, data);
      }
    });
  }

  public _handleTransportStatusChange = (status: TransportStatus) => {
    if(status === TransportStatus.connected) {
      this.client._debug(`[${this.options.topic}] Transport connected, resubscribing to "${this.options.topic}"`);
      // Resubscribe, as transport has been disconnected
      void this._subscribe();
    }
  };

  public _handleIncomingMessage = async (message: Typing["MessageType"]): Promise<void> => {
    this.client._debug(`[${this.options.topic}] PubSub received an incoming message for "${this.options.topic}"`);

    this._emitter.emit("received", message);
  };

  public _subscribe = (): void => {
    this.client._debug(`[${this.options.topic}] Creating a subscription`);

    this.client.send(
      new MoopsyRequest(
        {
          event: MoopsyRawClientToServerMessageEventEnum.SUBSCRIBE_TO_TOPIC,
          data: this.options
        },
        true, // This should become a param but for now we require auth
        false // We don't need this to survive reconnection as _handleTransportStatusChange() will trigger a new request in a reconnection event
      )
    );

    this.client.incomingMessageEmitter.once(`subscription-result.${this.options.topic}`, (data) => {
      if(data !== true && "error" in data) {
        console.warn(`[@MoopsyJS/React][${this.options.topic}] Subscription failed, self-destructing`, this.options, data);
        this.destroy();
      }
    });
  };

  public destroy = (): void => {
    // TODO: Destroying needs to be reworked to actually cancel the subscription with the server, until then it is useless
    this.destroyed = true;
    this.client.incomingMessageEmitter.off(`publication.${this.options.topic}`, this._handleIncomingMessage);
    this.client.off.transportStatusChange(this._handleTransportStatusChange);
  };

  public listen = (fn: ((m: Typing["MessageType"]) => void) | ((m: Typing["MessageType"]) => Promise<void>)): { stop: () => void } => {
    if(typeof fn !== "function") {
      console.error("PubSubSubscription.listen() called with non-function argument", fn, this);
      throw new Error("PubSubSubscription.listen() called with non-function argument");
    }
        
    this.client._debug(`[@MoopsyJS/React][${this.options.topic}] Adding listener for "${this.options.topic}"...`);

    let isActive = true;
    const wrappedCallback = (m: Typing["MessageType"]) => {
      if(isActive !== true) {
        return console.warn("W54 - Listener callback called even though not active");
      }
      else {
        void fn(m);
      }
    };
        
    this._emitter.on("received", wrappedCallback);
    this.listeners.add(wrappedCallback);

    return {
      stop: () => {
        isActive = false;
        // TODO track list of listeners, if 0 listeners are registered "pause" the subscription, resuming if a new listener is added
        this._emitter.off("received", wrappedCallback);
        this.listeners.delete(wrappedCallback);

        if(this.listeners.size === 0) {
          this.destroy();
        }
      }
    };
  };
}