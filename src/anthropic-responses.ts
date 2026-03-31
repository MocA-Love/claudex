import type { JsonObject } from "./types.ts";

function textPartTypeForRole(role: string): "input_text" | "output_text" {
  return role === "assistant" ? "output_text" : "input_text";
}

function detectImageMediaTypeFromBuffer(buffer: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 3 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return "image/png";
}

function detectImageMediaTypeFromBase64(data: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  try {
    return detectImageMediaTypeFromBuffer(Buffer.from(data, "base64"));
  } catch {
    return "image/png";
  }
}

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function maybeStringifyForModel(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value ?? "", (_key, current) => {
      if (typeof current === "string") {
        return current.length > 4000 ? `${current.slice(0, 4000)}...[truncated]` : current;
      }
      if (!current || typeof current !== "object") {
        return current;
      }
      if (seen.has(current)) {
        return "[circular]";
      }
      seen.add(current);

      if (Array.isArray(current)) {
        return current;
      }

      const objectValue = current as Record<string, unknown>;
      const sanitized: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(objectValue)) {
        if (key === "data" && typeof nested === "string" && nested.length > 256) {
          sanitized[key] = "[base64 omitted]";
          continue;
        }
        sanitized[key] = nested;
      }
      return sanitized;
    });
  } catch {
    return String(value ?? "");
  }
}

function normalizeResponsesImageDetail(detail: unknown): "auto" | "low" | "high" | "original" | undefined {
  if (typeof detail !== "string") {
    return undefined;
  }

  const normalized = detail.trim().toLowerCase();
  if (normalized === "auto" || normalized === "low" || normalized === "high" || normalized === "original") {
    return normalized;
  }
  return undefined;
}

function mapAnthropicFilePart(partObject: Record<string, unknown>): Record<string, unknown> | undefined {
  const source = partObject.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }

  const sourceObject = source as Record<string, unknown>;
  const sourceType = typeof sourceObject.type === "string" ? sourceObject.type.trim().toLowerCase() : "";
  const filename =
    trimNonEmptyString(partObject.filename) ??
    trimNonEmptyString(partObject.file_name) ??
    trimNonEmptyString(sourceObject.filename) ??
    trimNonEmptyString(sourceObject.file_name) ??
    trimNonEmptyString(partObject.title);

  if (sourceType === "base64" || (!sourceType && typeof sourceObject.data === "string")) {
    const data = trimNonEmptyString(sourceObject.data);
    if (!data) {
      return undefined;
    }

    const mapped: Record<string, unknown> = {
      type: "input_file",
      file_data: data,
    };
    if (filename) {
      mapped.filename = filename;
    }
    return mapped;
  }

  if (sourceType === "url" || (!sourceType && typeof sourceObject.url === "string")) {
    const url = trimNonEmptyString(sourceObject.url);
    if (!url) {
      return undefined;
    }

    const mapped: Record<string, unknown> = {
      type: "input_file",
      file_url: url,
    };
    if (filename) {
      mapped.filename = filename;
    }
    return mapped;
  }

  if (sourceType === "file" || sourceType === "file_id" || (!sourceType && typeof sourceObject.file_id === "string")) {
    const fileId = trimNonEmptyString(sourceObject.file_id) ?? trimNonEmptyString(sourceObject.id);
    if (!fileId) {
      return undefined;
    }

    const mapped: Record<string, unknown> = {
      type: "input_file",
      file_id: fileId,
    };
    if (filename) {
      mapped.filename = filename;
    }
    return mapped;
  }

  return undefined;
}

function mapAnthropicImagePart(partObject: Record<string, unknown>): Record<string, unknown> | undefined {
  const source = partObject.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }

  const sourceObject = source as Record<string, unknown>;
  const sourceType = typeof sourceObject.type === "string" ? sourceObject.type.trim().toLowerCase() : "";
  const detail = normalizeResponsesImageDetail(partObject.detail ?? sourceObject.detail);

  if (sourceType === "base64" || (!sourceType && typeof sourceObject.data === "string")) {
    const data = trimNonEmptyString(sourceObject.data) ?? "";
    const mediaType =
      trimNonEmptyString(sourceObject.media_type) ??
      trimNonEmptyString(sourceObject.mediaType) ??
      (data ? detectImageMediaTypeFromBase64(data) : "");
    if (!mediaType || !data) {
      return undefined;
    }

    const mapped: Record<string, unknown> = {
      type: "input_image",
      image_url: `data:${mediaType};base64,${data}`,
    };
    if (detail) {
      mapped.detail = detail;
    }
    return mapped;
  }

  if (sourceType === "url" || (!sourceType && typeof sourceObject.url === "string")) {
    const url = trimNonEmptyString(sourceObject.url) ?? "";
    if (!url) {
      return undefined;
    }

    const mapped: Record<string, unknown> = {
      type: "input_image",
      image_url: url,
    };
    if (detail) {
      mapped.detail = detail;
    }
    return mapped;
  }

  if (sourceType === "file" || sourceType === "file_id" || (!sourceType && typeof sourceObject.file_id === "string")) {
    const fileId = trimNonEmptyString(sourceObject.file_id) ?? trimNonEmptyString(sourceObject.id) ?? "";
    if (!fileId) {
      return undefined;
    }

    return {
      type: "input_image",
      file_id: fileId,
    };
  }

  return undefined;
}

