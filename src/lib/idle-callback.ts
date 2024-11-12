export type IdleCallbackHandle = number;

export function requestIdleCallbackSafe(
  fn: (deadline: IdleDeadline) => void,
  ms: number = 100
): IdleCallbackHandle {
  if (typeof (window as any)?.requestIdleCallback === "function") {
    return (window as any).requestIdleCallback(fn, { timeout: ms });
  } else {
    return setTimeout(() => {
      const deadline: IdleDeadline = {
        didTimeout: false,
        timeRemaining: () => Math.max(0, ms - Date.now()),
      };
      fn(deadline);
    }, ms);
  }
}

interface IdleDeadline {
    readonly didTimeout: boolean;
    timeRemaining(): number;
}