import { TypedEventEmitterV3 } from "@moopsyjs/toolkit";

import { MoopsyClient } from "./client";
import { MutationCall } from "./mutation-call";

export class ReadableMoopsyStream<T> {
  private readonly id: string;
  private readonly emitter = new TypedEventEmitterV3<{
    data: T[],
    end: null
  }>();

  public constructor (input:{__moopsyStream:string}, private readonly mutationCall: MutationCall<any>, private readonly client: MoopsyClient) {
    this.id = input.__moopsyStream;

    this.client.incomingMessageEmitter.on(`response.${mutationCall.callId}.${this.id}`, (data: {
      backlog: T[],
      ended: boolean
    }) => {
      this.emitter.emit("data", data.backlog);
      if(data.ended) {
        this.emitter.emit("end", null);
      }
    });
  }

  public readonly onData = (cb:(event: T[]) => void): typeof this => {
    this.emitter.on("data", cb);
    return this;
  };

  public readonly onEnd = (cb:() => void): typeof this => {
    this.emitter.on("end", cb);
    return this;
  };
}