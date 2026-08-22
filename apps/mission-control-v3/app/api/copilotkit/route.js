import { requireSession } from '../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    requireSession(request, { requireCsrf: false });
    const kit = await import('@copilotkit/runtime');
    const Runtime = kit.CopilotRuntime;
    const endpointFactory = kit.copilotRuntimeNextJSAppRouterEndpoint;
    if (typeof Runtime !== 'function' || typeof endpointFactory !== 'function') {
      return Response.json({ error: 'Installed CopilotKit runtime is incompatible' }, { status: 503 });
    }

    const runtime = new Runtime();
    let serviceAdapter = null;
    const configured = Boolean(process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
    if (configured && typeof kit.OpenAIAdapter === 'function') {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL,
      });
      serviceAdapter = new kit.OpenAIAdapter({
        openai,
        model: process.env.OPENAI_MODEL,
      });
    } else if (typeof kit.ExperimentalEmptyAdapter === 'function') {
      serviceAdapter = new kit.ExperimentalEmptyAdapter();
    }

    if (!serviceAdapter) {
      return Response.json({ error: 'CopilotKit service adapter is unavailable' }, { status: 503 });
    }

    const endpoint = endpointFactory({
      runtime,
      serviceAdapter,
      endpoint: '/api/copilotkit',
    });
    if (!endpoint || typeof endpoint.handleRequest !== 'function') {
      return Response.json({ error: 'CopilotKit endpoint could not be initialized' }, { status: 503 });
    }
    return endpoint.handleRequest(request);
  } catch {
    return Response.json({ error: 'CopilotKit runtime request failed' }, { status: 503 });
  }
}
