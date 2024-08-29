import { MoopsyBlueprintConstsType, MoopsyBlueprintPlugType, MoopsyError } from "@moopsyjs/core";
import { MoopsyClient, UseMoopsyQueryRetValBase } from "./client";
import { TimeoutError } from "./errors/timeout-error";
import { isMoopsyError } from "../lib/is-moopsy-error";
import { MutationCall } from "./mutation-call";
import { TypedEventEmitterV3 } from "@moopsyjs/utils";

export type ActiveCallType<Plug extends MoopsyBlueprintPlugType> = {
  mutationId:string,
  startDate:Date,
  params:Plug["params"]
};

export type MoopsyMutationOptionsType = {
  querySideEffects: Array<UseMoopsyQueryRetValBase<any> | null>,
  timeout?: number,
}

export function generateMutationId (): string {
  return Math.random().toString();
}

export class MutationError extends MoopsyError {
  public constructor(code: number, error: string, description: string, public source: string) {
    super(code, error, description);
  }
}

export class MoopsyMutation<Plug extends MoopsyBlueprintPlugType> {
  public client: MoopsyClient;
  public plug: MoopsyBlueprintConstsType;
  
  public loading: boolean = false;
  public error: null | MoopsyError = null;
  public activeCalls: ActiveCallType<Plug>[] = [];
  public timeout: number = 10000;
  public changeEmitter = new TypedEventEmitterV3<{ changed: null }>();
  public querySideEffects: Array<UseMoopsyQueryRetValBase<any> | null>;

  private _fireChanged = () => {
    this.changeEmitter.emit("changed", null);
  };

  public call = async (params: Plug["params"]): Promise<Plug["response"]> => {
    this.loading = true;
    this.error = null;

    const mutationCall = new MutationCall<Plug>(this);
    const mutationId = mutationCall.callId;

    this.activeCalls = [...this.activeCalls, { mutationId, startDate: new Date(), params }];
    this._fireChanged();

    mutationCall.call(params);

    const response = await mutationCall.awaitResult();

    this.loading = false;
    const activeIndex = this.activeCalls.findIndex((call) => call.mutationId === mutationId);
    if(activeIndex !== -1) {
      this.activeCalls.splice(activeIndex, 1);
    }

    if(isMoopsyError(response)) {
      this.error = response instanceof TimeoutError ? response : new MutationError(response.code, response.error, response.description, this.plug.Endpoint);
      this._fireChanged();
      throw this.error;
    }

    const mutationResult: Plug["response"] = response.mutationResult;

    for(const sideEffectResult of response.sideEffectResults) {
      if(typeof sideEffectResult.sideEffectId === "number") {
        const query = this.querySideEffects[sideEffectResult.sideEffectId];
        if(query) {
          query._.onSideEffectResult(sideEffectResult.result);
        }
      }
    }

    this._fireChanged();

    return mutationResult;
  };

  public constructor(client: MoopsyClient, plug: MoopsyBlueprintConstsType, options: MoopsyMutationOptionsType) {
    this.client = client;
    this.plug = plug;
    this.querySideEffects = options.querySideEffects;
    if(options.timeout) {
      this.timeout = options.timeout;
    }
  }
}