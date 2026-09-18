import sharp from 'sharp';
import { MAX_IMAGE_BYTES } from '@stakeframe/shared';

const MAX_PIXELS = 40_000_000;

export type VisionImage = {
  image: Buffer;
  mime: 'image/png' | 'image/jpeg';
};

/**
 * Produces a provider-only view of the original attachment.
 *
 * The stored attachment is never changed. The transform deliberately stays
 * photographic: it fixes EXIF orientation and applies the light contrast /
 * sharpness enhancement used by the legacy vision pipeline, without
 * binarizing or inventing pixels through an OCR-specific threshold.
 */
export async function prepareVisionImage(input: Buffer): Promise<VisionImage> {
  const source = sharp(input, { failOn: 'error', limitInputPixels: MAX_PIXELS });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error('IMAGE_INVALID');

  const pipeline = source
    .rotate()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    // Equivalent in intent to the old pipeline's +20% contrast and +30%
    // sharpness, with conservative parameters for small financial glyphs.
    .linear(1.2, -25.5)
    .sharpen({ sigma: 1, m1: 1.3, m2: 2 });

  const image =
    metadata.format === 'png'
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
      : await pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();

  if (!image.length || image.length > MAX_IMAGE_BYTES)
    return { image: input, mime: metadata.format === 'png' ? 'image/png' : 'image/jpeg' };

  return { image, mime: metadata.format === 'png' ? 'image/png' : 'image/jpeg' };
}
