import type { MediaAttachment, MediaAttachmentKind } from "@/modules/webhooks/domain/ghl-webhook-event";

export type MediaUnderstandingResult = {
  kind: MediaAttachmentKind;
  text: string;
  source: "fixture" | "local-whisper" | "local-ocr";
};

export interface MediaUnderstandingPort {
  understand(attachment: MediaAttachment): Promise<MediaUnderstandingResult>;
}
