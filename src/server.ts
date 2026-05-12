import { writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import express from "express";
import multer from "multer";

import { loadSettings } from "./config.js";
import { GroundedChatbotPipeline } from "./pipeline.js";

type ChatRequest = {
  question?: string;
  docIds?: string[];
  doc_ids?: string[];
};

type StatusRequest = {
  docId?: string;
  doc_id?: string;
};

const upload = multer({ storage: multer.memoryStorage() });

async function createApp() {
  const settings = await loadSettings();
  const app = express();
  app.use(express.json());

  const getPipeline = () => new GroundedChatbotPipeline(settings);

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/documents", async (_request, response, next) => {
    try {
      response.json({ documents: await getPipeline().documents() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/documents/status", async (request, response, next) => {
    try {
      const body = request.body as StatusRequest;
      const docId = body.docId ?? body.doc_id;
      if (!docId) {
        response.status(400).json({ error: "docId is required" });
        return;
      }
      response.json({ docId, status: await getPipeline().refreshStatus(docId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/ingest", upload.array("files"), async (request, response, next) => {
    try {
      const files = request.files;
      if (!Array.isArray(files) || files.length === 0) {
        response.status(400).json({ error: "Upload at least one file with multipart field 'files'" });
        return;
      }

      const wait = request.query.wait !== "false";
      const pipeline = getPipeline();
      const records = [];

      for (const file of files) {
        const extension = path.extname(file.originalname);
        const tmpPath = path.join(settings.tmpDir, `${randomUUID()}${extension}`);
        await writeFile(tmpPath, file.buffer);
        records.push(await pipeline.ingest(tmpPath, { wait, originalName: file.originalname }));
      }

      response.json({ documents: records });
    } catch (error) {
      next(error);
    }
  });

  app.post("/chat", async (request, response, next) => {
    try {
      const body = request.body as ChatRequest;
      if (!body.question?.trim()) {
        response.status(400).json({ error: "question is required" });
        return;
      }
      const docIds = body.docIds ?? body.doc_ids;
      response.json({ answer: await getPipeline().ask(body.question, docIds), docIds });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  return { app, settings };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const { app, settings } = await createApp();
  app.listen(settings.port, "127.0.0.1", () => {
    console.log(`PageIndex grounded chatbot listening at http://127.0.0.1:${settings.port}`);
  });
}

export { createApp };
