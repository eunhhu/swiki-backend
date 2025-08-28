import type { Elysia } from "elysia";
import jwt from "@elysiajs/jwt";
import type { JwtPayloadType } from "./schema";
import { getRequiredEnv } from "../utils/env";

export const authPlugin = (app: Elysia) => app
  .use(jwt({
      name: "accessJwt",
      secret: getRequiredEnv('JWT_ACCESS_SECRET', 'dev-access-secret'),
      alg: "HS256",
      exp: getRequiredEnv('JWT_ACCESS_EXPIRES_IN', '1h')
  }))
  .use(jwt({
      name: "refreshJwt",
      secret: getRequiredEnv('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
      alg: "HS256",
      exp: getRequiredEnv('JWT_REFRESH_EXPIRES_IN', '7d')
  }))
  .derive(async ({ accessJwt, refreshJwt, headers, cookie: { accessToken, refreshToken } }) => {
      let accessPayload: JwtPayloadType | null = accessToken ? await accessJwt.verify(accessToken.value!) as unknown as JwtPayloadType : null;
      let refreshPayload: JwtPayloadType | null = refreshToken ? await refreshJwt.verify(refreshToken.value!) as unknown as JwtPayloadType : null;
      const token = headers["authorization"]?.split(" ")?.[1]
      if (!accessPayload && token) accessPayload = await accessJwt.verify(token) as unknown as JwtPayloadType
      return {
          accessPayload,
          refreshPayload
      }
  })