export class Queue<T> {
  _q: T[] = [];
  _attemptFlushHandler: () => void;

  constructor(attemptFlushHandler: () => void) {
    this._attemptFlushHandler = attemptFlushHandler;
  }

  push = (v:T) => {
    this._q.push(v);
    this._attemptFlushHandler();
  };

  flush = (filterFn?: (p:T) => boolean): T[] => {
    const spliced: T[] = [];

    this._q.forEach((item, index) => {
      if(filterFn == null || filterFn(item)) {
        spliced.push(
          this._q.splice(index, 1)[0]
        );
      }
    });

    return spliced;
  };

  public readonly length = (): number => this._q.length;
}