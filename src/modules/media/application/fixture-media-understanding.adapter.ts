import type { MediaAttachment } from "@/modules/webhooks/domain/ghl-webhook-event";
import type { MediaUnderstandingPort, MediaUnderstandingResult } from "@/modules/media/application/media-understanding.port";

export class FixtureMediaUnderstandingAdapter implements MediaUnderstandingPort {
  constructor(private readonly results: Record<string, MediaUnderstandingResult>) {}

  async understand(attachment: MediaAttachment): Promise<MediaUnderstandingResult> {
    const key = attachment.filename ?? attachment.localPath ?? attachment.url;
    const result = key ? this.results[key] : undefined;
    if (!result) throw new Error(`No deterministic media fixture result for ${attachment.kind}`);
    return result;
  }
}
