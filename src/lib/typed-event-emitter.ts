import { EventEmitter } from "events";

/**
 * Simple typed event emitter, will extract to @moopsyjs/utils eventually
 */
export class TypedEventEmitterV3<EventsType extends { [k: string]: any; }> {
  private emitter: EventEmitter;
  public constructor() {
    this.emitter = new EventEmitter;
  }

  public readonly emit = <K extends keyof EventsType>(event: K, data: EventsType[K]) => {
    this.emitter.emit(event as string, data);
  };

  public readonly on = <K extends keyof EventsType>(event: K, cb: (data: EventsType[K]) => void) => {
    this.emitter.on(event as string, cb);
  };

  public readonly once = <K extends keyof EventsType>(event: K, cb: (data: EventsType[K]) => void) => {
    this.emitter.once(event as string, cb);
  };

  public readonly off = <K extends keyof EventsType>(event: K, cb: (data: EventsType[K]) => void) => {
    this.emitter.off(event as string, cb);
  };
}