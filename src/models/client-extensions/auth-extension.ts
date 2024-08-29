import { MoopsyAuthenticationSpec, MoopsyError, MoopsyRawClientToServerMessageEventEnum, MoopsyRawServerToClientMessageEventEnum } from "@moopsyjs/core";
import { MoopsyClient } from "../client";
import { MoopsyClientExtensionBase } from "./base";
import React from "react";
import { createTimeout } from "../../lib/timeout";
import { TimeoutError } from "../errors/timeout-error";
import { isMoopsyError } from "../../lib/is-moopsy-error";
import { TransportStatus } from "../transports/base";
import { TypedEventEmitterV3 } from "@moopsyjs/utils";

export type AutoLoginFunctionType<AS extends MoopsyAuthenticationSpec> = (() => Promise<AS["AuthRequestType"] | null>);

export enum MoopsyClientAuthExtensionState {
  loggedIn = "loggedIn",
  loggingIn = "loggingIn",
  loggedOut = "loggedOut"
}

/**
 * MoopsyClientAuthExtension is provided as a built-in because of the way authentication is handled in Moopsy.
 */
export class MoopsyClientAuthExtension<AuthSpec extends MoopsyAuthenticationSpec> extends MoopsyClientExtensionBase{
  public state: MoopsyClientAuthExtensionState = MoopsyClientAuthExtensionState.loggedOut;
  public readonly id: string = Math.random().toString();
  public readonly emitter = new TypedEventEmitterV3<{
    [MoopsyClientAuthExtensionState.loggedOut]: null,
    [MoopsyClientAuthExtensionState.loggingIn]: null,
    [MoopsyClientAuthExtensionState.loggedIn]: AuthSpec["PublicAuthType"],
    ["auto-login-failure"]: Error
  }>;
  
  private _isAttemptingAutoLogin: boolean = false;
  private currentAuth: AuthSpec["PublicAuthType"] | null = null;
  private readonly autoLoginFunction: AutoLoginFunctionType<AuthSpec> | null;

  public readonly logout = (): void => {
    this.currentAuth = null;
    this.state = MoopsyClientAuthExtensionState.loggedOut;
    this.emitter.emit(MoopsyClientAuthExtensionState.loggedOut, null);
  };

  public readonly login = async (params: AuthSpec["AuthRequestType"]): Promise<void> => {
    this.state = MoopsyClientAuthExtensionState.loggingIn;
    
    void this.client.awaitConnected();

    const promise = new Promise<void>((resolve, reject) => {
      const successHandler = () => {
        resolve();
        this.state = MoopsyClientAuthExtensionState.loggedIn;
        this.client.incomingMessageEmitter.off(MoopsyRawServerToClientMessageEventEnum.AUTH_SUCCESS, successHandler);
      };

      const failureHandler = (err: Error) => {
        const error = isMoopsyError(err) ? new MoopsyError(err.code, err.error, err.description) : new Error(err.message);
        reject(error);
        this.state = MoopsyClientAuthExtensionState.loggedOut;
        this.client.incomingMessageEmitter.off(MoopsyRawServerToClientMessageEventEnum.AUTH_ERROR, failureHandler);
      };

      this.client.incomingMessageEmitter.on(MoopsyRawServerToClientMessageEventEnum.AUTH_SUCCESS, successHandler);
      this.client.incomingMessageEmitter.on(MoopsyRawServerToClientMessageEventEnum.AUTH_ERROR, failureHandler);
    });

    this.client.send({
      message: {
        event: MoopsyRawClientToServerMessageEventEnum.AUTH_LOGIN,
        data: params
      },
      requireAuth: false
    });
    
    return promise;
  };

  public readonly handleLoginEvent = (auth: AuthSpec["PublicAuthType"]): void => {
    this.currentAuth = auth;
    this.state = MoopsyClientAuthExtensionState.loggedIn;
    this.emitter.emit(MoopsyClientAuthExtensionState.loggedIn, auth);
    this.client._emitter.emit("auth-extension/logged-in", undefined);
  };

  private readonly attemptAutoLogin = (): void => {
    if(this._isAttemptingAutoLogin === true) {
      return;
    }

    createTimeout(async (cancel) => {
      try {
        if(this.autoLoginFunction == null) {
          return;
        }
        
        const res = await this.autoLoginFunction();

        cancel();
        
        if(res != null) {
          this.login(res).then(this.client.handleOutboxFlushRequest).catch((err) => {
            this.emitter.emit("auto-login-failure", err);
          });
        }
      }
      catch(err) {
        this.emitter.emit("auto-login-failure", err as Error);
      }
    }, 10000)
      .then(() => {
        this._isAttemptingAutoLogin = false;
      })
      .catch(() => {
        this.emitter.emit("auto-login-failure", new TimeoutError("auto-login"));
        this._isAttemptingAutoLogin = false;
      })
    ;
  };

