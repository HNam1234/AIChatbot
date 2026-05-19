import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canWriteSecretsFromUi, isLocalhostHost, loadEnvConfig, localhostExposureWarning, maskSecret } from "../src/config/env";
import { JobStore } from "../src/server/jobStore";
import { cleanupTmpDirectory } from "../src/utils/tempCleanup";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("local demo config", () => {
  it("defaults server host to 127.0.0.1", () => {
    delete process.env.HOST;

    expect(loadEnvConfig().host).toBe("127.0.0.1");
    expect(isLocalhostHost(loadEnvConfig().host)).toBe(true);
  });

  it("keeps selected-section LLM QA disabled by default", () => {
    delete process.env.ENABLE_LLM_QA;

    expect(loadEnvConfig().enableLlmQa).toBe(false);

    process.env.ENABLE_LLM_QA = "true";
    expect(loadEnvConfig().enableLlmQa).toBe(true);
  });

  it("keeps LLM query expansion disabled by default", () => {
    delete process.env.ENABLE_LLM_QUERY_EXPANSION;
    delete process.env.QUERY_EXPANSION_PROVIDER;
    delete process.env.QUERY_EXPANSION_MAX_TERMS;
    delete process.env.QUERY_EXPANSION_TIMEOUT_MS;
    delete process.env.QUERY_EXPANSION_CACHE_ENABLED;

    const defaults = loadEnvConfig();
    expect(defaults.enableLlmQueryExpansion).toBe(false);
    expect(defaults.queryExpansionProvider).toBe("none");
    expect(defaults.queryExpansionMaxTerms).toBe(12);
    expect(defaults.queryExpansionTimeoutMs).toBe(3000);
    expect(defaults.queryExpansionCacheEnabled).toBe(true);

    process.env.ENABLE_LLM_QUERY_EXPANSION = "true";
    process.env.QUERY_EXPANSION_PROVIDER = "gemini";
    process.env.QUERY_EXPANSION_MAX_TERMS = "5";
    process.env.QUERY_EXPANSION_TIMEOUT_MS = "1000";
    process.env.QUERY_EXPANSION_CACHE_ENABLED = "false";

    const configured = loadEnvConfig();
    expect(configured.enableLlmQueryExpansion).toBe(true);
    expect(configured.queryExpansionProvider).toBe("gemini");
    expect(configured.queryExpansionMaxTerms).toBe(5);
    expect(configured.queryExpansionTimeoutMs).toBe(1000);
    expect(configured.queryExpansionCacheEnabled).toBe(false);
  });

  it("loads Bifrost LLM provider settings from env", () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.BIFROST_API_KEY;
    delete process.env.BIFROST_BASE_URL;
    delete process.env.BIFROST_MODEL;

    const defaults = loadEnvConfig();
    expect(defaults.llmProvider).toBe("gemini");
    expect(defaults.bifrostApiKey).toBeUndefined();
    expect(defaults.bifrostBaseUrl).toBeUndefined();
    expect(defaults.bifrostModel).toBe("gpt-5.5");

    process.env.LLM_PROVIDER = "bifrost";
    process.env.BIFROST_API_KEY = "bifrost-secret";
    process.env.BIFROST_BASE_URL = "https://bifrost.company.com/v1";
    process.env.BIFROST_MODEL = "claude-company";

    const configured = loadEnvConfig();
    expect(configured.llmProvider).toBe("bifrost");
    expect(configured.bifrostApiKey).toBe("bifrost-secret");
    expect(configured.bifrostBaseUrl).toBe("https://bifrost.company.com/v1");
    expect(configured.bifrostModel).toBe("claude-company");
  });

  it("allows secret writes on localhost", () => {
    expect(canWriteSecretsFromUi({ host: "127.0.0.1", allowLocalSecretWrite: false })).toBe(true);
  });

  it("blocks secret writes on non-localhost unless explicitly allowed", () => {
    expect(canWriteSecretsFromUi({ host: "0.0.0.0", allowLocalSecretWrite: false })).toBe(false);
    expect(canWriteSecretsFromUi({ host: "0.0.0.0", allowLocalSecretWrite: true })).toBe(true);
  });

  it("warns when server host is not localhost", () => {
    expect(localhostExposureWarning("127.0.0.1")).toBeUndefined();
    expect(localhostExposureWarning("0.0.0.0")).toContain("Warning: server is not bound to localhost");
  });

  it("masks raw secrets before returning settings-style values", () => {
    const rawKey = "AIzaRawSecretValue1234";

    expect(maskSecret(rawKey)).toBe("********...1234");
    expect(maskSecret(rawKey)).not.toContain("RawSecretValue");
  });

  it("counts queued/running jobs for the concurrency guard", () => {
    const before = JobStore.activeCount();
    const job = JobStore.create(["first.pdf"]);

    expect(JobStore.activeCount()).toBe(before + 1);
    JobStore.fail(job.id, "test cleanup");
  });

  it("cleans only old tmp contents and keeps .gitkeep", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hscode-clean-"));
    try {
      const tmpRoot = path.join(dir, "data", "tmp");
      mkdirSync(path.join(tmpRoot, "old-dir"), { recursive: true });
      writeFileSync(path.join(tmpRoot, ".gitkeep"), "");
      writeFileSync(path.join(tmpRoot, "old-dir", "old.txt"), "old");
      writeFileSync(path.join(tmpRoot, "old-file.txt"), "old");
      writeFileSync(path.join(tmpRoot, "new-file.txt"), "new");

      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const newTime = new Date();
      await import("node:fs/promises").then(async ({ utimes }) => {
        await utimes(path.join(tmpRoot, "old-dir"), oldTime, oldTime);
        await utimes(path.join(tmpRoot, "old-file.txt"), oldTime, oldTime);
        await utimes(path.join(tmpRoot, "new-file.txt"), newTime, newTime);
      });

      const result = await cleanupTmpDirectory({ tmpDir: tmpRoot, retentionHours: 24 });

      expect(result.removedFiles).toBe(2);
      expect(result.removedDirs).toBe(1);
      expect(result.skippedEntries).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
