import path from "node:path";
import express from "express";
import { loadEnvConfig } from "../config/env";
import { createApiRouter } from "./routes";

const config = loadEnvConfig();
const app = express();
const uiDir = path.resolve(__dirname, "..", "ui");
const assetsDir = path.resolve(process.cwd(), "data", "converted", "assets");

app.use(express.json());
app.use("/assets", express.static(assetsDir));
app.use("/api", createApiRouter());
app.use(express.static(uiDir));

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(uiDir, "index.html"));
});

app.listen(config.port, () => {
  console.log(`Local UI: http://localhost:${config.port}`);
});
