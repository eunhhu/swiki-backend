import { Elysia } from "elysia";
import { Type } from "@sinclair/typebox";
import { Api } from "../api/util";
import { ApiResponse } from "../api/schema";
import { AuthGuard } from "./guard";
import { JwtPayload, type JwtPayloadType } from "./schema";
import { authPlugin } from "./plugin";
import type { PrismaClient } from "@prisma/client";
import { hashPassword, verifyPassword } from "./util";
import { rateLimitGuard } from "../middleware/rateLimit";
 

interface AuthRoutesOptions {
    prisma: PrismaClient
    prefix?: string
}

export const authRoutes = (options: AuthRoutesOptions) => new Elysia({
    prefix: options.prefix
})
    .use(authPlugin)

    .group('', app => app
        .guard(rateLimitGuard({ windowMs: 60_000, max: 5, keyPrefix: 'login' }))
        .post("/login", async ({ body, accessJwt, refreshJwt, cookie, set }) => {
        const { email, password } = body;
        
        const user = await options.prisma.user.findUnique({ 
            where: { email },
            select: {
                id: true,
                email: true,
                name: true,
                password: true,
                roles: { select: { name: true } }
            }
        });
        if (!user) {
            set.status = 404;
            return Api.notFound("User not found");
        }

        const isPasswordValid = await verifyPassword(password, user.password);
        if (!isPasswordValid) {
            set.status = 401;
            return Api.unauthorized("Invalid credentials");
        }

        const accessTokenValue = await accessJwt.sign({ 
            id: user.id, 
            name: user.name, 
            email: user.email, 
            roles: user.roles.map(role => role.name).join(',')
        });
        const refreshTokenValue = await refreshJwt.sign({ id: user.id });

        cookie.accessToken?.set({
            value: accessTokenValue,
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            maxAge: 3600
        });

        cookie.refreshToken?.set({
            value: refreshTokenValue,
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            maxAge: 604800
        });

        const roles = user.roles.map(role => role.name);
        const safeUser = {
            id: user.id,
            email: user.email,
            name: user.name,
            roles
        };

        return Api.success({
            user: safeUser,
            accessToken: accessTokenValue,
            refreshToken: refreshTokenValue
        });
    }, {
        body: Type.Object({
            email: Type.String({ format: "email" }),
            password: Type.String({ minLength: 6 })
        }),
        
        response: ApiResponse(Type.Object({
            user: Type.Object({
                id: Type.String(),
                email: Type.String(),
                name: Type.String(),
                roles: Type.Array(Type.String())
            }),
            accessToken: Type.String(),
            refreshToken: Type.String()
        }))
    }))

    .group('', app => app
        .guard(rateLimitGuard({ windowMs: 3_600_000, max: 3, keyPrefix: 'register' }))
        .post("/register", async ({ body, cookie, set, accessJwt, refreshJwt }) => {
        const { email, password, name } = body;

        const existingUser = await options.prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            set.status = 409;
            return Api.conflict("User already exists");
        }
        
        const user = await options.prisma.user.create({ 
            data: { 
                email, 
                password: await hashPassword(password),
                name
            },
            include: { roles: true }
        });

        const accessTokenValue = await accessJwt.sign({ 
            id: user.id, 
            name: user.name, 
            email: user.email, 
            roles: user.roles.map(role => role.name).join(',')
        });
        const refreshTokenValue = await refreshJwt.sign({ id: user.id });

        cookie.accessToken?.set({
            value: accessTokenValue,
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            maxAge: 3600
        });

        cookie.refreshToken?.set({
            value: refreshTokenValue,
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            maxAge: 604800
        });
        
        const safeUser = {
            id: user.id,
            email: user.email,
            name: user.name,
            roles: user.roles?.map(r => r.name) ?? [] as string[]
        };
        
        set.status = 201;
        return Api.success({ user: safeUser });
    }, {
        body: Type.Object({
            email: Type.String({ format: "email" }),
            password: Type.String({ minLength: 6 }),
            name: Type.String()
        }),
        
        response: ApiResponse(Type.Object({
            user: Type.Object({
                id: Type.String(),
                email: Type.String(),
                name: Type.String(),
                roles: Type.Array(Type.String())
            })
        }))
    })

    .post("/refresh", async ({ refreshJwt, accessJwt, headers, cookie, set }) => {
        const bearer = headers["authorization"]?.split(" ")?.[1]
        const token = cookie.refreshToken?.value ?? bearer;
        const refreshPayload = token ? await refreshJwt.verify(token) as unknown as JwtPayloadType : null;
        if (!refreshPayload) {
            set.status = 401;
            return Api.unauthorized("Invalid refresh token");
        }

        const user = await options.prisma.user.findUnique({ 
            where: { id: refreshPayload.id },
            select: {
                id: true,
                email: true,
                name: true,
                roles: { select: { name: true } }
            }
        });
        if (!user) {
            set.status = 401;
            return Api.unauthorized("Invalid refresh token");
        }

        const newAccessTokenValue = await accessJwt.sign({ 
            id: user.id, 
            name: user.name, 
            email: user.email, 
            roles: user.roles.map(role => role.name).join(',')
        });

        cookie.accessToken?.set({
            value: newAccessTokenValue,
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            maxAge: 3600
        });

        return Api.success({
            accessToken: newAccessTokenValue
        });
    }, {
        response: ApiResponse(Type.Object({
            accessToken: Type.String()
        }))
    })

    .guard(AuthGuard.required())
    .get("/me", (ctx) => {
        const accessPayload = (ctx as any).accessPayload;
        return Api.success(accessPayload);
    }, {
        response: ApiResponse(JwtPayload)
    })
    .post("/logout", ({ cookie }) => {
        cookie.accessToken?.remove();
        cookie.refreshToken?.remove();

        return Api.success(null);
    }, {
        response: ApiResponse(Type.Null())
    })
)