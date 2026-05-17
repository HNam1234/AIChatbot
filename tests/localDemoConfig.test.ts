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
