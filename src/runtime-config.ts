import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  parseApiKeyFromAuthJson,
  parseChatgptRefreshConfigFromAuthJson,
  parseChatgptTokenFromAuthJson,
} from "./auth-json.ts";
import { normalizeWireApi, parseCodexConfig, resolveUpstreamFromCodexConfig } from "./config.ts";

export interface RuntimeConfig {
  upstreamBaseUrl: string;
  upstreamBearerToken: string;
  upstreamExtraHeaders: Record<string, string>;
  upstreamWireApi: "messages" | "responses";
  forcedModel: string;
  serviceTier?: ServiceTier;
  authMode: "provider-api-key" | "chatgpt-token" | "chatgpt-api-key";
  chatgptRefreshConfig?: {
    authPath: string;
    refreshToken: string;
    clientId: string;
  };
}

export type ForcedModelSource = "cli" | "env" | "config" | "default";
export type ServiceTier = "fast" | "flex";

export function trimOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

export function normalizeServiceTier(value: unknown): ServiceTier | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "fast" || normalized === "flex") {
    return normalized;
  }
  return undefined;
}

export function resolveForcedModel(options: {
  cliOverride?: string | null;
  envOverride?: string | null;
  configModel?: string | null;
  defaultForcedModel?: string | null;
}): { forcedModel: string; source: ForcedModelSource } {
  const defaultForcedModel = trimOrNull(options.defaultForcedModel) || "gpt-5.3-codex";
  const candidates: Array<[ForcedModelSource, string | null | undefined]> = [
    ["cli", options.cliOverride],
    ["env", options.envOverride],
    ["config", options.configModel],
  ];

  for (const [source, candidate] of candidates) {
    const trimmed = trimOrNull(candidate);
    if (trimmed) {
      return { forcedModel: trimmed, source };
    }
  }

  return { forcedModel: defaultForcedModel, source: "default" };
}

function resolveCodexPaths(): { configPath: string; authPath: string } {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const configPath = process.env.CLAUDEX_CODEX_CONFIG?.trim() || join(codexHome, "config.toml");
  const authPath = process.env.CLAUDEX_CODEX_AUTH?.trim() || join(codexHome, "auth.json");
  return { configPath, authPath };
}

