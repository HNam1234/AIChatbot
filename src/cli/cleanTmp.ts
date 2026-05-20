import { cleanupTmpDirectory } from "../utils/tempCleanup";
import { loadEnvConfig } from "../config";

async function main(): Promise<void> {
  const config = loadEnvConfig();
  const result = await cleanupTmpDirectory({ retentionHours: 0 });
  console.log(
    `Temp cleanup: removed ${result.removedDirs} dirs and ${result.removedFiles} files (${result.removedBytes} bytes), skipped ${result.skippedEntries}.`
  );
  console.log(`Configured server retention is ${config.tmpRetentionHours} hour(s).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