export function approxTokenCount(body: JsonObject): number {
  const lines: string[] = [];
  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      if (typeof message?.content === "string") {
        lines.push(message.content);
        continue;
      }
      if (Array.isArray(message?.content)) {
        for (const part of message.content) {
          if (typeof part?.text === "string") {
            lines.push(part.text);
          }
          if (typeof part?.content === "string") {
            lines.push(part.content);
          }
        }
      }
    }
  }

  const text = lines.join("\n");
  return Math.max(1, Math.ceil(text.length / 4));
}

export function hasExplicitEffort(body: JsonObject): boolean {
  return Boolean(
    (typeof body?.effort === "string" && body.effort.length > 0) ||
      (typeof body?.output_config?.effort === "string" && body.output_config.effort.length > 0) ||
      (typeof body?.reasoning?.effort === "string" && body.reasoning.effort.length > 0)
  );
}

export function applyDefaultEffort(
  body: JsonObject,
  options: {
    forcedModel: string;
    defaultReasoningEffort: string;
    preserveClientEffort: boolean;
  }
): void {
  if (options.forcedModel !== "gpt-5.3-codex") {
    return;
  }
  if (options.preserveClientEffort || hasExplicitEffort(body)) {
    return;
  }

  if (typeof body.output_config !== "object" || body.output_config === null) {
    body.output_config = {};
  }
  body.output_config.effort = options.defaultReasoningEffort;

  if (typeof body.reasoning !== "object" || body.reasoning === null) {
    body.reasoning = {};
  }
  body.reasoning.effort = options.defaultReasoningEffort;
}

export function sanitizeToolFields(body: JsonObject): number {
  let removed = 0;
  if (!Array.isArray(body?.tools)) {
    return removed;
  }

  for (const tool of body.tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    if ("defer_loading" in tool) {
      delete tool.defer_loading;
      removed += 1;
    }
  }

  return removed;
}

function normalizeToolResultOutput(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: Array<Record<string, unknown>> = [];
    let sawNonTextPart = false;

    const pushText = (text: string): void => {
      if (text.length === 0) {
        return;
      }
      parts.push({
        type: "input_text",
        text,
      });
    };

    for (const item of content) {
      if (typeof item === "string") {
        pushText(item);
        continue;
      }
      if (!item || typeof item !== "object") {
        if (item !== undefined && item !== null) {
          sawNonTextPart = true;
          pushText(maybeStringifyForModel(item));
        }
        continue;
      }

      const itemObject = item as Record<string, unknown>;
      const partType = typeof itemObject.type === "string" ? itemObject.type : "";
      if (partType === "text") {
        const text = trimNonEmptyString(itemObject.text);
        if (text) {
          pushText(text);
        }
        continue;
      }
      if (partType === "image") {
        const imagePart = mapAnthropicImagePart(itemObject);
        if (imagePart) {
          sawNonTextPart = true;
          parts.push(imagePart);
        }
        continue;
      }
      if (partType === "document") {
        const filePart = mapAnthropicFilePart(itemObject);
        if (filePart) {
          sawNonTextPart = true;
          parts.push(filePart);
          continue;
        }
      }

      sawNonTextPart = true;
      pushText(maybeStringifyForModel(itemObject));
    }

    if (parts.length > 0) {
      if (!sawNonTextPart) {
        return parts
          .map((part) => (part.type === "input_text" && typeof part.text === "string" ? part.text : ""))
          .filter((text) => text.length > 0)
          .join("\n");
      }
      return parts;
    }
  }
  return maybeStringifyForModel(content ?? "");
}

