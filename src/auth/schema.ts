import { Type, type Static } from "@sinclair/typebox";

export const JwtPayload = Type.Object({
    id: Type.String(),
    name: Type.String(),
    email: Type.String(),
    roles: Type.String(),
    iat: Type.Number(),
    exp: Type.Number()
});

export type JwtPayloadType = Static<typeof JwtPayload>;