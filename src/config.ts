export interface ParsedCodexProvider {
  key: string;
  name?: string;
  baseUrl?: string;
  wireApi?: string;
}

export interface ParsedCodexConfig {
  model?: string;
  modelProvider?: string;
  serviceTier?: string;
  providers: Record<string, ParsedCodexProvider>;
}

function parseTopLevelString(contents: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = contents.match(new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]+)"`, "m"));
  return match?.[1]?.trim();
}

export function normalizeWireApi(value?: string | null): "messages" | "responses" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "messages" || normalized === "responses") {
    return normalized;
  }
  return undefined;
}

export function parseCodexConfig(contents: string): ParsedCodexConfig {
  const providers: ParsedCodexConfig["providers"] = {};
  const headerRegex = /^\[model_providers\.([^\]]+)\]\s*$/gm;

  const headers = Array.from(contents.matchAll(headerRegex));
  for (let i = 0; i < headers.length; i += 1) {
    const current = headers[i];
    const next = headers[i + 1];

    const providerKey = current[1]?.trim();
    if (!providerKey) {
      continue;
    }

    const blockStart = (current.index ?? 0) + current[0].length;
    const blockEnd = next?.index ?? contents.length;
    const block = contents.slice(blockStart, blockEnd);

    providers[providerKey] = {
      key: providerKey,
      name: parseTopLevelString(block, "name"),
      baseUrl: parseTopLevelString(block, "base_url"),
      wireApi: parseTopLevelString(block, "wire_api"),
    };
  }

  return {
    model: parseTopLevelString(contents, "model"),
    modelProvider: parseTopLevelString(contents, "model_provider"),
    serviceTier: parseTopLevelString(contents, "service_tier"),
    providers,
  };
}

export function resolveUpstreamFromCodexConfig(
  contents: string,
  options: {
    providerOverride?: string;
    baseUrlOverride?: string;
    wireApiOverride?: string;
  } = {}
): { baseUrl: string; providerKey?: string; model?: string; wireApi?: "messages" | "responses" } {
  const parsed = parseCodexConfig(contents);

  const preferredProvider = options.providerOverride || parsed.modelProvider;
  let selectedProvider: ParsedCodexProvider | undefined;
  if (preferredProvider) {
    selectedProvider = parsed.providers[preferredProvider];
  }
  if (!selectedProvider) {
    selectedProvider = Object.values(parsed.providers).find((provider) => provider.baseUrl?.trim());
  }

  const resolvedWireApi = normalizeWireApi(options.wireApiOverride) || normalizeWireApi(selectedProvider?.wireApi);

  if (options.baseUrlOverride && options.baseUrlOverride.trim()) {
    return {
      baseUrl: options.baseUrlOverride.trim(),
      providerKey: options.providerOverride || parsed.modelProvider,
      model: parsed.model,
      wireApi: resolvedWireApi,
    };
  }

  if (selectedProvider?.baseUrl?.trim()) {
    return {
      baseUrl: selectedProvider.baseUrl.trim(),
      providerKey: selectedProvider.key,
      model: parsed.model,
      wireApi: resolvedWireApi,
    };
  }

  throw new Error("failed to resolve base_url from ~/.codex/config.toml");
}
