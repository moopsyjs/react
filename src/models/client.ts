import EJSON from "ejson";

import { MoopsyBlueprintConstsType, MoopsyBlueprintPlugType, MoopsyError, MoopsyPublishToTopicEventData, MoopsyRawClientToServerMessageEventEnum, MoopsyRawServerToClientMessageEventType, MoopsySubscribeToTopicEventData, MoopsyTopicSpecConstsType, MoopsyTopicSpecTyping } from "@moopsyjs/core";
import React from "react";
import { ActiveCallType, MoopsyMutation } from "./mutation";
import { MoopsyClientAuthExtension, AuthExtensionStatus } from "./client-extensions/auth-extension";
import { PubSubSubscription } from "./pubsub-subscription";
import type { Axios } from "axios";
import { WebsocketComm } from "./transports/websocket-comm";
import { MoopsyRequest } from "./request";
import { Queue } from "../lib/queue";
import { TransportBase, TransportStatus } from "./transports/base";
import { MutationCall } from "./mutation-call";
import { HTTPTransport } from "./transports/http-transport";
import { TypedEventEmitterV3 } from "@moopsyjs/toolkit";
import { UseMoopsyQueryRetValAny } from "..";
import { requestIdleCallbackSafe } from "../lib/idle-callback";
import { ReplaceMoopsyStreamWithReadable } from "../types";
import { useRerender } from "../lib/use-rerender";

type MoopsyClientOpts = {
  socketUrl: string;
  _debugOutFn?: ((...args:any[]) => void) | null;
  debug?: boolean | null;
  errorOutFn?: ((details: string, error: Error) => void) | null;
  axios: Axios;
}

export type UseMoopsyMutationRetVal<Plug extends MoopsyBlueprintPlugType> = {
  isLoading: boolean;
  error: null | MoopsyError;
  call: (params:Plug["params"]) => Promise<ReplaceMoopsyStreamWithReadable<Plug["response"]>>;
  activeCalls: Array<ActiveCallType<any>>;
}

export type MoopsyQueryUnderscoreType = {
  endpoint:string,
  params:any,
  onSideEffectResult: (d: any) => void
}

export interface MoopsyQueryRefreshOpts {
  /**
   * subtle refresh, if true will fetch data then update query data
   * without un-setting existing data or setting isLoading to true.
   * 
   * If the query fails, isError will still be set to false.
   */
  subtle?: boolean;
}

export type UseMoopsyQueryRetValBase<Plug extends MoopsyBlueprintPlugType> = {
  refresh: (opts?: MoopsyQueryRefreshOpts) => Promise<Plug["response"]>,
  refreshWithParams: (newParams: Plug["params"]) => Promise<Plug["response"]>,
  _: MoopsyQueryUnderscoreType,
}

export type UseMoopsyQueryRetVal<Plug extends MoopsyBlueprintPlugType> = UseMoopsyQueryRetValBase<Plug> & (
  { isLoading: true, error: null, isError: false, data: void } |
  { isLoading: false, error: MoopsyError, isError: true, data: void } |
  { isLoading: false, error: null, isError: false, data: Plug["response"] }
)

export type UseMoopsyMutationOptionsType = {
  publishActiveCallsState?: boolean,
  querySideEffects?: Array<UseMoopsyQueryRetVal<any> | null>,
  /**
   * Default 10000 (10 seconds)
   */
  timeout?: number,
}

export class MoopsyClient {
  private transport: TransportBase;
  private pubsubSubscriptions: {[k: string]: PubSubSubscription<any>} = {};
  private activeQueries: {[k: string]: UseMoopsyQueryRetValAny} = {};

  public errorOutFn?: ((details: string, error: Error) => void) | null;
  // TODO: Improve typing
  public readonly incomingMessageEmitter: TypedEventEmitterV3<Record<MoopsyRawServerToClientMessageEventType, any>> = new TypedEventEmitterV3();
  public _authExtensionSlot: MoopsyClientAuthExtension<any> | null = null;
  public _emitter = new TypedEventEmitterV3<{ "auth-extension/logged-in": void, "transport/status-change": TransportStatus }>();
  public _debugOutFn: ((...args:any[]) => void) | null;
  public debug: boolean;
  public socketUrl: string;
  public axios: Axios;
  public _closed: boolean = false;
  private readonly birthDate: number = Date.now();

