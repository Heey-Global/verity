export class ManagedDevServerError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ManagedDevServerError';
  }
}
