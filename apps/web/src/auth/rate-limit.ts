const WINDOW_MS = 60_000;
const MAX_REQUESTS = 100; // 100 requests per minute

const hits = new Map<string, number[]>();

export async function checkRateLimit({ request }: { request: Request }) {
	const ip = request.headers.get("x-forwarded-for") ?? "anonymous";
	const now = Date.now();
	const timestamps = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
	timestamps.push(now);
	hits.set(ip, timestamps);
	const success = timestamps.length <= MAX_REQUESTS;
	return { success, limited: !success };
}