  private lastId: number = 0;
  public readonly generateId = (): string => {
    if(this.lastId >= Number.MAX_SAFE_INTEGER) {
      console.error("MoopsyClient: lastId reached MAX_SAFE_INTEGER, resetting to 0");
      this.lastId = 0;
    }

    return (++this.lastId).toString();
  };
  
  
  public _debug = (...args:any[]) => {
    const timestamp = `+${(Date.now() - this.birthDate)}ms`;

    if(this.debug === true) {
      if(this._debugOutFn != null) {
        if(typeof args[0] !== "string" || !(args[0].includes("[received/raw") || args[0].includes("[pinged]") || args[0].includes("[_pinged]") || args[0].includes("[stabilityCheck]"))) {
          this._debugOutFn(timestamp, "@moopsyjs/react", ...args);
        }
      }
      else {
        console.debug(timestamp + " @moopsyjs/react", ...args);
      }
    }
  };
  
  public constructor(opts: MoopsyClientOpts) {
    this.axios = opts.axios;
    this.socketUrl = opts.socketUrl;
    this.debug = opts.debug ?? false;
    this._debugOutFn = opts._debugOutFn ?? null;

    this._debug("[Moopsy] MoopsyClient Constructing...");

    this.transport = new WebsocketComm(this, opts.socketUrl, this.onRequestSwitchTransport); //new RestTransport(this, opts.socketUrl, opts.axios)
    this.transport.connect();
    
    this.errorOutFn = opts.errorOutFn ?? null;

    setInterval(() => {
      if(this.transport.status === TransportStatus.connected) {
        this.transport.send(
          JSON.stringify({
            event: "ping",
            data: null
          })
        );
      }
    }, 5000);

    this.setupTransport(this.transport);
  }

  private readonly onRequestSwitchTransport = (newTransport: "websocket" | "http") => {
    if(newTransport === "http") {
      this._debug("[Moopsy] Switching to HTTP transport...");
      const transport = this.transport = new HTTPTransport(this, this.socketUrl, this.onRequestSwitchTransport);
      this.transport.connect();
      this.setupTransport(transport);
    } else if(newTransport === "websocket") {
      this._debug("[Moopsy] Switching to Websocket transport...");
      const transport = this.transport = new WebsocketComm(this, this.socketUrl, this.onRequestSwitchTransport);
      this.transport.connect();
      this.setupTransport(transport);
    }
  };

  private readonly setupTransport = (transport: TransportBase): void => {
    transport.on.statusChange((status) => {
      this._emitter.emit("transport/status-change", status);
    });
  };

  public readonly on = {
    transportStatusChange: (cb: (status: TransportStatus) => void): void => {
      this._emitter.on("transport/status-change", cb);
    }
  };

  public readonly off = {
    transportStatusChange: (cb: (status: TransportStatus) => void): void => {
      this._emitter.off("transport/status-change", cb);
    }
  };

  public readonly requestReconnect = (): void => {
    if(this.getTransportStatus() === TransportStatus.connected) {
      return;
    }

    void this.transport.requestReconnect();
  };

  public readonly use = {
    transportStatus: () => {
      const rerender = useRerender();

      React.useEffect(() => {
        this.on.transportStatusChange(rerender);

        return () => {
          this.off.transportStatusChange(rerender);
        };
      }, []);

      return this.transport.status;
    }
  };

  public readonly awaitConnected = async (): Promise<void> => {
    return new Promise((resolve) => {
      if(this.transport.status === TransportStatus.connected) {
        resolve();
      } else {
        const h = (status: TransportStatus) => {
          if(status === TransportStatus.connected) {
            resolve();
            this.off.transportStatusChange(h);
          }
        };

        this.on.transportStatusChange(h);
      }
    });
  };

