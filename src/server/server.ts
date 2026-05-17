import path from "node:path";
import express from "express";
import { loadEnvConfig } from "../config/env";
import { createApiRouter } from "./routes";

const config = loadEnvConfig();
const app = express();
const uiDir = path.resolve(__dirname, "..", "ui");
const assetsDir = path.resolve(process.cwd(), "data", "converted", "assets");
const pdfjsDir = path.resolve(process.cwd(), "node_modules", "pdfjs-dist", "build");

app.use(express.json());
app.use("/assets", express.static(assetsDir));
app.use("/vendor/pdfjs", express.static(pdfjsDir));
app.use("/api", createApiRouter());
app.use(express.static(uiDir));

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(uiDir, "index.html"));
});

const server = app.listen(config.port, () => {
  console.log(`Local UI: http://localhost:${config.port}`);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${config.port} is already in use. Stop the existing dev server or set PORT=<other-port>.`);
    process.exitCode = 1;
    return;
  }

  console.error(error);
  process.exitCode = 1;
});
