import type { MediaUnderstandingResult } from "@/modules/media/application/media-understanding.port";
import { FixtureMediaUnderstandingAdapter } from "@/modules/media/application/fixture-media-understanding.adapter";

export const AUDIO_TEXT = "Hola, busco una SUV para mi familia y tengo dos mil quinientos dolares para el enganche.";
export const IMAGE_TEXT = "Busco una SUV para mi familia. Enganche disponible: 2500 USD.";

export function fixtureAdapter(): FixtureMediaUnderstandingAdapter {
  const audio: MediaUnderstandingResult = { kind: "audio", text: AUDIO_TEXT, source: "fixture" };
  const image: MediaUnderstandingResult = { kind: "image", classification: "unrelated", source: "fixture" };
  return new FixtureMediaUnderstandingAdapter({
    "family-suv.wav": audio,
    "qualification-signals.svg": image,
  });
}
