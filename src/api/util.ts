import type { ApiResponseType } from "./schema";

export class Api {
  static success<T>(data: T): ApiResponseType<T> {
    return {
      data,
      timestamp: new Date().toISOString(),
      success: true
    }
  }
  static tooManyRequests<T>(details?: T): ApiResponseType<T> {
    return {
      timestamp: new Date().toISOString(),
      success: false,
      error: {
        status: 429,
        code: "TOO_MANY_REQUESTS",
        details
      }
    }
  }
  static error<T>(status: number = 400, code: string = "BAD_REQUEST", details?: T): ApiResponseType<T> {
    return {
      timestamp: new Date().toISOString(),
      success: false,
      error: {
        status,
        code,
        details
      }
    }
  }
  static badRequest<T>(details?: T): ApiResponseType<T> {
    return {
      timestamp: new Date().toISOString(),
      success: false,
      error: {
        status: 400,
        code: "BAD_REQUEST",
        details
      }
    }
  }
  static unauthorized<T>(details?: T): ApiResponseType<T> {
    return {
      timestamp: new Date().toISOString(),
      success: false,
      error: {
        status: 401,
        code: "UNAUTHORIZED",
        details
      }
    }
  }
  static forbidden<T>(details?: T): ApiResponseType<T> {
    return {
      timestamp: new Date().toISOString(),
      success: false,
      error: {
        status: 403,
        code: "FORBIDDEN",
        details
      }
    }
  }
  static notFound<T>(details?: T): ApiResponseType<T> {
    return {
      timestamp: new Date().toISOString(),
      success: false,
      error: {
        status: 404,
        code: "NOT_FOUND",
        details
      }
    }
  }
  static conflict<T>(details?: T): ApiResponseType<T> {
    return {
      timestamp: new Date().toISOString(),
      success: false,
      error: {
        status: 409,
        code: "CONFLICT",
        details
      }
    }
  }
  static internalServerError<T>(details?: T): ApiResponseType<T> {
    return {
      timestamp: new Date().toISOString(),
      success: false,
      error: {
        status: 500,
        code: "INTERNAL_SERVER_ERROR",
        details
      }
    }
  }
}