export function loadRuntimeConfig(options: { forcedModelOverride?: string } = {}): RuntimeConfig {
  const { configPath, authPath } = resolveCodexPaths();

  const providerOverride = trimOrNull(process.env.CLAUDEX_MODEL_PROVIDER) || undefined;
  const baseUrlOverride = trimOrNull(process.env.CLAUDEX_UPSTREAM_BASE_URL) || undefined;
  const wireApiOverride = normalizeWireApi(process.env.CLAUDEX_UPSTREAM_WIRE_API);
  const chatgptBaseUrl =
    trimOrNull(process.env.CLAUDEX_CHATGPT_BASE_URL) || "https://chatgpt.com/backend-api/codex";
  const envApiKey = trimOrNull(process.env.CLAUDEX_UPSTREAM_API_KEY) || trimOrNull(process.env.OPENAI_API_KEY) || undefined;
  const envBearerToken =
    trimOrNull(process.env.CLAUDEX_UPSTREAM_BEARER_TOKEN) ||
    trimOrNull(process.env.CLAUDEX_CHATGPT_BEARER_TOKEN) ||
    undefined;
  const envChatgptAccountId = trimOrNull(process.env.CLAUDEX_CHATGPT_ACCOUNT_ID) || undefined;
  const envServiceTier = normalizeServiceTier(process.env.CLAUDEX_SERVICE_TIER);

  let configContents = "";
  let modelFromConfig: string | undefined;
  let serviceTierFromConfig: ServiceTier | undefined;
  let resolvedProvider: ReturnType<typeof resolveUpstreamFromCodexConfig> | null = null;
  if (existsSync(configPath)) {
    configContents = readFileSync(configPath, "utf8");
    const parsedConfig = parseCodexConfig(configContents);
    modelFromConfig = parsedConfig.model;
    serviceTierFromConfig = normalizeServiceTier(parsedConfig.serviceTier);
    try {
      resolvedProvider = resolveUpstreamFromCodexConfig(configContents, {
        providerOverride,
        baseUrlOverride,
        wireApiOverride,
      });
    } catch {
      resolvedProvider = null;
    }
  } else if (baseUrlOverride) {
    resolvedProvider = {
      baseUrl: baseUrlOverride,
      providerKey: providerOverride,
      model: undefined,
      wireApi: wireApiOverride,
    };
  }
  const serviceTier = envServiceTier ?? serviceTierFromConfig;

  const defaultForcedModel = "gpt-5.3-codex";
  const { forcedModel, source: forcedModelSource } = resolveForcedModel({
    cliOverride: options.forcedModelOverride,
    envOverride: process.env.CLAUDEX_FORCE_MODEL,
    configModel: modelFromConfig,
    defaultForcedModel,
  });

  const authFileExists = existsSync(authPath);
  const authContents = authFileExists ? readFileSync(authPath, "utf8") : "";
  const authUnavailable = !authFileExists && !envApiKey && !envBearerToken;
  if (authUnavailable) {
    throw new Error(`missing auth file: ${authPath}`);
  }

  if (resolvedProvider?.baseUrl?.trim()) {
    return {
      upstreamBaseUrl: resolvedProvider.baseUrl,
      upstreamBearerToken: parseApiKeyFromAuthJson(authContents, envApiKey),
      upstreamExtraHeaders: {},
      upstreamWireApi: resolvedProvider.wireApi || "messages",
      forcedModel,
      serviceTier,
      authMode: "provider-api-key",
    };
  }

  try {
    const tokenAuth = parseChatgptTokenFromAuthJson(authContents, {
      envBearerToken,
      envAccountId: envChatgptAccountId,
    });
    const refreshConfig = authContents.trim().length > 0 ? parseChatgptRefreshConfigFromAuthJson(authContents) : {};

    const extraHeaders: Record<string, string> = {};
    if (tokenAuth.accountId) {
      extraHeaders["chatgpt-account-id"] = tokenAuth.accountId;
    }

    const canAutoRefresh =
      !envBearerToken &&
      typeof refreshConfig.refreshToken === "string" &&
      refreshConfig.refreshToken.length > 0 &&
      typeof refreshConfig.clientId === "string" &&
      refreshConfig.clientId.length > 0;

    let chatgptForcedModel = forcedModel;
    if (forcedModelSource === "default" && forcedModel === defaultForcedModel) {
      chatgptForcedModel = (process.env.CLAUDEX_CHATGPT_DEFAULT_MODEL || "gpt-5-codex").trim();
    }

    return {
      upstreamBaseUrl: chatgptBaseUrl,
      upstreamBearerToken: tokenAuth.bearerToken,
      upstreamExtraHeaders: extraHeaders,
      upstreamWireApi: "responses",
      forcedModel: chatgptForcedModel,
      serviceTier,
      authMode: "chatgpt-token",
      chatgptRefreshConfig: canAutoRefresh
        ? {
            authPath,
            refreshToken: refreshConfig.refreshToken!,
            clientId: refreshConfig.clientId!,
          }
        : undefined,
    };
  } catch {
    let chatgptForcedModel = forcedModel;
    if (forcedModelSource === "default" && forcedModel === defaultForcedModel) {
      chatgptForcedModel = (process.env.CLAUDEX_CHATGPT_DEFAULT_MODEL || "gpt-5-codex").trim();
    }

    return {
      upstreamBaseUrl: chatgptBaseUrl,
      upstreamBearerToken: parseApiKeyFromAuthJson(authContents, envApiKey),
      upstreamExtraHeaders: {},
      upstreamWireApi: "responses",
      forcedModel: chatgptForcedModel,
      serviceTier,
      authMode: "chatgpt-api-key",
    };
  }
}
