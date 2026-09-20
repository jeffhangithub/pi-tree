/**
 * Settings route — provider / API key / base URL configuration.
 *
 * GET /api/settings → effective provider config (API key always masked)
 * PUT /api/settings → field-level update: provider + key + baseUrl + api go
 *                     to $DATA_PATH/models.json; model preferences go to
 *                     global-config.json. Provider is deliberately NOT
 *                     written to global-config.json — if it matched
 *                     cfg.provider, TreeManager would skip the models.json
 *                     override and the key would silently stop applying.
 *
 * Mounted at `/api/settings`.
 */

import { Hono } from "hono";
import { configureModelRegistry } from "@pi-tree/core";
import { getServerConfig, saveServerConfig } from "../config.js";
import {
  findProviderForModel,
  loadModelsJson,
  maskApiKey,
  resolveApiKey,
  saveModelsJson,
  type ModelsJsonProvider,
} from "../services/models-json.js";
import { closeAllSessions } from "../services/session-store.js";

export const settingsRoutes = new Hono();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderInfo {
  name: string;
  source: "environment" | "models.json";
  modelCount: number;
}

interface SettingsInfo {
  /** Effective provider name ("" when nothing configured). */
  provider: string;
  /** Effective base URL ("" = SDK built-in default). */
  baseUrl: string;
  /** API type ("" = openai-completions). */
  api: string;
  readingModel: string;
  lookupModel: string;
  /** Masked API key (e.g. "sk-…abcd"); "" = not configured. Never plaintext. */
  apiKeyMasked: string;
  /** Same shape as GET /api/models providers. */
  providers: ProviderInfo[];
  /** SDK built-in provider names ∪ models.json provider names. */
  builtInProviders: string[];
}

