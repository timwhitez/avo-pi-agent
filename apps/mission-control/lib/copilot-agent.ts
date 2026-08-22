import crypto from "node:crypto";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { EventType, type BaseEvent } from "@ag-ui/client";

const SYSTEM_PROMPT = `You are the AVO Mission Control copilot. You may use only the frontend tools supplied by the application. Help the operator start, pause, resume, abort, inspect, replay, and compare ARC-AGI-3 runs. Never request, display, infer, or repeat provider endpoints, model identifiers, API keys, ARC credentials, raw reasoning, or unrestricted payloads. Explain destructive actions before invoking them, and require the exact abort confirmation phrase provided by the application.`;

export function createMissionControlCopilotAgent() {
  return new BuiltInAgent({
    type: "custom",
    factory: async function* ({ input, abortSignal }) {
      const provider = requireProviderConfig();
      const response = await fetch(`${provider.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: provider.model,
          input: toResponsesInput(input.messages),
          instructions: SYSTEM_PROMPT,
          tools: toResponsesTools(input.tools),
          tool_choice: "auto",
          parallel_tool_calls: false,
          reasoning: { effort: provider.reasoningEffort },
          stream: true,
          store: false,
        }),
        signal: abortSignal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Mission Control copilot provider returned HTTP ${response.status}`);
      }

      const messageId = crypto.randomUUID();
      const toolByItem = new Map<string, { callId: string; name: string; ended: boolean }>();
      for await (const event of decodeResponsesStream(response.body)) {
        const type = String(event.type || "");
        if (type === "response.output_text.delta" && typeof event.delta === "string") {
          yield {
            type: EventType.TEXT_MESSAGE_CHUNK,
            role: "assistant",
            messageId,
            delta: event.delta,
          } as BaseEvent;
          continue;
        }

        if (type === "response.output_item.added" && event.item?.type === "function_call") {
          const itemId = String(event.item.id || crypto.randomUUID());
          const callId = String(event.item.call_id || event.item.id || crypto.randomUUID());
          const name = String(event.item.name || "unknown_tool");
          toolByItem.set(itemId, { callId, name, ended: false });
          yield {
            type: EventType.TOOL_CALL_START,
            parentMessageId: messageId,
            toolCallId: callId,
            toolCallName: name,
          } as BaseEvent;
          if (event.item.arguments) {
            yield {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: callId,
              delta: String(event.item.arguments),
            } as BaseEvent;
          }
          continue;
        }

        if (type === "response.function_call_arguments.delta") {
          const item = getTool(event, toolByItem, messageId);
          if (item && typeof event.delta === "string") {
            yield {
              type: EventType.TOOL_CALL_ARGS,
              toolCallId: item.callId,
              delta: event.delta,
            } as BaseEvent;
          }
          continue;
        }

        if (type === "response.function_call_arguments.done" ||
            (type === "response.output_item.done" && event.item?.type === "function_call")) {
          const item = getTool(event, toolByItem, messageId);
          if (item && !item.ended) {
            item.ended = true;
            yield { type: EventType.TOOL_CALL_END, toolCallId: item.callId } as BaseEvent;
          }
          continue;
        }

        if (type === "error" || type === "response.failed") {
          throw new Error("Mission Control copilot provider stream failed");
        }
      }

      for (const item of toolByItem.values()) {
        if (!item.ended) yield { type: EventType.TOOL_CALL_END, toolCallId: item.callId } as BaseEvent;
      }
    },
  });
}

type StreamEvent = Record<string, any>;

async function* decodeResponsesStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try { yield JSON.parse(data); } catch {}
    }
    if (done) break;
  }
}

function getTool(event: StreamEvent, tools: Map<string, { callId: string; name: string; ended: boolean }>, messageId: string) {
  const itemId = String(event.item_id || event.item?.id || "");
  let item = itemId ? tools.get(itemId) : undefined;
  if (item) return item;
  const callId = String(event.call_id || event.item?.call_id || event.item?.id || crypto.randomUUID());
  const name = String(event.name || event.item?.name || "unknown_tool");
  item = { callId, name, ended: false };
  tools.set(itemId || callId, item);
  void messageId;
  return item;
}

function toResponsesInput(messages: unknown): unknown[] {
  const list = Array.isArray(messages) ? messages : [];
  const output: unknown[] = [];
  for (const raw of list) {
    const message = raw as Record<string, any>;
    const role = String(message.role || "user");
    if (role === "tool") {
      output.push({
        type: "function_call_output",
        call_id: String(message.toolCallId || message.tool_call_id || message.id || "unknown"),
        output: contentText(message.content),
      });
      continue;
    }
    if (!["user", "assistant", "developer", "system"].includes(role)) continue;
    output.push({
      role: role === "system" ? "developer" : role,
      content: contentText(message.content),
    });
  }
  return output.length ? output : [{ role: "user", content: "Inspect the current Mission Control state." }];
}

function toResponsesTools(tools: unknown): unknown[] {
  const list = Array.isArray(tools) ? tools : [];
  return list.flatMap((raw) => {
    const tool = raw as Record<string, any>;
    const name = String(tool.name || "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return [];
    return [{
      type: "function",
      name,
      description: String(tool.description || "Mission Control frontend tool").slice(0, 2_000),
      parameters: tool.parameters || tool.inputSchema || { type: "object", properties: {}, additionalProperties: false },
      strict: false,
    }];
  });
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 200_000);
  if (!Array.isArray(content)) return JSON.stringify(content ?? "").slice(0, 200_000);
  return content.map((block: any) => {
    if (typeof block === "string") return block;
    return block?.text || block?.content || block?.value || "";
  }).join("\n").slice(0, 200_000);
}

function requireProviderConfig() {
  const baseUrl = String(process.env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  const apiKey = String(process.env.OPENAI_API_KEY || "");
  const model = String(process.env.OPENAI_MODEL || "");
  const reasoningEffort = String(process.env.OPENAI_REASONING_EFFORT || "max");
  if (!baseUrl || !apiKey || !model) throw new Error("Mission Control Provider configuration is unavailable");
  return { baseUrl, apiKey, model, reasoningEffort };
}