export function extractInstructionsFromSystem(systemField: unknown): string | undefined {
  if (typeof systemField === "string" && systemField.trim().length > 0) {
    return systemField.trim();
  }
  if (!Array.isArray(systemField)) {
    return undefined;
  }

  const parts: string[] = [];
  for (const item of systemField) {
    if (typeof item === "string" && item.trim().length > 0) {
      parts.push(item.trim());
      continue;
    }
    if (item && typeof item === "object") {
      const text = (item as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim().length > 0) {
        parts.push(text.trim());
      }
    }
  }

  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n\n");
}

export function toResponsesInput(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) {
    return [];
  }

  const mapped: Array<Record<string, unknown>> = [];
  let fallbackCallId = 0;

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const roleRaw = (message as Record<string, unknown>).role;
    const role = typeof roleRaw === "string" ? roleRaw : "user";
    const contentRaw = (message as Record<string, unknown>).content;

    const messageContent: Array<Record<string, unknown>> = [];
    const flushMessageContent = (): void => {
      if (messageContent.length === 0) {
        return;
      }
      mapped.push({
        role,
        content: [...messageContent],
      });
      messageContent.length = 0;
    };

    const pushText = (text: string): void => {
      if (text.length === 0) {
        return;
      }
      messageContent.push({
        type: textPartTypeForRole(role),
        text,
      });
    };

    if (typeof contentRaw === "string") {
      pushText(contentRaw);
      flushMessageContent();
      continue;
    }

    if (!Array.isArray(contentRaw)) {
      continue;
    }

    for (const part of contentRaw) {
      if (typeof part === "string") {
        pushText(part);
        continue;
      }
      if (!part || typeof part !== "object") {
        continue;
      }

      const partObject = part as Record<string, unknown>;
      const partType = typeof partObject.type === "string" ? partObject.type : "";

      if (partType === "tool_use") {
        const name = typeof partObject.name === "string" ? partObject.name : undefined;
        if (!name) {
          continue;
        }

        flushMessageContent();
        const callIdRaw = partObject.id;
        const callId =
          typeof callIdRaw === "string" && callIdRaw.length > 0 ? callIdRaw : `call_${++fallbackCallId}`;
        const input = partObject.input ?? {};
        mapped.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: typeof input === "string" ? input : JSON.stringify(input),
        });
        continue;
      }

      if (partType === "tool_result") {
        const callIdRaw = partObject.tool_use_id ?? partObject.id;
        const callId = typeof callIdRaw === "string" ? callIdRaw : undefined;
        if (!callId) {
          continue;
        }

        flushMessageContent();
        mapped.push({
          type: "function_call_output",
          call_id: callId,
          output: normalizeToolResultOutput(partObject.content),
        });
        continue;
      }

      if (partType === "image") {
        const imagePart = mapAnthropicImagePart(partObject);
        if (imagePart) {
          messageContent.push(imagePart);
        }
        continue;
      }

      if (partType === "document") {
        const filePart = mapAnthropicFilePart(partObject);
        if (filePart) {
          messageContent.push(filePart);
        }
        continue;
      }

      const text = partObject.text;
      if (typeof text === "string") {
        pushText(text);
        continue;
      }

      const nestedContent = partObject.content;
      if (typeof nestedContent === "string") {
        pushText(nestedContent);
      }
    }

    flushMessageContent();
  }

  return mapped;
}

function stripNullValues(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      result[key] = stripNullValues(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parseFunctionCallArguments(argumentsRaw: unknown): Record<string, unknown> {
  if (argumentsRaw && typeof argumentsRaw === "object" && !Array.isArray(argumentsRaw)) {
    return stripNullValues(argumentsRaw as Record<string, unknown>);
  }
  if (typeof argumentsRaw !== "string") {
    return {};
  }

  const trimmed = argumentsRaw.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return stripNullValues(parsed as Record<string, unknown>);
    }
    return {};
  } catch {
    return {};
  }
}

function extractWebCitationHitsFromAnnotations(annotations: unknown): Array<{ title: string; url: string }> {
  if (!Array.isArray(annotations)) {
    return [];
  }

  const hits: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();

  for (const annotation of annotations) {
    if (!annotation || typeof annotation !== "object") {
      continue;
    }

    const annotationObject = annotation as Record<string, unknown>;
    const nested =
      annotationObject.type === "url_citation" && annotationObject.url_citation && typeof annotationObject.url_citation === "object"
        ? (annotationObject.url_citation as Record<string, unknown>)
        : annotationObject;

    const url = trimNonEmptyString(nested.url) ?? trimNonEmptyString(annotationObject.url);
    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    hits.push({
      title: trimNonEmptyString(nested.title) ?? trimNonEmptyString(annotationObject.title) ?? url,
      url,
    });
  }

  return hits;
}

