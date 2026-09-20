/**
 * Reply language service tests — instruction building, global preference
 * persistence, and the transient per-turn injection wrapper.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Stub env vars BEFORE importing services so they pick up the test data path.
const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-tree-reply-lang-test-"));
const TEST_DATA_PATH = join(TEST_ROOT, "data");
vi.stubEnv("DATA_PATH", TEST_DATA_PATH);

const {
  REPLY_LANGUAGES,
  isReplyLanguage,
  getGlobalReplyLanguage,
  saveGlobalReplyLanguage,
  buildReplyLanguageInstruction,
  prependReplyLanguageInstruction,
} = await import("../services/reply-language.js");
const { resetModelsJsonCache } = await import("../services/models-json.js");

const modelsJsonPath = join(TEST_DATA_PATH, "models.json");

beforeAll(() => {
  mkdirSync(TEST_DATA_PATH, { recursive: true });
});

beforeEach(() => {
  resetModelsJsonCache();
  try {
    rmSync(modelsJsonPath, { force: true });
  } catch {
    // Best effort cleanup
  }
});

afterAll(() => {
  resetModelsJsonCache();
  vi.unstubAllEnvs();
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
});

describe("isReplyLanguage", () => {
  it("accepts the six supported values", () => {
    for (const lang of REPLY_LANGUAGES) {
      expect(isReplyLanguage(lang)).toBe(true);
    }
  });

  it("rejects unknown and non-string values", () => {
    expect(isReplyLanguage("esperanto")).toBe(false);
    expect(isReplyLanguage("")).toBe(false);
    expect(isReplyLanguage(undefined)).toBe(false);
    expect(isReplyLanguage(null)).toBe(false);
    expect(isReplyLanguage(42)).toBe(false);
  });
});

describe("buildReplyLanguageInstruction", () => {
  it('"follow" → answer in the language of the question', () => {
    expect(buildReplyLanguageInstruction("follow")).toBe(
      "Answer in the same language as the user's question.",
    );
  });

  it("specific languages → always-answer-in instruction with user override escape", () => {
    expect(buildReplyLanguageInstruction("zh")).toContain("Always answer in");
    expect(buildReplyLanguageInstruction("zh")).toContain("Chinese");
    expect(buildReplyLanguageInstruction("zh")).toContain(
      "unless the user explicitly asks otherwise.",
    );
    expect(buildReplyLanguageInstruction("en")).toContain("Always answer in English");
    expect(buildReplyLanguageInstruction("ja")).toContain("Japanese");
  });

  it("falls back to follow for invalid/absent values", () => {
    expect(buildReplyLanguageInstruction(undefined)).toBe(
      "Answer in the same language as the user's question.",
    );
    expect(buildReplyLanguageInstruction("klingon")).toBe(
      "Answer in the same language as the user's question.",
    );
  });
});

describe("prependReplyLanguageInstruction", () => {
  const instruction = "Always answer in Chinese (中文) unless the user explicitly asks otherwise.";

  it("wraps the message with the [SYSTEM CONTEXT] marker block", () => {
    const wrapped = prependReplyLanguageInstruction("什么是 attention?", instruction);
    expect(wrapped).toBe(
      `[SYSTEM CONTEXT — Reply Language]\n${instruction}\n\n---\n\n什么是 attention?`,
    );
  });

  it("keeps the user message after the separator (strip-compatible)", () => {
    const wrapped = prependReplyLanguageInstruction("hello", instruction);
    const sepIdx = wrapped.indexOf("\n\n---\n\n");
    expect(sepIdx).toBeGreaterThan(-1);
    expect(wrapped.slice(sepIdx + 7)).toBe("hello");
  });

  it("passes the message through when no instruction is set", () => {
    expect(prependReplyLanguageInstruction("hello", "")).toBe("hello");
  });
});

describe("global preference (models.json)", () => {
  it("defaults to follow when nothing is stored", () => {
    expect(getGlobalReplyLanguage()).toBe("follow");
  });

  it("persists and reads back, preserving provider entries", () => {
    writeFileSync(
      modelsJsonPath,
      JSON.stringify({ providers: { deepseek: { apiKey: "sk-x" } } }),
    );
    resetModelsJsonCache();
    saveGlobalReplyLanguage("ja");
    const file = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
    expect(file.replyLanguage).toBe("ja");
    expect(file.providers.deepseek.apiKey).toBe("sk-x");
    expect(getGlobalReplyLanguage()).toBe("ja");
  });

  it("falls back to follow for a corrupt stored value", () => {
    writeFileSync(
      modelsJsonPath,
      JSON.stringify({ replyLanguage: "not-a-language" }),
    );
    resetModelsJsonCache();
    expect(getGlobalReplyLanguage()).toBe("follow");
  });
});
