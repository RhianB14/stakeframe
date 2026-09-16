/**
 * Provider-neutral OCR contract.
 *
 * Provider adapters must normalize their response to this shape before it is
 * passed to the multimodal extractor. The original image remains the source
 * of truth and OCR is auxiliary evidence only.
 */
export type OcrPoint = { x: number; y: number };

export type OcrItem = {
  text: string;
  confidence: number | null;
  boundingPoly: OcrPoint[];
};

export type OcrResult = {
  text: string;
  pages: Array<{
    width: number | null;
    height: number | null;
    unit: string | null;
    qualityScore: number | null;
    blocks: OcrItem[];
    lines: OcrItem[];
  }>;
  averageConfidence: number | null;
  averageQualityScore: number | null;
};