function extractWebSearchSources(action: unknown): Array<{ title: string; url: string }> {
  if (!action || typeof action !== "object") {
    return [];
  }

  const sources = (action as Record<string, unknown>).sources;
  if (!Array.isArray(sources)) {
    return [];
  }

  const hits: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (typeof source === "string") {
      const url = source.trim();
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      hits.push({ title: url, url });
      continue;
    }
    if (!source || typeof source !== "object") {
      continue;
    }
    const sourceObject = source as Record<string, unknown>;
    const url = trimNonEmptyString(sourceObject.url) ?? trimNonEmptyString(sourceObject.link);
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    hits.push({
      title: trimNonEmptyString(sourceObject.title) ?? trimNonEmptyString(sourceObject.name) ?? url,
      url,
    });
  }

  return hits;
}

export function mapResponsesOutputToAnthropicContent(output: unknown): {
  content: Array<Record<string, unknown>>;
  stopReason: "tool_use" | "end_turn";
} {
  if (!Array.isArray(output)) {
    return { content: [], stopReason: "end_turn" };
  }

  const content: Array<Record<string, unknown>> = [];
  let hasToolUse = false;
  let fallbackToolUseId = 0;
  const webSearchCalls: Array<{ id: string; query?: string; hits: Array<{ title: string; url: string }> }> = [];
  const pendingCitationHits: Array<{ title: string; url: string }> = [];

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const obj = item as Record<string, unknown>;
    const itemType = typeof obj.type === "string" ? obj.type : "";

    if (itemType === "message" && Array.isArray(obj.content)) {
      for (const part of obj.content) {
        if (!part || typeof part !== "object") {
          continue;
        }
        const partObj = part as Record<string, unknown>;
        const partType = typeof partObj.type === "string" ? partObj.type : "";
        const text = partObj.text;
        if ((partType === "output_text" || partType === "text") && typeof text === "string") {
          pendingCitationHits.push(...extractWebCitationHitsFromAnnotations(partObj.annotations));
          content.push({
            type: "text",
            text,
          });
        }
      }
      continue;
    }

    if (itemType === "web_search_call") {
      const action = obj.action && typeof obj.action === "object" ? (obj.action as Record<string, unknown>) : undefined;
      const query =
        trimNonEmptyString(action?.query) ??
        (Array.isArray(action?.queries)
          ? (action?.queries as unknown[]).find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          : undefined);
      const idRaw = obj.id ?? obj.call_id;
      const id = typeof idRaw === "string" && idRaw.trim().length > 0 ? idRaw : `srvtoolu_${++fallbackToolUseId}`;
      webSearchCalls.push({
        id,
        query,
        hits: extractWebSearchSources(action),
      });
      continue;
    }

    if (itemType === "function_call") {
      const name = typeof obj.name === "string" ? obj.name : "";
      if (!name) {
        continue;
      }

      const idRaw = obj.call_id ?? obj.id;
      const id = typeof idRaw === "string" && idRaw.length > 0 ? idRaw : `toolu_${++fallbackToolUseId}`;
      content.push({
        type: "tool_use",
        id,
        name,
        input: parseFunctionCallArguments(obj.arguments ?? obj.input),
      });
      hasToolUse = true;
    }
  }

  if (webSearchCalls.length > 0) {
    const fallbackHits: Array<{ title: string; url: string }> = [];
    const seenUrls = new Set<string>();
    for (const hit of pendingCitationHits) {
      if (seenUrls.has(hit.url)) {
        continue;
      }
      seenUrls.add(hit.url);
      fallbackHits.push(hit);
    }

    const synthesizedBlocks: Array<Record<string, unknown>> = [];
    for (const call of webSearchCalls) {
      synthesizedBlocks.push({
        type: "server_tool_use",
        id: call.id,
        name: "web_search",
        input: call.query ? { query: call.query } : {},
      });
      const hits = call.hits.length > 0 ? call.hits : fallbackHits;
      synthesizedBlocks.push({
        type: "web_search_tool_result",
        tool_use_id: call.id,
        content: hits.map((hit) => ({
          title: hit.title,
          url: hit.url,
        })),
      });
    }
    content.unshift(...synthesizedBlocks);
  }

  return {
    content,
    stopReason: hasToolUse ? "tool_use" : "end_turn",
  };
}
