import { afterEach, describe, expect, it } from "bun:test";
import * as url from "node:url";
import { callTool, connectToServer } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { getProjectDir } from "@oh-my-pi/pi-utils";

const GUARD_TIMEOUT_MS = 500;

let server: Bun.Server<undefined> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

type RpcBody = { id?: string | number; method: string; params?: Record<string, unknown> };

function mcpErrorResponse(id: string | number | undefined, status: number, code: number, message: string): Response {
	return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

describe("MCP 2026-07-28 modern discover with inline roots/list", () => {
	it("answers a server-initiated roots/list mid tools/call and returns the result", async () => {
		const rootUri = url.pathToFileURL(getProjectDir()).href;

		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const mcpMethodHeader = req.headers.get("Mcp-Method");
				const protocolVersion = req.headers.get("MCP-Protocol-Version");
				const body = (await req.json()) as RpcBody;

				if (body.method === "server/discover") {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } },
					});
				}

				if (body.method !== "tools/call") return mcpErrorResponse(body.id, 400, -32020, "mcp-method header does not match");
				if (protocolVersion !== "2026-07-28") return mcpErrorResponse(body.id, 400, -32020, "mcp-method header does not match");
				if (mcpMethodHeader !== "tools/call") return mcpErrorResponse(body.id, 400, -32020, "mcp-method header does not match");
				if (req.headers.get("Mcp-Name") !== "search") return mcpErrorResponse(body.id, 400, -32020, "mcp-method header does not match");

				const params = body.params ?? {};
				if (!("inputResponses" in params)) {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resultType: "input_required",
							inputRequests: { r: { method: "roots/list" } },
							requestState: "s1",
						},
					});
				}

				const inputResponses = params.inputResponses as { r?: { roots?: { uri?: string }[] } };
				if (params.requestState !== "s1" || inputResponses?.r?.roots?.[0]?.uri !== rootUri) {
					return mcpErrorResponse(body.id, 400, -32020, "mcp-method header does not match");
				}

				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: { resultType: "complete", content: [{ type: "text", text: rootUri }] },
				});
			},
		});

		const connection = await connectToServer("modern", {
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});
		expect(connection.protocolVersion).toBe("2026-07-28");

		const result = await callTool(connection, "search", {});
		expect(result.content).toEqual([{ type: "text", text: rootUri }]);

		await connection.transport.close();
	});

	it("falls back to the legacy initialize handshake when server/discover is unknown", async () => {
		const requests: string[] = [];
		let initialized = false;

		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					requests.push("GET");
					if (initialized) return new Response(null, { status: 405 });
					return new Response("session is not initialized", { status: 400 });
				}
				if (req.method === "DELETE") return new Response(null, { status: 204 });

				const body = (await req.json()) as RpcBody;
				requests.push(body.method);

				if (body.method === "server/discover") {
					return mcpErrorResponse(body.id, 200, -32601, "Method not found");
				}
				if (body.method === "initialize") {
					const response = {
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: {},
							serverInfo: { name: "legacy-server", version: "1.0.0" },
						},
					};
					return new Response(`event: message\ndata: ${JSON.stringify(response)}\n\n`, {
						headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "legacy-session" },
					});
				}
				initialized = true;
				return new Response(null, { status: 202 });
			},
		});

		const connection = await connectToServer("legacy", {
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});

		expect(connection.protocolVersion).toBe("2025-11-25");
		expect(requests).toEqual(["server/discover", "initialize", "notifications/initialized", "GET"]);

		await connection.transport.close();
	});
});