  private readonly handleTransportStatusChange = (status: TransportStatus): void => {
    if(this.client._closed === true) return;

    if(status !== TransportStatus.connected) {
      this.logout();
    }
    if(status === TransportStatus.connected) {
      this.attemptAutoLogin();
    }
  };

  public readonly useAuthStatus = (): MoopsyClientAuthExtensionState => {
    const [v,s] = React.useState<MoopsyClientAuthExtensionState>(this.state);

    React.useEffect(() => {
      const loginHandler = () => s(MoopsyClientAuthExtensionState.loggedIn);
      const loggingInHandler = () => s(MoopsyClientAuthExtensionState.loggingIn);
      const logoutHandler = () => s(MoopsyClientAuthExtensionState.loggedOut);

      this.emitter.on(MoopsyClientAuthExtensionState.loggedIn, loginHandler);
      this.emitter.on(MoopsyClientAuthExtensionState.loggingIn, loggingInHandler);
      this.emitter.on(MoopsyClientAuthExtensionState.loggedOut, logoutHandler);

      return () => {
        this.emitter.off(MoopsyClientAuthExtensionState.loggedIn, loginHandler);
        this.emitter.off(MoopsyClientAuthExtensionState.loggingIn, loggingInHandler);
        this.emitter.off(MoopsyClientAuthExtensionState.loggedOut, logoutHandler);
      };
    }, []);

    return v;
  };

  public readonly useAuthState = (): AuthSpec["PublicAuthType"] | null => {
    const [v,s] = React.useState<AuthSpec["PublicAuthType"] | null>(this.currentAuth);

    React.useEffect(() => {
      const loginHandler = (a:AuthSpec["PublicAuthType"]) => s(a);
      const logoutHandler = () => s(null);

      this.emitter.on(MoopsyClientAuthExtensionState.loggedIn, loginHandler);
      this.emitter.on(MoopsyClientAuthExtensionState.loggedOut, logoutHandler);

      return () => {
        this.emitter.off(MoopsyClientAuthExtensionState.loggedIn, loginHandler);
        this.emitter.off(MoopsyClientAuthExtensionState.loggedOut, logoutHandler);  
      };
    }, []);

    return v;
  };  

  /**
   * The function you pass should be useCallback'd
   */
  public readonly useOnAuthError = (fn:() => void): void => {
    React.useEffect(() => {
      this.client.incomingMessageEmitter.on(MoopsyRawServerToClientMessageEventEnum.AUTH_ERROR, fn);

      return () => {
        this.client.incomingMessageEmitter.off(MoopsyRawServerToClientMessageEventEnum.AUTH_ERROR, fn);
      };
    }, [fn]);
  };

  public readonly onAutoLoginFailure = (fn:(err:Error) => void): void => {
    this.emitter.on("auto-login-failure", fn);
  };

  public constructor(client: MoopsyClient, opts:{ autoLoginFunction: AutoLoginFunctionType<AuthSpec> | null }) {
    super(client);

    this.client._authExtensionSlot = this;

    this.autoLoginFunction = opts.autoLoginFunction;

    this.client.incomingMessageEmitter.on(MoopsyRawServerToClientMessageEventEnum.AUTH_SUCCESS, this.handleLoginEvent);
    this.client.on.transportStatusChange(this.handleTransportStatusChange);
  }

  public on = {
    authSuccess: (fn: (auth: AuthSpec["PublicAuthType"]) => void): void => {
      this.client.incomingMessageEmitter.on(MoopsyRawServerToClientMessageEventEnum.AUTH_SUCCESS, fn);
    },
    authError: (fn: (err: Error) => void): void => {
      this.client.incomingMessageEmitter.on(MoopsyRawServerToClientMessageEventEnum.AUTH_ERROR, fn);
    }
  };

  public off = {
    authSuccess: (fn: (auth: AuthSpec["PublicAuthType"]) => void): void => {
      this.client.incomingMessageEmitter.off(MoopsyRawServerToClientMessageEventEnum.AUTH_SUCCESS, fn);
    },
    authError: (fn: (err: Error) => void): void => {
      this.client.incomingMessageEmitter.off(MoopsyRawServerToClientMessageEventEnum.AUTH_ERROR, fn);
    }
  };  
}