  public readonly getTransportStatus = (): TransportStatus => {
    return this.transport.status;
  };

  public close = (): void => {
    this._closed = true;
    this.transport.disconnect(3902, "client-closed");
  };

  public readonly activeCalls: Set<MutationCall<any>> = new Set();

  private flushingOutbox: boolean = false;
  public handleOutboxFlushRequest = async (): Promise<void> => {
    if(
      this.flushingOutbox !== true // Not already flushing
      && this.transport.status === TransportStatus.connected // Connected
    ) {
      this._debug("Flushing outbox...", { authExtensionStatus: this._authExtensionSlot?.status });
      try {
        this.flushingOutbox = true;
        const isLoggedIn = this._authExtensionSlot?.status === AuthExtensionStatus.loggedIn;
        
        const outbox = this.outbox.flush(
          req => isLoggedIn || req.requireAuth !== true
        );

        this._debug(`Flushing ${outbox.length} messages...`);

        for(const message of outbox) {
          const stringified = EJSON.stringify(message.message);
          this.transport.send(stringified);
          await new Promise((resolve) => setTimeout(resolve, 0)); // Defer
        }
      }
      catch (err) {
        this._debug("Error flushing outbox", err);
      }

      this.flushingOutbox = false;

      const remaining = this.outbox.length();
      if(remaining > 0) {
        this._debug(`Outbox still has ${remaining} messages, re-flushing...`);
        setTimeout(() => {
          void this.handleOutboxFlushRequest();
        }, 100);
      }
    }
  };

  private outbox = new Queue<MoopsyRequest>(this.handleOutboxFlushRequest);

  /**
   * Clears any requests from outbox that should not survive reconnection
   */
  public readonly clearOutboxBeforeReconnection = (): void => {
    this._debug("Clearing outbox of any messages that should not survive reconnection");
    this.outbox.flush(
      req => req.surviveReconnection !== true
    );
  };

  public send = (params: MoopsyRequest) => {
    if(params.message.event !== "call") {
      this._debug("[send] " + params.message.event);
    }
    
    this.outbox.push(params);
  };

  private readonly validatePlug = (plug: MoopsyBlueprintConstsType) => {
    if(plug == null) {
      throw new Error("Blueprint is nullish");
    }
    
    if(plug.Endpoint == null) {
      throw new Error("Blueprint.Endpoint is nullish");
    }
  };

  private readonly validateQuerySideEffects = (querySideEffects: Array<UseMoopsyQueryRetVal<any> | null> | null) => {
    if(querySideEffects == null) {
      return;
    }

    if(!Array.isArray(querySideEffects)) {
      throw new Error("QuerySideEffects is not an array");
    }
    
    for(const querySideEffect of querySideEffects) {
      if(querySideEffect == null) {
        continue;
      }

      if(querySideEffect._ == null) {
        throw new Error("QuerySideEffect._ is nullish");
      }
    }
  };  

  /**
   * Returns a MoopsyMutation class instance
   */
  public useStaticMutation<Plug extends MoopsyBlueprintPlugType>(plug: MoopsyBlueprintConstsType, isQuery: boolean, options?:UseMoopsyMutationOptionsType): MoopsyMutation<Plug> {
    this.validatePlug(plug);

    const ref = React.useRef(
      new MoopsyMutation<Plug>(
        this,
        plug,
        {
          querySideEffects: options?.querySideEffects ?? [],
          timeout: options?.timeout ?? 10000
        },
        isQuery
      )
    );

    React.useEffect(() => {
      ref.current.querySideEffects = options?.querySideEffects ?? [];
    }, [options]);


    return ref.current;
  }  

