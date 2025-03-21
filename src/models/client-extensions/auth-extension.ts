import { MoopsyAuthenticationSpec, MoopsyError, MoopsyRawClientToServerMessageEventEnum, MoopsyRawServerToClientMessageEventEnum } from "@moopsyjs/core";
import { MoopsyClient } from "../client";
import { MoopsyClientExtensionBase } from "./base";
import React from "react";
import { createTimeout } from "../../lib/timeout";
import { TimeoutError } from "../errors/timeout-error";
import { isMoopsyError } from "../../lib/is-moopsy-error";
import { TransportStatus } from "../comms/websocket-comm";
import { TypedEventEmitterV3 } from "@moopsyjs/toolkit";
import { MoopsyRequest } from "../request";

export type AutoLoginFunctionType<AS extends MoopsyAuthenticationSpec> = (() => Promise<AS["AuthRequestType"] | null>);

export enum AuthExtensionStatus {
  loggedIn = "loggedIn",
  loggingIn = "loggingIn",
  loggedOut = "loggedOut"
}
export { AuthExtensionStatus as MoopsyClientAuthExtensionState }; // Backwards compatibility for pre 1.0.3

/**
 * MoopsyClientAuthExtension is provided as a built-in because of the way authentication is handled in Moopsy.
 */
export class MoopsyClientAuthExtension<AuthSpec extends MoopsyAuthenticationSpec> extends MoopsyClientExtensionBase{
  public status: AuthExtensionStatus;
  public readonly id: string = Math.random().toString();
  public readonly emitter = new TypedEventEmitterV3<{
    [AuthExtensionStatus.loggedOut]: null,
    [AuthExtensionStatus.loggingIn]: null,
    [AuthExtensionStatus.loggedIn]: AuthSpec["PublicAuthType"],
    ["auto-login-failure"]: Error
  }>;
  
  private _isAttemptingAutoLogin: boolean = false;
  private currentAuth: AuthSpec["PublicAuthType"] | null = null;
  private readonly autoLoginFunction: AutoLoginFunctionType<AuthSpec> | null;

  private readonly _debug = (...args:any[]): void => {
    this.client._debug("[AuthExtension]", ...args);
  };

  public readonly logout = (): void => {
    this.currentAuth = null;
    this.updateStatus(AuthExtensionStatus.loggedOut);
  };

  private readonly updateStatus = (status: AuthExtensionStatus, data: any = null): void => {
    this.status = status;
    this.emitter.emit(status, data);
    this._debug("Status updated to", status, data);
  };

  public readonly login = async (params: AuthSpec["AuthRequestType"]): Promise<void> => {
    this.updateStatus(AuthExtensionStatus.loggingIn);
    
    void this.client.awaitConnected();

    const promise = new Promise<void>((resolve, reject) => {
      const successHandler = () => {
        resolve();
        this.client.incomingMessageEmitter.off(MoopsyRawServerToClientMessageEventEnum.AUTH_SUCCESS, successHandler);
      };

      const failureHandler = (err: Error) => {
        const error = isMoopsyError(err) ? new MoopsyError(err.code, err.error, err.description) : new Error(err.message);
        reject(error);
        this.updateStatus(AuthExtensionStatus.loggedOut);
        this.client.incomingMessageEmitter.off(MoopsyRawServerToClientMessageEventEnum.AUTH_ERROR, failureHandler);
      };

      this.client.incomingMessageEmitter.on(MoopsyRawServerToClientMessageEventEnum.AUTH_SUCCESS, successHandler);
      this.client.incomingMessageEmitter.on(MoopsyRawServerToClientMessageEventEnum.AUTH_ERROR, failureHandler);
    });

    this.client.send(
      new MoopsyRequest({
        event: MoopsyRawClientToServerMessageEventEnum.AUTH_LOGIN,
        data: params
      }, false, false)
    );
    
    return promise;
  };

  public readonly handleLoginEvent = (auth: AuthSpec["PublicAuthType"]): void => {
    this.currentAuth = auth;
    this.updateStatus(AuthExtensionStatus.loggedIn, auth);
    this.client._emitter.emit("auth-extension/logged-in", undefined);
  };

  private readonly handleAutoLoginFailure = (err: Error): void => {
    this._debug("Auto login failed", err);
    this.emitter.emit("auto-login-failure", err);
    this.updateStatus(AuthExtensionStatus.loggedOut);
    this._isAttemptingAutoLogin = false;
  };

  private readonly attemptAutoLogin = (): void => {
    if(this._isAttemptingAutoLogin === true) {
      return;
    }

    this._debug("Attempting auto-login");

    createTimeout(async (cancel) => {
      try {
        if(this.autoLoginFunction == null) {
          return this._debug("No auto-login function set");
        }
        
        const res = await this.autoLoginFunction();

        cancel();
        
        if(res != null) {
          this.login(res).then(() => {
            this._debug("Auto login successful");
            void this.client.handleOutboxFlushRequest();
          }).catch((err) => {
            this.handleAutoLoginFailure(err);
          });
        }
        else {
          this.handleAutoLoginFailure(new Error("Auto login function returned null"));
        }
      }
      catch(err) {
        this.handleAutoLoginFailure(err as Error);
      }
    }, 10000)
      .then(() => {
        this._isAttemptingAutoLogin = false;
      })
      .catch(() => {
        this.handleAutoLoginFailure(new TimeoutError("auto-login"));
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

  public readonly useAuthStatus = (): AuthExtensionStatus => {
    const [v,s] = React.useState<AuthExtensionStatus>(this.status);

    React.useEffect(() => {
      const loginHandler = () => s(AuthExtensionStatus.loggedIn);
      const loggingInHandler = () => s(AuthExtensionStatus.loggingIn);
      const logoutHandler = () => s(AuthExtensionStatus.loggedOut);

      this.emitter.on(AuthExtensionStatus.loggedIn, loginHandler);
      this.emitter.on(AuthExtensionStatus.loggingIn, loggingInHandler);
      this.emitter.on(AuthExtensionStatus.loggedOut, logoutHandler);

      return () => {
        this.emitter.off(AuthExtensionStatus.loggedIn, loginHandler);
        this.emitter.off(AuthExtensionStatus.loggingIn, loggingInHandler);
        this.emitter.off(AuthExtensionStatus.loggedOut, logoutHandler);
      };
    }, []);

    return v;
  };

  public readonly useAuthState = (): AuthSpec["PublicAuthType"] | null => {
    const [v,s] = React.useState<AuthSpec["PublicAuthType"] | null>(this.currentAuth);

    React.useEffect(() => {
      const loginHandler = (a:AuthSpec["PublicAuthType"]) => s(a);
      const logoutHandler = () => s(null);

      this.emitter.on(AuthExtensionStatus.loggedIn, loginHandler);
      this.emitter.on(AuthExtensionStatus.loggedOut, logoutHandler);

      return () => {
        this.emitter.off(AuthExtensionStatus.loggedIn, loginHandler);
        this.emitter.off(AuthExtensionStatus.loggedOut, logoutHandler);  
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
    this.status = this.autoLoginFunction == null ? AuthExtensionStatus.loggedOut : AuthExtensionStatus.loggingIn;

    this.client.incomingMessageEmitter.on(MoopsyRawServerToClientMessageEventEnum.AUTH_SUCCESS, this.handleLoginEvent);
    this.client.on.transportStatusChange(this.handleTransportStatusChange);

    if(this.client.getTransportStatus() === TransportStatus.connected) {
      this.attemptAutoLogin();
    }
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