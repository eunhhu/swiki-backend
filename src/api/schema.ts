import { Type, type Static, type TSchema } from "@sinclair/typebox";

export const ApiResponse = (dataType?: TSchema) => Type.Object({
    data: Type.Optional(dataType || Type.Any()),
    timestamp: Type.String({ format: "date-time" }),
    success: Type.Boolean(),
    error: Type.Optional(Type.Object({
        status: Type.Integer(),
        code: Type.String(),
        details: Type.Optional(Type.Any()),
    }))
})

export type ApiResponseType<T> = Omit<Static<ReturnType<typeof ApiResponse>>, "data"> & { data?: T }