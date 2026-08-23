import { createCopilotServiceAdapter } from '../../../lib/copilot-service-adapter.mjs';
import {
  assertRateLimit,
  createBoundedRequestBody,
  jsonError,
  requireSession,
} from '../../../lib/session.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const session = requireSession(request, { requireCsrf: false });
    assertRateLimit('copilotkit', session.subject, { limit: 60, windowMs: 60_000 });
    const boundedRequest = await createBoundedRequestBody(request, { maxBytes: 1024 * 1024 });
    const kit = await import('@copilotkit/runtime');
    const Runtime = kit.CopilotRuntime;
    const endpointFactory = kit.copilotRuntimeNextJSAppRouterEndpoint;
    if (typeof Runtime !== 'function' || typeof endpointFactory !== 'function') {
      const error = new Error('Installed CopilotKit runtime is incompatible');
      error.status = 503;
      throw error;
    }

    const runtime = new Runtime();
    const { serviceAdapter } = await createCopilotServiceAdapter({
      kit,
      env: process.env,
      createOpenAI: async ({ apiKey, baseURL }) => {
        const { default: OpenAI } = await import('openai');
        return new OpenAI({ apiKey, baseURL });
      },
    });

    const endpoint = endpointFactory({
      runtime,
      serviceAdapter,
      endpoint: '/api/copilotkit',
    });
    if (!endpoint || typeof endpoint.handleRequest !== 'function') {
      const error = new Error('CopilotKit endpoint could not be initialized');
      error.status = 503;
      throw error;
    }
    return endpoint.handleRequest(boundedRequest);
  } catch (error) {
    if (!error?.status) error.status = 503;
    return jsonError(error);
  }
}
