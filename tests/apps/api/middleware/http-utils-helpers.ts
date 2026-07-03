import { HttpJsonError } from "../../../../src/apps/api/middleware/http-utils.js";

export function httpJsonError(statusCode: number, code: string) {
  return (error: unknown) => error instanceof HttpJsonError &&
    error.statusCode === statusCode &&
    error.code === code;
}

export async function* chunks(values: string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}
