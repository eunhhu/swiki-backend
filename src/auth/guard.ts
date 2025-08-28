import { Api } from "../api/util"
import type { JwtPayloadType } from "./schema"
import type { Context } from "elysia";

export class AuthGuard {
    static required() {
        const handler = ({ accessPayload, set }: { accessPayload: JwtPayloadType, set: Context['set'] }) => {
            if (!accessPayload) {
                set.status = 401;
                return Api.unauthorized()
            }
        };
        return {
            beforeHandle: handler,
            onBeforeHandle: handler
        }
    }

    static roles = {
        every: (roles: string[]) => {
            const handler = ({ accessPayload, set }: { accessPayload: JwtPayloadType, set: Context['set'] }) => {
                if (!accessPayload) {
                    set.status = 401;
                    return Api.unauthorized()
                }
                const userRoles = accessPayload.roles.split(',') || []
                const hasAllRoles = roles.every(role => userRoles.includes(role))
                if (!hasAllRoles) {
                    set.status = 403;
                    return Api.forbidden()
                }
            };
            return { beforeHandle: handler, onBeforeHandle: handler };
        },

        some: (roles: string[]) => {
            const handler = ({ accessPayload, set }: { accessPayload: JwtPayloadType, set: Context['set'] }) => {
                if (!accessPayload) {
                    set.status = 401;
                    return Api.unauthorized()
                }
                const userRoles = accessPayload.roles.split(',') || []
                const hasAnyRole = roles.some(role => userRoles.includes(role))
                if (!hasAnyRole) {
                    set.status = 403;
                    return Api.forbidden()
                }
            };
            return { beforeHandle: handler, onBeforeHandle: handler };
        },

        not: (roles: string[]) => {
            const handler = ({ accessPayload, set }: { accessPayload: JwtPayloadType, set: Context['set'] }) => {
                if (!accessPayload) {
                    set.status = 401;
                    return Api.unauthorized()
                }
                const userRoles = accessPayload.roles.split(',') || []
                const hasForbiddenRole = roles.some(role => userRoles.includes(role))
                if (hasForbiddenRole) {
                    set.status = 403;
                    return Api.forbidden()
                }
            };
            return { beforeHandle: handler, onBeforeHandle: handler };
        },

        contain: (role: string) => {
            const handler = ({ accessPayload, set }: { accessPayload: JwtPayloadType, set: Context['set'] }) => {
                if (!accessPayload) {
                    set.status = 401;
                    return Api.unauthorized()
                }
                const userRoles = accessPayload.roles.split(',') || []
                if (!userRoles.includes(role)) {
                    set.status = 403;
                    return Api.forbidden()
                }
            };
            return { beforeHandle: handler, onBeforeHandle: handler };
        }
    }
}