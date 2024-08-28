import { TimeoutError } from "../models/errors/timeout-error";

export function createTimeout (tm:(r:() => void) => void, delay:number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let expired = false;

    const timeout = setTimeout(() => {
      expired = true;
      reject(
        new TimeoutError()
      );
    }, delay);

    tm(() => {
      if(expired === false) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}