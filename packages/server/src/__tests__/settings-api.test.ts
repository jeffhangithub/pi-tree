/**
 * Settings API tests — GET/PUT /api/settings, key masking, three-state
 * apiKey semantics, atomic write + 0600 permissions, cache invalidation,
 * and the models array write that makes findProviderForModel hit.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Stub env vars BEFORE importing app/config so they pick up test paths.
const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-tree-settings-test-"));
const TEST_DATA_PATH = join(TEST_ROOT, "data");

vi.stubEnv("DATA_PATH", TEST_DATA_PATH);

const { app } = await import("../app.js");
const { resetServerConfig } = await import("../config.js");
const {
  loadModelsJson,
  resetModelsJsonCache,
  findProviderForModel,
  saveModelsJson,
  writeJsonAtomic,
  maskApiKey,
} = await import("../services/models-json.js");

const modelsJsonPath = join(TEST_DATA_PATH, "models.json");
const globalConfigPath = join(TEST_DATA_PATH, "global-config.json");

// ── Test isolation ──────────────────────────────────────────────────────────

beforeAll(() => {
  mkdirSync(TEST_DATA_PATH, { recursive: true });
});

beforeEach(() => {
  resetServerConfig();
  resetModelsJsonCache();
  for (const p of [modelsJsonPath, globalConfigPath]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // Best effort cleanup
    }
  }
});

afterAll(() => {
  resetServerConfig();
  resetModelsJsonCache();
  vi.unstubAllEnvs();
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
});

function put(body: Record<string, unknown>) {
  return app.request("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── maskApiKey ──────────────────────────────────────────────────────────────

describe("maskApiKey", () => {
  it("masks long keys as first3…last4 (sk- prefix friendly)", () => {
    expect(maskApiKey("sk-abcdefgh1234")).toBe("sk-…1234");
  });

  it("collapses short keys (≤ 8 chars) to bullets", () => {
    expect(maskApiKey("abcd1234")).toBe("••••");
    expect(maskApiKey("tiny")).toBe("••••");
  });

  it("resolves $ENV_VAR before masking", () => {
    vi.stubEnv("TEST_SETTINGS_KEY", "env-key-abcdef");
    expect(maskApiKey("$TEST_SETTINGS_KEY")).toBe("env…cdef");
  });

  it("returns empty string for missing keys", () => {
    expect(maskApiKey("")).toBe("");
    expect(maskApiKey(undefined)).toBe("");
  });
});

// ── writeJsonAtomic ─────────────────────────────────────────────────────────

describe("writeJsonAtomic", () => {
  it("creates parent dirs and writes with mode 0600", () => {
    const path = join(TEST_DATA_PATH, "nested", "dir", "conf.json");
    writeJsonAtomic(path, { secret: "value" });
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ secret: "value" });
  });
});

// ── saveModelsJson (unit) ───────────────────────────────────────────────────

describe("saveModelsJson", () => {
  it("read-merge-write preserves other providers", () => {
    writeFileSync(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          ollama: { baseUrl: "http://localhost:11434", apiKey: "lmstudio" },
        },
      }),
    );
    saveModelsJson({
      provider: "deepseek",
      apiKey: "sk-new-key",
      baseUrl: "https://api.deepseek.com",
      models: [{ id: "deepseek-v4-flash" }],
    });
    const data = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
    expect(data.providers.ollama).toBeDefined();
    expect(data.providers.deepseek.apiKey).toBe("sk-new-key");
  });

  it("three-state apiKey: masked keeps, empty clears, plaintext saves", () => {
    saveModelsJson({ provider: "deepseek", apiKey: "sk-original-1234" });

    // Masked → keep
    saveModelsJson({ provider: "deepseek", apiKey: "sk-…1234" });
    expect(
      JSON.parse(readFileSync(modelsJsonPath, "utf-8")).providers.deepseek.apiKey,
    ).toBe("sk-original-1234");

    // Empty → clear
    saveModelsJson({ provider: "deepseek", apiKey: "" });
    expect(
      JSON.parse(readFileSync(modelsJsonPath, "utf-8")).providers.deepseek.apiKey,
    ).toBeUndefined();

    // Plaintext → save
    saveModelsJson({ provider: "deepseek", apiKey: "sk-fresh-9999" });
    expect(
      JSON.parse(readFileSync(modelsJsonPath, "utf-8")).providers.deepseek.apiKey,
    ).toBe("sk-fresh-9999");
  });

  it("merges models by id (provided entries win, existing preserved)", () => {
    saveModelsJson({
      provider: "deepseek",
      models: [{ id: "deepseek-v4-flash", reasoning: true }],
    });
    saveModelsJson({
      provider: "deepseek",
      models: [
        { id: "deepseek-v4-flash", reasoning: false },
        { id: "deepseek-v4-pro", reasoning: true },
      ],
    });
    const models = JSON.parse(readFileSync(modelsJsonPath, "utf-8")).providers
      .deepseek.models;
    expect(models).toHaveLength(2);
    expect(models.find((m: any) => m.id === "deepseek-v4-flash").reasoning).toBe(false);
  });

  it("invalidates the load cache (write visible even after a cached null)", () => {
    expect(loadModelsJson()).toBeNull(); // caches null (file absent)
    saveModelsJson({ provider: "deepseek", apiKey: "sk-after-cache" });
    expect(loadModelsJson()?.providers?.deepseek?.apiKey).toBe("sk-after-cache");
  });
});

// ── GET /api/settings ───────────────────────────────────────────────────────

describe("GET /api/settings", () => {
  it("returns all fields with DeepSeek defaults and no credentials", async () => {
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("provider");
    expect(body).toHaveProperty("baseUrl");
    expect(body).toHaveProperty("api");
    expect(body).toHaveProperty("readingModel");
    expect(body).toHaveProperty("lookupModel");
    expect(body).toHaveProperty("apiKeyMasked");
    expect(body).toHaveProperty("providers");
    expect(body).toHaveProperty("builtInProviders");
    // DEFAULT_SERVER_CONFIG fallback (no env, no files)
    expect(body.readingModel).toBe("deepseek-v4-flash");
    expect(body.lookupModel).toBe("deepseek-v4-flash");
    expect(body.apiKeyMasked).toBe("");
    expect(body.builtInProviders).toContain("deepseek");
    // Never plaintext
    expect(body).not.toHaveProperty("apiKey");
  });

  it("masks the key of the models.json provider owning the reading model", async () => {
    writeFileSync(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          deepseek: {
            baseUrl: "https://api.deepseek.com",
            apiKey: "sk-test-1234abcd",
            models: [{ id: "deepseek-v4-flash" }],
          },
        },
      }),
    );
    resetModelsJsonCache();
    const res = await app.request("/api/settings");
    const body = await res.json();
    expect(body.provider).toBe("deepseek");
    expect(body.baseUrl).toBe("https://api.deepseek.com");
    expect(body.apiKeyMasked).toBe("sk-…abcd");
    expect(JSON.stringify(body)).not.toContain("sk-test-1234abcd");
    expect(
      body.providers.some((p: any) => p.name === "deepseek" && p.source === "models.json"),
    ).toBe(true);
  });
});

// ── PUT /api/settings ───────────────────────────────────────────────────────

describe("PUT /api/settings", () => {
  it("saves key/baseUrl to models.json (0600), masked response, models array written", async () => {
    // Prime the cache with a null read so we prove the write invalidates it
    expect(loadModelsJson()).toBeNull();

    const res = await put({
      provider: "deepseek",
      apiKey: "sk-live-abcdef1234",
      baseUrl: "https://api.deepseek.com",
      readingModel: "deepseek-v4-flash",
      lookupModel: "deepseek-v4-flash",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.settings.apiKeyMasked).toBe("sk-…1234");
    expect(JSON.stringify(body)).not.toContain("sk-live-abcdef1234");

    const st = statSync(modelsJsonPath);
    expect(st.mode & 0o777).toBe(0o600);
    const file = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
    expect(file.providers.deepseek.apiKey).toBe("sk-live-abcdef1234");
    expect(file.providers.deepseek.baseUrl).toBe("https://api.deepseek.com");
    // Built-in provider → SDK models written; findProviderForModel hits
    expect(file.providers.deepseek.models.some((m: any) => m.id === "deepseek-v4-flash")).toBe(true);
    expect(findProviderForModel("deepseek-v4-flash")?.name).toBe("deepseek");
    expect(loadModelsJson()?.providers?.deepseek?.apiKey).toBe("sk-live-abcdef1234");
  });

  it("keeps provider/key/baseUrl out of global-config.json", async () => {
    const res = await put({
      provider: "deepseek",
      apiKey: "sk-global-leak-test",
      baseUrl: "https://api.deepseek.com",
      readingModel: "deepseek-v4-flash",
    });
    expect(res.status).toBe(200);
    const gc = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
    expect(gc).not.toHaveProperty("provider");
    expect(gc).not.toHaveProperty("apiKey");
    expect(gc).not.toHaveProperty("baseUrl");
    expect(gc.readingModel).toBe("deepseek-v4-flash");
  });

  it("masked apiKey keeps the stored key; empty apiKey clears it", async () => {
    await put({ provider: "deepseek", apiKey: "sk-original-42" });

    const masked = await put({ provider: "deepseek", apiKey: "sk-…42" });
    expect(masked.status).toBe(200);
    const kept = await masked.json();
    expect(kept.success).toBe(true);
    expect(
      JSON.parse(readFileSync(modelsJsonPath, "utf-8")).providers.deepseek.apiKey,
    ).toBe("sk-original-42");

    const cleared = await put({ provider: "deepseek", apiKey: "" });
    expect(cleared.status).toBe(200);
    expect(
      JSON.parse(readFileSync(modelsJsonPath, "utf-8")).providers.deepseek.apiKey,
    ).toBeUndefined();
  });

  it("custom provider gets minimal models [readingModel, lookupModel]", async () => {
    const res = await put({
      provider: "my-proxy",
      apiKey: "custom-secret",
      baseUrl: "https://proxy.example.com/v1",
      readingModel: "my-custom-model",
      lookupModel: "my-lookup-model",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.provider).toBe("my-proxy");
    const models = JSON.parse(readFileSync(modelsJsonPath, "utf-8")).providers[
      "my-proxy"
    ].models;
    expect(models.map((m: any) => m.id)).toEqual(["my-custom-model", "my-lookup-model"]);
    expect(findProviderForModel("my-custom-model")?.name).toBe("my-proxy");
  });

  it("validates provider name and baseUrl", async () => {
    const noProvider = await put({ apiKey: "sk-x" });
    expect(noProvider.status).toBe(400);

    const badName = await put({ provider: "bad name!", apiKey: "sk-x" });
    expect(badName.status).toBe(400);

    const badUrl = await put({ provider: "deepseek", baseUrl: "ftp://nope" });
    expect(badUrl.status).toBe(400);

    const okUrl = await put({ provider: "deepseek", baseUrl: "http://localhost:11434/v1" });
    expect(okUrl.status).toBe(200);
  });

  it("reports sessionsEvicted when provider or model changes", async () => {
    const first = await put({ provider: "deepseek", readingModel: "deepseek-v4-flash" });
    const firstBody = await first.json();
    expect(firstBody).toHaveProperty("sessionsEvicted");
    expect(firstBody.sessionsEvicted).toBeGreaterThanOrEqual(0);
  });
});
