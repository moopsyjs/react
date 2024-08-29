import EJSON from "ejson";

import { MoopsyBlueprintConstsType, MoopsyBlueprintPlugType, MoopsyError, MoopsyPublishToTopicEventData, MoopsyRawClientToServerMessageEventEnum, MoopsyRawClientToServerMessageType, MoopsyRawServerToClientMessageEventType, MoopsySubscribeToTopicEventData, MoopsyTopicSpecConstsType, MoopsyTopicSpecTyping } from "@moopsyjs/core";
import React, { useCallback, useEffect, useState } from "react";
import { ActiveCallType, MoopsyMutation } from "./mutation";
import { MoopsyClientAuthExtension, MoopsyClientAuthExtensionState } from "./client-extensions/auth-extension";
import { PubSubSubscription } from "./pubsub-subscription";
import type { Axios } from "axios";
import { WebsocketTransport } from "./transports/websocket-transport";
import { MoopsyRequest } from "./request";
import { Queue } from "../lib/queue";
import { TransportBase, TransportStatus } from "./transports/base";
import { MutationCall } from "./mutation-call";
import { HTTPTransport } from "./transports/http-transport";
import { TypedEventEmitterV3 } from "@moopsyjs/utils";

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
  call: (params:Plug["params"]) => Promise<Plug["response"]>;
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

type UseMoopsyMutationOptionsType = {
  publishActiveCallsState?: boolean,
  querySideEffects?: Array<UseMoopsyQueryRetVal<any> | null>,
}

export class MoopsyClient {
  private transport: TransportBase;
  private pubsubSubscriptions: {[k: string]: PubSubSubscription<any>} = {};

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
  
  public _debug = (...args:any[]) => {
    if(this.debug === true) {
      if(this._debugOutFn != null) {
        if(typeof args[0] !== "string" || !(args[0].includes("[received/raw") || args[0].includes("[pinged]") || args[0].includes("[_pinged]") || args[0].includes("[stabilityCheck]"))) {
          this._debugOutFn("@moopsyjs/react", ...args, this.socketUrl);
        }
      }
      else {
        console.debug("@moopsyjs/react", ...args);
      }
    }
  };
  
  public constructor(opts: MoopsyClientOpts) {
    this.axios = opts.axios;
    this.socketUrl = opts.socketUrl;
    this.debug = opts.debug ?? false;
    this._debugOutFn = opts._debugOutFn ?? null;

    this._debug("[Moopsy] MoopsyClient Constructing...");

    this.transport = new WebsocketTransport(this, opts.socketUrl, this.onRequestSwitchTransport); //new RestTransport(this, opts.socketUrl, opts.axios)
    this.transport.connect();
    
    this.errorOutFn = opts.errorOutFn ?? null;

    setInterval(() => {
      this.send({
        message: {
          event: "ping",
          data: null
        },
        requireAuth: false
      });
    }, 5000);

    this.setupTransport(this.transport);
  }

