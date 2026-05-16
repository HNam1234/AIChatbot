import { randomUUID } from "node:crypto";

export type JobStatus = "queued" | "running" | "completed" | "failed";
export type PipelineFileStatus = "waiting" | "running" | "passed" | "failed";

export interface PipelineFileJob {
  filename: string;
  inputFile: string;
  status: PipelineFileStatus;
  currentStep: string;
  progressPercent: number;
  outputs?: Record<string, unknown>;
  error?: string;
}

export interface PipelineJob {
  id: string;
  inputFile: string;
  status: JobStatus;
  currentStep: string;
  currentFile?: string;
  totalFiles: number;
  completedFiles: number;
  progressPercent: number;
  files: PipelineFileJob[];
  logs: string[];
  outputs?: Record<string, unknown>;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

const jobs = new Map<string, PipelineJob>();

export class JobStore {
  public static create(inputFiles: string | string[]): PipelineJob {
    const files = Array.isArray(inputFiles) ? inputFiles : [inputFiles];
    const job: PipelineJob = {
      id: randomUUID(),
      inputFile: files[0] ?? "",
      status: "queued",
      currentStep: "queued",
      totalFiles: files.length,
      completedFiles: 0,
      progressPercent: 0,
      files: files.map((inputFile) => ({
        filename: inputFile.split(/[\\/]/).pop() ?? inputFile,
        inputFile,
        status: "waiting",
        currentStep: "waiting",
        progressPercent: 0
      })),
      logs: [],
      startedAt: new Date().toISOString()
    };
    jobs.set(job.id, job);
    return job;
  }

  public static get(id: string): PipelineJob | undefined {
    return jobs.get(id);
  }

  public static snapshot(id: string): (PipelineJob & { elapsedMs: number }) | undefined {
    const job = jobs.get(id);
    if (!job) {
      return undefined;
    }

    return {
      ...job,
      files: job.files.map((file) => ({ ...file })),
      logs: [...job.logs],
      elapsedMs: elapsedMs(job)
    };
  }

  public static setStep(id: string, step: string): void {
    const job = jobs.get(id);
    if (!job) {
      return;
    }
    job.currentStep = step;
    this.addLog(id, step);
  }

  public static setCurrentStep(id: string, step: string): void {
    const job = jobs.get(id);
    if (!job) {
      return;
    }
    job.currentStep = step;
    recomputeProgress(job);
  }

  public static startFile(id: string, filename: string, step: string): void {
    const job = jobs.get(id);
    if (!job) {
      return;
    }
    job.status = "running";
    job.currentFile = filename;
    job.currentStep = step;
    const file = job.files.find((candidate) => candidate.filename === filename);
    if (file) {
      file.status = "running";
      file.currentStep = step;
      file.progressPercent = Math.max(file.progressPercent, progressForStep(step));
    }
    recomputeProgress(job);
    this.addLog(id, `${filename}: ${step}`);
  }

  public static setFileStep(id: string, filename: string, step: string): void {
    const job = jobs.get(id);
    if (!job) {
      return;
    }
    job.currentFile = filename;
    job.currentStep = step;
    const file = job.files.find((candidate) => candidate.filename === filename);
    if (file) {
      file.currentStep = step;
      file.progressPercent = Math.max(file.progressPercent, progressForStep(step));
    }
    recomputeProgress(job);
  }

  public static completeFile(id: string, filename: string, outputs: Record<string, unknown>): void {
    const job = jobs.get(id);
    if (!job) {
      return;
    }
    const file = job.files.find((candidate) => candidate.filename === filename);
    if (file) {
      file.status = "passed";
      file.currentStep = "completed";
      file.progressPercent = 100;
      file.outputs = outputs;
    }
    recomputeProgress(job);
    this.addLog(id, `${filename}: completed`);
  }

  public static failFile(id: string, filename: string, error: string, outputs?: Record<string, unknown>): void {
    const job = jobs.get(id);
    if (!job) {
      return;
    }
    const file = job.files.find((candidate) => candidate.filename === filename);
    if (file) {
      file.status = "failed";
      file.currentStep = "failed";
      file.progressPercent = 100;
      file.error = error;
      file.outputs = outputs;
    }
    recomputeProgress(job);
    this.addLog(id, `${filename}: ${error}`);
  }

  public static setRunning(id: string, step: string): void {
    const job = jobs.get(id);
    if (!job) {
      return;
    }
    job.status = "running";
    job.currentStep = step;
    recomputeProgress(job);
    this.addLog(id, step);
  }

  public static addLog(id: string, message: string): void {
    const job = jobs.get(id);
    if (!job) {
      return;
    }
    job.logs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
  }

  public static setOutputs(id: string, outputs: Record<string, unknown>): void {
    const job = jobs.get(id);
    if (!job) {
      return;
    }
    job.outputs = outputs;
  }

  public static complete(id: string, outputs: Record<string, unknown>): void {
    const job = jobs.get(id);
    if (!job) {
      return;
    }
    job.status = "completed";
    job.currentStep = "completed";
    job.completedFiles = job.files.filter((file) => file.status === "passed" || file.status === "failed").length;
    job.progressPercent = 100;
    job.outputs = outputs;
    job.completedAt = new Date().toISOString();
    this.addLog(id, "Pipeline completed.");
  }

  public static fail(id: string, error: string): void {
    const job = jobs.get(id);
    if (!job) {
      return;
    }
    job.status = "failed";
    job.currentStep = "failed";
    job.error = error;
    recomputeProgress(job);
    job.completedAt = new Date().toISOString();
    this.addLog(id, error);
  }
}

const stepProgress: Array<[string, number]> = [
  ["upload received", 4],
  ["file saved", 8],
  ["parse started", 12],
  ["layout analysis started", 18],
  ["layout/docling", 28],
  ["artifact filtering started", 38],
  ["semantic fusion started", 46],
  ["export assets started", 56],
  ["validation started", 66],
  ["section map", 74],
  ["pageindex upload", 82],
  ["pageindex polling", 90],
  ["tree validation", 96],
  ["completed", 100],
  ["failed", 100]
];

function progressForStep(step: string): number {
  const normalized = step.toLowerCase();
  const match = stepProgress.find(([candidate]) => normalized.includes(candidate));
  return match?.[1] ?? 10;
}

function recomputeProgress(job: PipelineJob): void {
  job.completedFiles = job.files.filter((file) => file.status === "passed" || file.status === "failed").length;
  if (job.files.length === 0) {
    job.progressPercent = 0;
    return;
  }
  const total = job.files.reduce((sum, file) => sum + file.progressPercent, 0);
  job.progressPercent = Math.round(total / job.files.length);
}

function elapsedMs(job: PipelineJob): number {
  const start = Date.parse(job.startedAt);
  const end = job.completedAt ? Date.parse(job.completedAt) : Date.now();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}
