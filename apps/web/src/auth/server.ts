import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/db";
import { webEnv } from "@/env/web";

export const auth = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
		usePlural: true,
	}),
	secret: webEnv.BETTER_AUTH_SECRET,
	user: {
		deleteUser: {
			enabled: true,
		},
	},
	emailAndPassword: {
		enabled: true,
	},
	baseURL: webEnv.NEXT_PUBLIC_SITE_URL,
	appName: "OpenCut",
	trustedOrigins: [webEnv.NEXT_PUBLIC_SITE_URL],
});

export type Auth = typeof auth;
