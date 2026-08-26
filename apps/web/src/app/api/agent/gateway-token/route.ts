import { auth } from "@/auth/server";

/**
 * 签发 Agent Gateway 访问凭证：返回当前 better-auth session 的 token，
 * 前端携带该 token 访问 Gateway，Gateway 查共享库 sessions 表验证。
 */
export async function GET(request: Request) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	return Response.json({ token: session.session.token });
}
