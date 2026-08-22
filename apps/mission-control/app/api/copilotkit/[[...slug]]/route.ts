import { CopilotRuntime, createCopilotRuntimeHandler, InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { authorize } from "@/lib/security";
import { createMissionControlCopilotAgent } from "@/lib/copilot-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const copilotRuntime = new CopilotRuntime({
  agents: { mission_control: createMissionControlCopilotAgent() },
  runner: new InMemoryAgentRunner(),
});

const handler = createCopilotRuntimeHandler({
  runtime: copilotRuntime,
  basePath: "/api/copilotkit",
  mode: "single-route",
});

async function protectedHandler(request: Request): Promise<Response> {
  const auth = authorize(request, { mutate: request.method !== "GET" && request.method !== "OPTIONS" });
  if (!auth.ok) return auth.response;
  return handler(request);
}

export const GET = protectedHandler;
export const POST = protectedHandler;
export const OPTIONS = protectedHandler;