  /**
   * Helper hook to listen to reactive changes on a MoopsyMutation
   */
  private _useReactiveMutation = <Plug extends MoopsyBlueprintPlugType>(mutation: MoopsyMutation<Plug>): UseMoopsyMutationRetVal<Plug> => {    
    const [isLoading, setIsLoading] = React.useState<boolean>(mutation.loading);
    const [error, setError] = React.useState<null | MoopsyError>(mutation.error);
    const [activeCalls, setActiveCalls] = React.useState<Array<ActiveCallType<Plug>>>(mutation.activeCalls);

    React.useEffect(() => {
      const listener = () => {
        setIsLoading(mutation.loading);
        setError(mutation.error);
        setActiveCalls(mutation.activeCalls);
      };

      listener();

      mutation.changeEmitter.on("changed", listener);

      return () => {
        mutation.changeEmitter.off("changed", listener);
      };
    }, [mutation]);

    const result = React.useMemo(() => ({
      activeCalls,
      isLoading,
      error,
      call: mutation.call,
    }), [activeCalls, isLoading, error, mutation.call]);

    return result;
  };  

  public useMutation = <Plug extends MoopsyBlueprintPlugType>(plug: MoopsyBlueprintConstsType, options?:UseMoopsyMutationOptionsType): UseMoopsyMutationRetVal<Plug> => {
    this.validateQuerySideEffects(options?.querySideEffects ?? null);
    const mutation = this.useStaticMutation<Plug>(plug, false, options);
    return this._useReactiveMutation(mutation);
  };

  public useQuery = <Plug extends MoopsyBlueprintPlugType>(
    MoopsyModule:MoopsyBlueprintConstsType,
    params:Plug["params"],
    options?: UseMoopsyMutationOptionsType
  ) : UseMoopsyQueryRetVal<Plug> => {
    const queryId = React.useMemo(() => this.generateId(), []);
    const paramsHash = React.useMemo(() => JSON.stringify(params), [params]);
    const [isLoading, setIsLoading] = React.useState<boolean>(true);
    const [data, setData] = React.useState<Plug["response"] | void>();
    const [error, setError] = React.useState<null | MoopsyError>(null);
    const mutation = this.useStaticMutation<Plug>(MoopsyModule, true, options);
    const { call } = this._useReactiveMutation(mutation);

    const refresh = React.useCallback(async (opts?: MoopsyQueryRefreshOpts) => {
      if(opts?.subtle !== true) {
        setIsLoading(true);
        setData(undefined);
      }
      
      try {
        const d = await call(params);

        /**
         * Defer setting data to avoid interfering with any animations
         * We wait up to 300ms, which should be enough time for any
         * animations to run.
         */
        requestIdleCallbackSafe(() => {
          setData(d);
          setIsLoading(false);
        }, 300);
      }
      catch (err) {
        /**
         * If the refresh is subtle, we don't save any errors to the state,
         * instead throwing the error to the refresh() caller
         */
        if(opts?.subtle === true) {
          throw err;
        }

        setError(err as any);
        setIsLoading(false);
      }
    }, [params]);

    React.useEffect(() => {
      this._debug("[Moopsy/React] Refreshing as params hash changed");
      void refresh();
    }, [paramsHash]);

    const result = React.useMemo(() => ({
      isLoading,
      error,
      isError: error !== null,
      data,
      refresh,
      _: {
        endpoint: MoopsyModule.Endpoint,
        params,
        onSideEffectResult:(d:Plug["response"]) => {
          setData(d);
        },
      }
    }), [isLoading, error, data, refresh, MoopsyModule.Endpoint, params, setData]) as UseMoopsyQueryRetVal<Plug>;
    this.activeQueries[queryId] = result;

    React.useEffect(() => {
      return () => {
        delete this.activeQueries[queryId];
      };
    }, []);

    return result;
  };

  public createPubSubSubscription = <Typing extends MoopsyTopicSpecTyping>(options: MoopsySubscribeToTopicEventData): PubSubSubscription<Typing> => {
    if(options.topic in this.pubsubSubscriptions && this.pubsubSubscriptions[options.topic].destroyed === false) {
      this._debug(`[@MoopsyJS/React] createPubSubSubscription - reusing existing subscription for "${options.topic}"`);
      return this.pubsubSubscriptions[options.topic];
    }

    this._debug(`[@MoopsyJS/React] createPubSubSubscription - creating new subscription for "${options.topic}"`);

    const subscription = new PubSubSubscription<Typing>(this, options);

    this.pubsubSubscriptions[options.topic] = subscription;

    return subscription;
  };

