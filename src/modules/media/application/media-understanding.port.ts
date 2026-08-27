import type { MediaAttachment, MediaAttachmentKind } from "@/modules/webhooks/domain/ghl-webhook-event";
import type { MediaClassification } from "@/modules/media/media";

export type MediaUnderstandingResult = {
  kind: MediaAttachmentKind;
  /** Text is intentionally supported only for audio. Image text is never returned to the conversation layer. */
  text?: string;
  source: "fixture" | "local-whisper" | "local-ocr";
  classification?: MediaClassification;
};

export interface MediaUnderstandingPort {
  understand(attachment: MediaAttachment): Promise<MediaUnderstandingResult>;
}
