export type MediaClassification =
  | "identity_document"
  | "income_proof_document"
  | "vehicle_photo"
  | "unrelated"
  | "unknown";

export type SofiaMediaContext = {
  audioTranscriptionFailed?: boolean;
  imageClassifications?: MediaClassification[];
  imageVehicleCategories?: string[];
};
