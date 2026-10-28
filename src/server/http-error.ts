/** Error with an HTTP status; app.onError turns it into `{error: message}`. */
export class HttpError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 500 | 502,
    message: string,
  ) {
    super(message);
  }
}
