/**
 * Loads and caches `$DATA_PATH/models.json` — the user-defined provider/model
 * configuration file. Used by both the models API route (for listing) and
 * TreeManager (for session creation with the right provider config).
 *
 * Format matches Pi SDK's models.json (same as ~/.pi/agent/models.json):
 * ```json
 * {
 *   "providers": {
 *     "lmstudio": {
 *       "baseUrl": "http://localhost:1234/v1",
 *       "api": "openai-completions",
 *       "apiKey": "lmstudio",
 *       "models": [{ "id": "qwen/qwen3.6-27b" }]
 *     }
 *   }
 * }
 * ```
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelsJsonProvider {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  compat?: Record<string, boolean>;
  models?: Array<{
    id: string;
    name?: string;
    reasoning?: boolean;
    contextWindow?: number;
    input?: string[];
    cost?: Record<string, number>;
  }>;
}

export interface ModelsJson {
  providers?: Record<string, ModelsJsonProvider>;
  /**
   * Global reply language preference ("follow" | "zh" | "en" | "ja" | "de"
   * | "fr"). Read by TreeManager when creating reading sessions; the
   * Settings route persists it. Not part of the providers map.
   */
  replyLanguage?: string;
}

// ---------------------------------------------------------------------------
// Loader (cached)
// ---------------------------------------------------------------------------

let _cached: { data: ModelsJson | null; path: string } | null = null;

function getModelsJsonPath(): string {
  const dataPath =
    process.env.DATA_PATH ??
    join(os.homedir(), ".local", "share", "pi-tree");
  return join(dataPath, "models.json");
}

/**
 * Load and cache `$DATA_PATH/models.json`.
 * Returns null if the file doesn't exist or is invalid.
 */
export function loadModelsJson(): ModelsJson | null {
  const filePath = getModelsJsonPath();
  if (_cached && _cached.path === filePath) return _cached.data;

  if (!existsSync(filePath)) {
    _cached = { data: null, path: filePath };
    return null;
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ModelsJson;
    console.log(`[models-json] Loaded from ${filePath}`);
    _cached = { data: parsed, path: filePath };
    return parsed;
  } catch (err) {
    console.warn(`[models-json] Failed to parse ${filePath}:`, err);
    _cached = { data: null, path: filePath };
    return null;
  }
}

/**
 * Resolve an API key value — supports `$ENV_VAR` syntax
 * (e.g., `"$ANTHROPIC_AUTH_TOKEN"` → reads from process.env).
 */
export function resolveApiKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("$")) {
    return process.env[raw.slice(1)] ?? raw;
  }
  return raw;
}

/**
 * Find which provider from models.json owns a given model ID.
 * Returns the provider name and config, or null if not found.
 */
export function findProviderForModel(
  modelId: string,
): { name: string; config: ModelsJsonProvider } | null {
  const modelsJson = loadModelsJson();
  if (!modelsJson?.providers) return null;

  for (const [name, providerCfg] of Object.entries(modelsJson.providers)) {
    if (providerCfg.models?.some((m) => m.id === modelId)) {
      return { name, config: providerCfg };
    }
  }
  return null;
}

/**
 * Reset the cache — used in tests.
 */
export function resetModelsJsonCache(): void {
  _cached = null;
}

// ---------------------------------------------------------------------------
// Writer (atomic, mode 0600)
// ---------------------------------------------------------------------------

/**
 * Atomically write JSON to `filePath`: mkdir -p the parent, write to a
 * unique temp file, fsync-free rename into place, then chmod 0600 so API
 * keys never sit in a world-readable file. (chmod is a no-op on Windows.)
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort temp cleanup — preserve the original error
    }
    throw err;
  }
}

/**
 * Field-level update of `$DATA_PATH/models.json` — read-merge-write, never
 * whole-file overwrite, so user-authored providers are preserved.
 *
 * `apiKey` follows saveServerConfig's three-state semantics:
 *   - contains "•" or "…" → masked value, keep whatever is stored;
 *   - "" (empty)         → delete the stored key;
 *   - otherwise          → trim and save.
 * `baseUrl`/`api`: "" deletes the field; undefined leaves it untouched.
 * `models` entries are merged by id (provided entries win) so the models
 * array always exists after a save — findProviderForModel requires it.
 */
export interface SaveModelsJsonPatch {
  /** Target provider entry to update. */
  provider: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  api?: string | undefined;
  models?: ModelsJsonProvider["models"];
}

export function saveModelsJson(patch: SaveModelsJsonPatch): ModelsJson {
  const filePath = getModelsJsonPath();

  // Read the current file (fresh read, not the cache — we're the writer).
  let data: ModelsJson = { providers: {} };
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as ModelsJson;
      if (parsed && typeof parsed === "object") data = parsed;
    } catch (err) {
      console.warn(
        `[models-json] Existing ${filePath} is invalid — starting fresh:`,
        err,
      );
    }
  }
  if (!data.providers) data.providers = {};

  const entry: ModelsJsonProvider = { ...(data.providers[patch.provider] ?? {}) };

  if (patch.apiKey !== undefined) {
    if (patch.apiKey.includes("•") || patch.apiKey.includes("…")) {
      // Masked value echoed back — keep the stored key
    } else if (patch.apiKey.trim() === "") {
      delete entry.apiKey;
    } else {
      entry.apiKey = patch.apiKey.trim();
    }
  }
  if (patch.baseUrl !== undefined) {
    if (patch.baseUrl.trim()) entry.baseUrl = patch.baseUrl.trim();
    else delete entry.baseUrl;
  }
  if (patch.api !== undefined) {
    if (patch.api.trim()) entry.api = patch.api.trim();
    else delete entry.api;
  }
  if (patch.models !== undefined) {
    const merged = new Map<string, NonNullable<ModelsJsonProvider["models"]>[number]>();
    for (const m of entry.models ?? []) merged.set(m.id, m);
    for (const m of patch.models) merged.set(m.id, m);
    entry.models = [...merged.values()];
  }

  data.providers[patch.provider] = entry;

  writeJsonAtomic(filePath, data);
  console.log(`[models-json] Saved provider "${patch.provider}" to ${filePath}`);
  resetModelsJsonCache();
  return data;
}

/**
 * Field-level update of top-level (non-provider) preferences in
 * `$DATA_PATH/models.json` — read-merge-write, so provider entries written
 * by saveModelsJson (and any user-authored config) are preserved.
 */
export function saveModelsJsonPreferences(
  patch: Partial<Pick<ModelsJson, "replyLanguage">>,
): ModelsJson {
  const filePath = getModelsJsonPath();

  // Fresh read, not the cache — we're the writer.
  let data: ModelsJson = { providers: {} };
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as ModelsJson;
      if (parsed && typeof parsed === "object") data = parsed;
    } catch (err) {
      console.warn(
        `[models-json] Existing ${filePath} is invalid — starting fresh:`,
        err,
      );
    }
  }
  if (!data.providers) data.providers = {};

  Object.assign(data, patch);

  writeJsonAtomic(filePath, data);
  console.log(`[models-json] Saved preferences to ${filePath}:`, patch);
  resetModelsJsonCache();
  return data;
}

// ---------------------------------------------------------------------------
// Key masking
// ---------------------------------------------------------------------------

/**
 * Mask an API key for display. `$ENV_VAR` values are resolved first.
 * Keys of length ≤ 8 collapse to "••••"; longer keys keep their first 3
 * chars and last 4 chars (friendly to `sk-…`-style prefixes). Never returns
 * plaintext for a non-empty key.
 */
export function maskApiKey(raw: string | undefined): string {
  const key = resolveApiKey(raw);
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