  private readonly onRequestSwitchTransport = (newTransport: "websocket" | "http") => {
    if(newTransport === "http") {
      this._debug("[Moopsy] Switching to HTTP transport...");
      const transport = this.transport = new HTTPTransport(this, this.socketUrl, this.onRequestSwitchTransport);
      this.setupTransport(transport);
    } else if(newTransport === "websocket") {
      this._debug("[Moopsy] Switching to Websocket transport...");
      const transport = this.transport = new WebsocketTransport(this, this.socketUrl, this.onRequestSwitchTransport);
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

  public readonly use = {
    transportStatus: () => {
      const [status, setStatus] = React.useState<TransportStatus>(this.transport.status);

      React.useEffect(() => {
        const h = (status: TransportStatus) => {
          setStatus(status);
        };

        this.on.transportStatusChange(h);

        return () => {
          this.off.transportStatusChange(h);
        };
      }, []);

      return status;
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
    this.transport.disconnect();
  };

  public readonly activeCalls: Set<MutationCall<any>> = new Set();

  private flushingOutbox: boolean = false;
  public handleOutboxFlushRequest = async (): Promise<void> => {
    if(
      this.flushingOutbox !== true // Not already flushing
      && this.transport.status === TransportStatus.connected // Connected
    ) {
      this._debug("Flushing outbox...");
      try {
        this.flushingOutbox = true;
        const isLoggedIn = this._authExtensionSlot?.state === MoopsyClientAuthExtensionState.loggedIn;
        
        const outbox = this.outbox.flush(
          req => isLoggedIn || req.requireAuth !== true
        );

        for(const message of outbox) {
          const stringified = EJSON.stringify(message.message);
          this.transport.send(stringified);
          await new Promise((resolve) => setTimeout(resolve, 0)); // Defer
        }
      }
      catch {
        // Ignore
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


  public send = (params: {
    message: MoopsyRawClientToServerMessageType,
    requireAuth: boolean
  }) => {
    this._debug("[send/requested] " + params.message.event + (params.message.event === "call" ? " " + params.message.data.method : ""));
    this.outbox.push(
      new MoopsyRequest(params.message, params.requireAuth)
    );
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
  public useStaticMutation<Plug extends MoopsyBlueprintPlugType>(plug: MoopsyBlueprintConstsType, options?:UseMoopsyMutationOptionsType): MoopsyMutation<Plug> {
    this.validatePlug(plug);

    const ref = React.useRef(
      new MoopsyMutation<Plug>(
        this,
        plug,
        {
          querySideEffects: options?.querySideEffects ?? [],
        }
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
    const mutation = this.useStaticMutation<Plug>(plug, options);
    return this._useReactiveMutation(mutation);
  };

  public useQuery = <Plug extends MoopsyBlueprintPlugType>(
    MoopsyModule:MoopsyBlueprintConstsType,
    params:Plug["params"],
  ) : UseMoopsyQueryRetVal<Plug> => {
    const paramsHash = React.useMemo(() => JSON.stringify(params), [params]);
    const [isLoading, setIsLoading] = React.useState<boolean>(true);
    const [data, setData] = React.useState<Plug["response"] | void>();
    const { error, call } = this.useMutation<Plug>(MoopsyModule);

    const refresh = React.useCallback((opts?: MoopsyQueryRefreshOpts) => {
      if(opts?.subtle !== true) {
        setIsLoading(true);
        setData(undefined);
      }
      
      return call(params).then((d) => {
        setData(d);
        setIsLoading(false);
      });
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
    }), [isLoading, error, data, refresh, MoopsyModule.Endpoint, params, setData]);

    return result as UseMoopsyQueryRetVal<Plug>;
  };

  public useQueryWithTransform = <Plug extends MoopsyBlueprintPlugType>(
    MoopsyModule:MoopsyBlueprintConstsType,
    params:Plug["params"],
    transformFn: (data: Plug["response"]) => Promise<Plug["response"]>,
    opts?: {
      dependencies?:Array<any>,
    }
  ) : UseMoopsyQueryRetVal<Plug> => {
    const [data, setData] = useState<Plug["response"] | void>();
    const [isLoading, setIsLoading] = useState<boolean>(true);
    const [error, setError] = useState<MoopsyError | null>(null);
    const mutation = this.useMutation<Plug>(MoopsyModule);

    const onQueryError = (error: MoopsyError) => {
      console.error("[@moopsyjs/react] Error calling query", MoopsyModule, params, error);
      setError(error ?? new MoopsyError(0, "No Error Specified"));
      setIsLoading(false);
    };

    const onDataAvailable = useCallback(async (data:Plug["response"]): Promise<void> => {
      const transformed = await transformFn(data);
      setData(transformed);
    }, [transformFn, setData]);

    const performMutation = useCallback((p: Plug["params"]) => {
      setIsLoading(true);
      return new Promise((resolve) => {
        mutation.call(p).then(async (response: Plug["response"]) => {
          await onDataAvailable(response);
          setIsLoading(false);
          resolve(response);
        }).catch(onQueryError);
      });
    }, [mutation, setIsLoading, onDataAvailable]);
    
    const refresh = useCallback(() => performMutation(params), [performMutation, params]);
    const refreshWithParams = useCallback((newParams:Plug["params"]) => performMutation(newParams), [performMutation]);

    useEffect(() => {
      void refresh();
      return () => {};
    }, opts?.dependencies ?? []);

    const rv: UseMoopsyQueryRetVal<Plug> = {
      isLoading,
      refresh,
      refreshWithParams,
      data,
      error,
      isError: error !== null,
      _: {
        endpoint:MoopsyModule.Endpoint,
        params:params,
        onSideEffectResult:(d:Plug["response"]) => {
          void onDataAvailable(d);
        },
      }
    } as UseMoopsyQueryRetVal<Plug>;

    return Object.freeze(rv);
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

      this.send({
        message: {
          event: MoopsyRawClientToServerMessageEventEnum.PUBLISH_TO_TOPIC,
          data: publicationMessage
        },
        requireAuth: true // TODO should be dynamic
      });
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
}