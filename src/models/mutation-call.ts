import { MoopsyBlueprintPlugType, MoopsyCallSideEffectType, MoopsyCallType, MoopsyError } from "@moopsyjs/core";
import { MoopsyMutation } from "./mutation";
import { TimeoutError } from "./errors/timeout-error";
import { UseMoopsyQueryRetValBase } from "./client";
import { isMoopsyError } from "../lib/is-moopsy-error";
import { TypedEventEmitterV3 } from "@moopsyjs/utils";

function generateMutationId (): string {
  return Math.random().toString();
}

function determineSideEffects (querySideEffects?: Array<UseMoopsyQueryRetValBase<any> | null>): Array<MoopsyCallSideEffectType> {
  return querySideEffects
    ? querySideEffects.filter((sideEffect): sideEffect is UseMoopsyQueryRetValBase<any> => sideEffect != null).map((query, index) => ({
      sideEffectId: index,
      method: query._.endpoint,
      params: query._.params,                
    }))
    : [];
}

export class MutationCall<Plug extends MoopsyBlueprintPlugType>{
  public readonly callId: string;
  private failed: boolean = false;
  private readonly emitter = new TypedEventEmitterV3<{
    response: Plug["response"],
    error: MoopsyError
  }>();
  
  public constructor(private readonly mutation: MoopsyMutation<Plug>) {
    this.callId = generateMutationId();

    this.mutation.client.incomingMessageEmitter.on(`response.${this.callId}`, (data: Plug["response"] | MoopsyError) => {
      if(!this.failed) {
        if(isMoopsyError(data)) {
          this.declareFailure(data);
        }
        else {
          this.emitter.emit("response", data);
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

  public readonly call = (params: Plug["params"]): typeof this => {
    const sideEffects = determineSideEffects(this.mutation.querySideEffects);

    const message: MoopsyCallType = { 
      method: this.mutation.plug.Endpoint,
      params,
      callId: this.callId,
      sideEffects,
    };

    const timeout = setTimeout(() => {
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

    this.mutation.client.send({
      message: {
        event: "call",
        data: message
      },
      requireAuth: this.mutation.plug.isPublic !== true
    });   
    
    return this;
  };
}