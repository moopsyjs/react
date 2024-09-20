export class Queue<T> {
  private _q: T[] = [];
  private _attemptFlushHandler: () => void;

  public constructor(attemptFlushHandler: () => void) {
    this._attemptFlushHandler = attemptFlushHandler;
  }

  public readonly push = (v:T) => {
    this._q.push(v);
    this._attemptFlushHandler();
  };

  public readonly flush = (filterFn?: (p:T) => boolean): T[] => {
    const spliced: T[] = [];

    for(const item of this._q) {
      if(filterFn == null || filterFn(item)) {
        spliced.push(
          ...this._q.splice(this._q.indexOf(item), 1)
        );
      }
    }

    return spliced;
  };

  public readonly length = (): number => this._q.length;
}