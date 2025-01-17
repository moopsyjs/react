export class InvariantError extends Error {
  public constructor(public message: string) {
    super(message);
  }
}