  public useSubscribeToTopic = <PSB extends MoopsyTopicSpecTyping>(
    TopicSpecConsts: MoopsyTopicSpecConstsType,
    topic: PSB["TopicNameType"],
    onMessage: (message: PSB["MessageType"]) => void
  ): void => {
    React.useEffect(() => {
      this._debug(`[@MoopsyJS/React][${topic}] useSubscribeToTopic creating subscription...`);
      const subscription = this.createPubSubSubscription({
        topic,
        topicId: TopicSpecConsts.TopicID,
        params: {}
      });

      this.pubsubSubscriptions[topic] = subscription;

      const listener = subscription.listen(onMessage);

      return () => {
        this._debug(`[@MoopsyJS/React][${topic}] useSubscribeToTopic changed, destroying listener`);
        listener.stop();
      };
    }, [TopicSpecConsts, topic, onMessage]);
    React.useEffect(() => {
      this._debug(`[@MoopsyJS/React][${topic}] useSubscribeToTopic change: TopicSpecConsts`);
    }, [TopicSpecConsts]);
    React.useEffect(() => {
      this._debug(`[@MoopsyJS/React][${topic}] useSubscribeToTopic change: topic`);
    }, [topic]);
    React.useEffect(() => {
      this._debug(`[@MoopsyJS/React][${topic}] useSubscribeToTopic change: onMessage`);
    }, [onMessage]);

    const vRef = React.useRef<{
      TopicSpecConsts: MoopsyTopicSpecConstsType,
      topic: PSB["TopicNameType"],
      onMessage: (message: PSB["MessageType"]) => void      
    }>();

    React.useEffect(() => {
      if(vRef.current != null) {
        const changed = {
          TopicSpecConsts: TopicSpecConsts === vRef.current.TopicSpecConsts,
          topic: topic === vRef.current.topic,
          onMessage: onMessage === vRef.current.onMessage
        };

        this._debug(`[@MoopsyJS/React][${topic}] useSubscribeToTopic changed:::`, changed);

      }
      vRef.current = {
        TopicSpecConsts, topic, onMessage
      };
    }, [TopicSpecConsts, topic, onMessage]);
  };

  public usePublishToTopic = <TopicSpecTyping extends MoopsyTopicSpecTyping>(
    TopicSpecConsts: MoopsyTopicSpecConstsType,
  ): {
    publish: (
        topicName: TopicSpecTyping["TopicNameType"],
        data: TopicSpecTyping["MessageType"]        
    ) => void
  } => {
    const publish = (
      topicName: TopicSpecTyping["TopicNameType"],
      data: TopicSpecTyping["MessageType"]        
    ) => {
      const publicationMessage: MoopsyPublishToTopicEventData = {
        topic: topicName,
        topicId: TopicSpecConsts.TopicID,
        data
      };

      this.send(
        new MoopsyRequest({
          event: MoopsyRawClientToServerMessageEventEnum.PUBLISH_TO_TOPIC,
          data: publicationMessage
        }, true, true)
      );
    };

    return { publish };
  };  

  public onConnected = (callback: (() => void) | (() => Promise<void>)) => {
    if(this.transport.status === TransportStatus.connected) {
      void callback();
    } else {
      const h = (status:TransportStatus) => {
        if(status === TransportStatus.connected) {
          void callback();
          this.transport.off.statusChange(h);
        }
      };

      this.transport.on.statusChange(h);
    }
  };

  /**
   * Refreshes all queries currently mounted an active on the client. Useful when the app
   * comes back from the background, if authentication state changes, etc.
   */
  public readonly refreshAllQueries = (params: MoopsyQueryRefreshOpts = {}): void => {
    for(const queryId in this.activeQueries) {
      const query = this.activeQueries[queryId];
      void query.refresh(params);
    }
  };
}