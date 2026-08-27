import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { MediaUnderstandingPort, MediaUnderstandingResult } from "@/modules/media/application/media-understanding.port";
import type { MediaAttachment } from "@/modules/webhooks/domain/ghl-webhook-event";
import type { MediaClassification } from "@/modules/media/media";

const execFileAsync = promisify(execFile);

export type LocalMediaUnderstandingOptions = {
  whisperExecutable?: string;
  whisperModelPath?: string;
  tesseractExecutable?: string;
  timeoutMs?: number;
  logger?: { info(message: string): void; error(message: string): void };
};

const defaultLogger = { info: (message: string) => console.info(message), error: (message: string) => console.error(message) };

/**
 * Optional no-API adapter. It delegates to locally installed whisper.cpp and
 * Tesseract binaries; when not configured, the webhook remains functional and
 * the enrichment layer records a sanitized diagnostic instead of failing it.
 */
export class LocalMediaUnderstandingAdapter implements MediaUnderstandingPort {
  private readonly options: Required<Pick<LocalMediaUnderstandingOptions, "timeoutMs">> & LocalMediaUnderstandingOptions;

  constructor(options: LocalMediaUnderstandingOptions = {}) {
    this.options = { timeoutMs: 120_000, ...options };
  }

  async understand(attachment: MediaAttachment): Promise<MediaUnderstandingResult> {
    const inputPath = await materializeAttachment(attachment);
    try {
      if (attachment.kind === "audio") return await this.transcribe(inputPath);
      return await this.readImage(inputPath);
    } finally {
      if (inputPath.temporaryDirectory) await rm(inputPath.temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async transcribe(input: MaterializedAttachment): Promise<MediaUnderstandingResult> {
    const executable = this.options.whisperExecutable?.trim();
    const modelPath = this.options.whisperModelPath?.trim();
    if (!executable || !modelPath) throw new Error("Local audio transcription is not configured");
    const output = await execFileAsync(executable, ["-m", modelPath, "-f", input.path, "--no-timestamps"], {
      timeout: this.options.timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const text = `${output.stdout}\n${output.stderr}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
    if (!text) throw new Error("Local audio transcription returned empty text");
    this.options.logger?.info(`Local audio transcription completed file=${basename(input.path)}`);
    return { kind: "audio", text, source: "local-whisper" };
  }

  private async readImage(input: MaterializedAttachment): Promise<MediaUnderstandingResult> {
    const executable = this.options.tesseractExecutable?.trim();
    if (!executable) throw new Error("Local image OCR is not configured");
    const output = await execFileAsync(executable, [input.path, "stdout", "-l", "eng+spa"], {
      timeout: this.options.timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const text = output.stdout.replace(/\s+/g, " ").trim();
    this.options.logger?.info(`Local image OCR completed file=${basename(input.path)}`);
    return { kind: "image", classification: classifyImageText(text), source: "local-ocr" };
  }
}

function classifyImageText(text: string): MediaClassification {
  const normalized = text.toLowerCase();
  if (/driver'?s license|driving license|licencia|identificaci[oó]n|passport|pasaporte|id card/.test(normalized)) {
    return "identity_document";
  }
  if (/pay ?stub|paycheck|tal[oó]n|comprobante|estado de cuenta|bank statement|income|ingreso/.test(normalized)) {
    return "income_proof_document";
  }
  if (/honda|toyota|ford|chevrolet|nissan|veh[ií]culo|vehicle|carro|auto|suv|sedan|truck|pickup/.test(normalized)) {
    return "vehicle_photo";
  }
  return text ? "unrelated" : "unknown";
}

type MaterializedAttachment = { path: string; temporaryDirectory?: string };

async function materializeAttachment(attachment: MediaAttachment): Promise<MaterializedAttachment> {
  if (attachment.localPath?.trim()) return { path: attachment.localPath.trim() };
  if (!attachment.url?.trim()) throw new Error(`Media attachment has no local path or URL (${attachment.kind})`);
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`Media download failed with status ${response.status}`);
  const directory = await mkdtemp(join(tmpdir(), "bdc-media-"));
  const extension = extname(new URL(attachment.url).pathname) || (attachment.kind === "audio" ? ".audio" : ".image");
  const path = join(directory, `attachment${extension}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return { path, temporaryDirectory: directory };
}