interface SettingsUpdate {
  provider?: string;
  /** Plaintext = save; "" = clear; contains "…"/"•" = keep; absent = no-op. */
  apiKey?: string;
  /** "" = delete the field (fall back to SDK built-in default). */
  baseUrl?: string;
  api?: string;
  readingModel?: string;
  lookupModel?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SDK built-in provider names (deduped, sorted). */
function getBuiltInProviderNames(): string[] {
  const { modelRegistry } = configureModelRegistry({ readingModel: "" });
  return [...new Set(modelRegistry.getAll().map((m) => m.provider))].sort();
}

/**
 * Effective settings snapshot. Resolution mirrors TreeManager: a models.json
 * provider whose name differs from the env-configured provider is the source
 * of truth for that provider's key/url; otherwise env config wins. Keys are
 * always masked — plaintext never leaves this function.
 */
function buildSettingsInfo(): SettingsInfo {
  const cfg = getServerConfig();
  const modelsJson = loadModelsJson();

  // Effective provider: env-configured one, else the models.json provider
  // that owns the reading model.
  let provider = cfg.provider || "";
  if (!provider) {
    provider = findProviderForModel(cfg.readingModel)?.name ?? "";
  }

  const entry = provider ? modelsJson?.providers?.[provider] : undefined;
  const entryOwnsAuth = Boolean(entry && provider !== cfg.provider);

  let rawKey: string | undefined;
  if (entryOwnsAuth) {
    rawKey = resolveApiKey(entry?.apiKey) ?? resolveApiKey(cfg.apiKey);
  } else {
    rawKey = resolveApiKey(cfg.apiKey) ?? resolveApiKey(entry?.apiKey);
  }

  const baseUrl = entryOwnsAuth
    ? entry?.baseUrl ?? cfg.baseUrl ?? ""
    : cfg.baseUrl ?? entry?.baseUrl ?? "";
  const api = entryOwnsAuth
    ? entry?.api ?? cfg.api ?? ""
    : cfg.api ?? entry?.api ?? "";

  // Provider list — same shape as GET /api/models. Use an empty-config
  // registry so a custom (models.json-only) reading model can't make
  // configureModelRegistry throw "model not found".
  const { modelRegistry } = configureModelRegistry({ readingModel: "" });
  const providers: ProviderInfo[] = [];
  if (cfg.provider) {
    providers.push({
      name: cfg.provider,
      source: "environment",
      modelCount: modelRegistry
        .getAll()
        .filter((m) => m.provider === cfg.provider).length,
    });
  }
  for (const [name, pCfg] of Object.entries(modelsJson?.providers ?? {})) {
    if (name === cfg.provider) continue;
    providers.push({
      name,
      source: "models.json",
      modelCount:
        pCfg.models?.length ??
        modelRegistry.getAll().filter((m) => m.provider === name).length,
    });
  }

  // builtInProviders: SDK built-ins ∪ models.json provider names.
  const builtIn = getBuiltInProviderNames();
  for (const name of Object.keys(modelsJson?.providers ?? {})) {
    if (!builtIn.includes(name)) builtIn.push(name);
  }
  builtIn.sort();

  return {
    provider,
    baseUrl,
    api,
    readingModel: cfg.readingModel,
    lookupModel: cfg.lookupModel,
    apiKeyMasked: maskApiKey(rawKey),
    providers,
    builtInProviders: builtIn,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

settingsRoutes.get("/", (c) => c.json(buildSettingsInfo()));

settingsRoutes.put("/", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as SettingsUpdate;

    // Validation
    const provider =
      typeof body.provider === "string" ? body.provider.trim() : "";
    if (!provider) {
      return c.json({ success: false, error: "provider is required" }, 400);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(provider)) {
      return c.json(
        { success: false, error: `Invalid provider name: "${provider}"` },
        400,
      );
    }
    if (
      typeof body.baseUrl === "string" &&
      body.baseUrl.trim() !== "" &&
      !/^https?:\/\//i.test(body.baseUrl.trim())
    ) {
      return c.json(
        { success: false, error: "baseUrl must start with http(s)://" },
        400,
      );
    }

    const before = getServerConfig();
    const beforeProvider =
      before.provider ||
      findProviderForModel(before.readingModel)?.name ||
      "";

    const readingModel =
      typeof body.readingModel === "string" && body.readingModel.trim()
        ? body.readingModel.trim()
        : before.readingModel;
    const lookupModel =
      typeof body.lookupModel === "string" && body.lookupModel.trim()
        ? body.lookupModel.trim()
        : before.lookupModel;

    // models array for the target entry: built-in provider → its SDK models;
    // custom provider → minimal [readingModel, lookupModel]. The array must
    // exist — findProviderForModel matches models by id, and without it the
    // provider's key would silently never apply.
    let models: NonNullable<ModelsJsonProvider["models"]>;
    const builtInModels = configureModelRegistry({ readingModel: "" })
      .modelRegistry.getAll()
      .filter((m) => m.provider === provider);
    if (builtInModels.length > 0) {
      models = builtInModels.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        reasoning: m.reasoning ?? false,
        contextWindow: m.contextWindow ?? 128000,
      }));
    } else {
      models = [{ id: readingModel }];
      if (lookupModel && lookupModel !== readingModel) {
        models.push({ id: lookupModel });
      }
    }

    saveModelsJson({
      provider,
      ...(body.apiKey != null ? { apiKey: String(body.apiKey) } : {}),
      ...(body.baseUrl != null ? { baseUrl: String(body.baseUrl) } : {}),
      ...(body.api != null ? { api: String(body.api) } : {}),
      models,
    });

    // Only model preferences go to global-config.json.
    const updated = saveServerConfig({ readingModel, lookupModel });

    const providerChanged = provider !== beforeProvider;
    const modelsChanged =
      updated.readingModel !== before.readingModel ||
      updated.lookupModel !== before.lookupModel;
    let sessionsEvicted = 0;
    if (providerChanged || modelsChanged) {
      sessionsEvicted = closeAllSessions();
      console.log(
        `[settings] Config changed (provider: ${beforeProvider} → ${provider}, model: ${before.readingModel} → ${updated.readingModel}); evicted ${sessionsEvicted} cached session(s)`,
      );
    }

    return c.json({
      success: true,
      settings: buildSettingsInfo(),
      sessionsEvicted,
    });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 400);
  }
});
