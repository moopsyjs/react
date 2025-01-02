import { MoopsyBlueprintPlugType, MoopsyCallSideEffectType, MoopsyCallType, MoopsyError } from "@moopsyjs/core";
import { MoopsyMutation } from "./mutation";
import { TimeoutError } from "./errors/timeout-error";
import { UseMoopsyQueryRetValBase } from "./client";
import { isMoopsyError } from "../lib/is-moopsy-error";
import { TypedEventEmitterV3 } from "@moopsyjs/toolkit";
import { MoopsyRequest } from "./request";
import { TransportStatus } from "./transports/base";

function determineSideEffects (querySideEffects?: Array<UseMoopsyQueryRetValBase<any> | null>): Array<MoopsyCallSideEffectType> {
  return querySideEffects
    ? querySideEffects.filter((sideEffect): sideEffect is UseMoopsyQueryRetValBase<any> => sideEffect != null).map((query, index) => ({
      sideEffectId: index,
      method: query._.endpoint,
      params: query._.params,                
    }))
    : [];
}

const NO_RESPONSE = Symbol("NO_RESPONSE");

export class MutationCall<Plug extends MoopsyBlueprintPlugType> {
  public readonly callId: string;
  private failed: boolean = false;
  private readonly emitter = new TypedEventEmitterV3<{
    response: Plug["response"],
    error: MoopsyError
  }>();
  private _called: boolean = false;
  private response: Plug["response"] | typeof NO_RESPONSE = NO_RESPONSE;

  public get called (): boolean {
    return this._called;
  }

  private set called (value: boolean) {
    this._called = value;
  }

  private readonly _debug = (...args: any[]): void => {
    this.mutation.client._debug(`[MutationCall::${this.callId.slice(0,4)}]`, ...args);    
  };
  
  public constructor(private readonly mutation: MoopsyMutation<Plug>) {
    this.callId = this.mutation.client.generateId();

    this.mutation.client.incomingMessageEmitter.on(`response.${this.callId}`, (data: Plug["response"] | MoopsyError) => {
      if(!this.failed) {
        if(isMoopsyError(data)) {
          this._debug(`Received error for ${this.mutation.plug.Endpoint}`, data);
          this.declareFailure(data);
        }
        else {
          this._debug(`Received response for ${this.mutation.plug.Endpoint}`);
          this.emitter.emit("response", data);
          this.response = data;
        }
      }
    });
  }

  public readonly onSuccess = (cb: (p:Plug["response"]) => void): typeof this => {
    this.emitter.on("response", cb);
    return this;
  };

  public readonly onFailure = (cb: (p:MoopsyError) => void): typeof this => {
    this.emitter.on("error", cb);
    return this;
  };

  public readonly awaitResult = (): Promise<Plug["response"] | MoopsyError> => {
    if(this.response !== NO_RESPONSE) {
      return Promise.resolve(this.response);
    }

    return new Promise<Plug["response"]>((resolve) => {
      this.onSuccess(resolve);
      this.onFailure(resolve);
    });
  };

  public readonly declareFailure = (error: MoopsyError): void => {
    if(this.failed) return;

    this.failed = true;
    this.emitter.emit("error", error);
  };

  public readonly callMutation = async (params: Plug["params"]): Promise<
    MutationCall<Plug>
  > => {
    if(this.called) {
      throw new Error("MutationCall.call() was called more than once.");
    }

    this.called = true;

    const sideEffects = determineSideEffects(this.mutation.querySideEffects);

    const message: MoopsyCallType = { 
      method: this.mutation.plug.Endpoint,
      params,
      callId: this.callId,
      sideEffects,
    };

    if(this.mutation.client.getTransportStatus() !== TransportStatus.connected) {
      this._debug("Transport is not connected, will await connection before sending");

      await this.mutation.client.awaitConnected();
    }

    const timeout = setTimeout(() => {
      this._debug("Request timed out waiting for a response from the server");

      this.declareFailure(
        new TimeoutError(this.mutation.plug.Endpoint)
      );
    }, this.mutation.timeout);    

    this.mutation.client.activeCalls.add(this);

    const makeInactive = (): void => {
      this.mutation.client.activeCalls.delete(this);
      clearTimeout(timeout);
    };

    this.onSuccess(makeInactive);
    this.onFailure(makeInactive);

    this._debug(`Sending call for ${this.mutation.plug.Endpoint}`);

    this.mutation.client.send(
      new MoopsyRequest({
        event: "call",
        data: message
      }, this.mutation.plug.isPublic !== true, !this.mutation.isQuery)
    );
    
    return this;
  };
}