import { describe, expect, test } from "bun:test";
import {
  mapResponsesOutputToAnthropicContent,
  sanitizeToolFields,
  toResponsesInput,
} from "../src/anthropic-responses.ts";
import { adaptAnthropicMessagesRequestForResponses } from "../src/proxy.ts";
import { mapAnthropicToolsToResponsesTools } from "../src/tool-schema.ts";
import { rewriteRequestPath } from "../src/upstream.ts";

describe("responses bridge", () => {
  test("maps anthropic messages with tool events into Responses input", () => {
    const mapped = toResponsesInput([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "grep", input: { pattern: "foo" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "bar" }] }],
      },
    ]);

    expect(mapped).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      {
        type: "function_call",
        call_id: "toolu_1",
        name: "grep",
        arguments: '{"pattern":"foo"}',
      },
      {
        type: "function_call_output",
        call_id: "toolu_1",
        output: "bar",
      },
    ]);
  });

  test("maps anthropic image blocks into Responses input_image parts", () => {
    const mapped = toResponsesInput([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "AAAABBBB",
            },
          },
          {
            type: "image",
            source: {
              type: "url",
              url: "https://example.com/cat.png",
            },
          },
          {
            type: "image",
            source: {
              type: "file",
              file_id: "file_123",
            },
          },
          {
            type: "image",
            source: {
              type: "base64",
              mediaType: "image/jpeg",
              data: "/9j/4AAQ",
            },
          },
          { type: "text", text: "What is in these images?" },
        ],
      },
    ]);

    expect(mapped).toEqual([
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,AAAABBBB" },
          { type: "input_image", image_url: "https://example.com/cat.png" },
          { type: "input_image", file_id: "file_123" },
          { type: "input_image", image_url: "data:image/jpeg;base64,/9j/4AAQ" },
          { type: "input_text", text: "What is in these images?" },
        ],
      },
    ]);
  });

  test("maps anthropic document blocks into Responses input_file parts", () => {
    const mapped = toResponsesInput([
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERi0xLjcK",
            },
            filename: "report.pdf",
          },
          { type: "text", text: "Summarize this PDF" },
        ],
      },
    ]);

    expect(mapped).toEqual([
      {
        role: "user",
        content: [
          { type: "input_file", file_data: "JVBERi0xLjcK", filename: "report.pdf" },
          { type: "input_text", text: "Summarize this PDF" },
        ],
      },
    ]);
  });

  test("preserves structured tool_result content and tool_result images", () => {
    const mapped = toResponsesInput([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "tool_reference", tool_name: "web.run" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "AAAABBBB",
                },
              },
              { type: "search_result", title: "Example", url: "https://example.com" },
            ],
          },
        ],
      },
    ]);

    expect(mapped).toEqual([
      {
        type: "function_call_output",
        call_id: "toolu_1",
        output: [
          { type: "input_text", text: '{"type":"tool_reference","tool_name":"web.run"}' },
          { type: "input_image", image_url: "data:image/png;base64,AAAABBBB" },
          {
            type: "input_text",
            text: '{"type":"search_result","title":"Example","url":"https://example.com"}',
          },
        ],
      },
    ]);
  });

  test("converts anthropic tool schema to strict Responses tool schema", () => {
    const mapped = mapAnthropicToolsToResponsesTools([
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            encoding: { type: "string", enum: ["utf8", "base64"] },
          },
          required: ["path"],
        },
      },
    ]);

    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      type: "function",
      name: "read_file",
      strict: true,
    });
    expect(mapped[0].parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });

  test("maps anthropic web search beta tool to Responses web_search tool", () => {
    const mapped = mapAnthropicToolsToResponsesTools([
      {
        type: "web_search_20250305",
        name: "web_search",
        allowed_domains: ["tenki.jp", "www.jma.go.jp"],
        blocked_domains: ["example.com"],
        max_uses: 8,
      },
    ]);

    expect(mapped).toEqual([
      {
        type: "web_search",
        filters: {
          allowed_domains: ["tenki.jp", "www.jma.go.jp"],
        },
      },
    ]);
  });

  test("adapts anthropic message request for Responses API", () => {
    const adapted = adaptAnthropicMessagesRequestForResponses(
      {
        model: "claude-sonnet-4-6",
        system: [{ type: "text", text: "Be concise." }],
        messages: [
          { role: "user", content: [{ type: "text", text: "Find foo" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "grep", input: { pattern: "foo" } }],
          },
        ],
        tools: [
          {
            name: "grep",
            description: "Search files",
            defer_loading: true,
            input_schema: {
              type: "object",
              properties: {
                pattern: { type: "string" },
              },
              required: ["pattern"],
            },
          },
          {
            name: "ToolSearch",
            description: "internal",
            input_schema: { type: "object", properties: {} },
          },
        ],
        tool_choice: { type: "any" },
        stream: false,
        max_tokens: 1024,
        output_config: { effort: "high" },
        context_management: { foo: "bar" },
        temperature: 0.2,
      },
      {
        forcedModel: "gpt-5.3-codex",
        defaultReasoningEffort: "xhigh",
        preserveClientEffort: false,
        debug: false,
        safeMode: true,
        upstreamWireApi: "responses",
      }
    );

    expect(adapted.instructions).toBe("Be concise.");
    expect(adapted.input).toHaveLength(2);
    expect(adapted.tools).toHaveLength(2);
    expect(adapted.tools[0]).toMatchObject({ name: "grep", type: "function", strict: true });
    expect(adapted.tool_choice).toBe("required");
    expect(adapted.reasoning).toMatchObject({ effort: "high" });
    expect(adapted.max_output_tokens).toBe(1024);
    expect(adapted.stream).toBe(false);
    expect(adapted.include).toBeUndefined();
    expect(adapted.messages).toBeUndefined();
    expect(adapted.system).toBeUndefined();
    expect(adapted.max_tokens).toBeUndefined();
    expect(adapted.context_management).toBeUndefined();
    expect(adapted.temperature).toBeUndefined();
    expect(adapted.store).toBe(false);
  });

  test("omits max_output_tokens for chatgpt codex compatibility mode", () => {
    const adapted = adaptAnthropicMessagesRequestForResponses(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ type: "text", text: "Find foo" }] }],
        max_tokens: 1024,
      },
      {
        forcedModel: "gpt-5.3-codex",
        defaultReasoningEffort: "xhigh",
        preserveClientEffort: false,
        debug: false,
        safeMode: false,
        upstreamWireApi: "responses",
      },
      true
    );

    expect(adapted.max_output_tokens).toBeUndefined();
  });

  test("adds web search sources include when web_search tool is present", () => {
    const adapted = adaptAnthropicMessagesRequestForResponses(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ type: "text", text: "Find weather" }] }],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            allowed_domains: ["tenki.jp"],
          },
        ],
      },
      {
        forcedModel: "gpt-5.3-codex",
        defaultReasoningEffort: "xhigh",
        preserveClientEffort: false,
        debug: false,
        safeMode: false,
        upstreamWireApi: "responses",
      }
    );

    expect(adapted.tools).toEqual([{ type: "web_search", filters: { allowed_domains: ["tenki.jp"] } }]);
    expect(adapted.include).toEqual(["web_search_call.action.sources"]);
  });

  test("adds web research policy when both WebSearch and WebFetch are available", () => {
    const adapted = adaptAnthropicMessagesRequestForResponses(
      {
        model: "claude-sonnet-4-6",
        system: [{ type: "text", text: "Answer precisely." }],
        messages: [{ role: "user", content: [{ type: "text", text: "What is the weather today?" }] }],
        tools: [
          {
            name: "WebSearch",
            description: "Search the web",
            input_schema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
            },
          },
          {
            name: "WebFetch",
            description: "Fetch a web page",
            input_schema: {
              type: "object",
              properties: {
                url: { type: "string" },
                prompt: { type: "string" },
              },
              required: ["url", "prompt"],
            },
          },
        ],
      },
      {
        forcedModel: "gpt-5.3-codex",
        defaultReasoningEffort: "xhigh",
        preserveClientEffort: false,
        debug: false,
        safeMode: false,
        upstreamWireApi: "responses",
      }
    );

    expect(adapted.instructions).toContain("Answer precisely.");
    expect(adapted.instructions).toContain("Web research policy:");
    expect(adapted.instructions).toContain("Treat WebSearch as URL discovery only.");
    expect(adapted.instructions).toContain("use WebFetch on the 1-3 most relevant URLs before answering.");
  });

  test("maps Responses function calls back to anthropic tool_use blocks", () => {
    const mapped = mapResponsesOutputToAnthropicContent([
      {
        type: "message",
        content: [{ type: "output_text", text: "Checking files" }],
      },
      {
        type: "function_call",
        call_id: "toolu_2",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
    ]);

    expect(mapped.stopReason).toBe("tool_use");
    expect(mapped.content).toEqual([
      { type: "text", text: "Checking files" },
      { type: "tool_use", id: "toolu_2", name: "read_file", input: { path: "README.md" } },
    ]);
  });

  test("maps Responses web_search_call and citations back to anthropic search blocks", () => {
    const mapped = mapResponsesOutputToAnthropicContent([
      {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: {
          type: "search",
          query: "2026年4月1日 下北沢 天気",
        },
      },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "下北沢は晴れです。",
            annotations: [
              {
                type: "url_citation",
                url: "https://tenki.jp/",
                title: "tenki.jp",
              },
              {
                type: "url_citation",
                url_citation: {
                  url: "https://www.jma.go.jp/",
                  title: "気象庁",
                },
              },
            ],
          },
        ],
      },
    ]);

    expect(mapped.stopReason).toBe("end_turn");
    expect(mapped.content).toEqual([
      {
        type: "server_tool_use",
        id: "ws_1",
        name: "web_search",
        input: { query: "2026年4月1日 下北沢 天気" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "ws_1",
        content: [
          { title: "tenki.jp", url: "https://tenki.jp/" },
          { title: "気象庁", url: "https://www.jma.go.jp/" },
        ],
      },
      { type: "text", text: "下北沢は晴れです。" },
    ]);
  });

  test("rewrites messages path for responses upstreams", () => {
    expect(
      rewriteRequestPath(new URL("https://chatgpt.com/backend-api/codex"), "/v1/messages?x=1", "responses")
    ).toBe("/responses?x=1");
    expect(rewriteRequestPath(new URL("https://example.com/v1"), "/v1/messages", "responses")).toBe(
      "/v1/responses"
    );
    expect(rewriteRequestPath(new URL("https://example.com/v1"), "/v1/messages", "messages")).toBe(
      "/v1/messages"
    );
  });

  test("sanitizes unsupported anthropic tool fields", () => {
    const body: Record<string, any> = {
      tools: [{ name: "a", defer_loading: true }, { name: "b" }],
    };
    const removed = sanitizeToolFields(body);
    expect(removed).toBe(1);
    expect(body.tools[0].defer_loading).toBeUndefined();
  });
});
