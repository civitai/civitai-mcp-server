/**
 * AIR (Artificial Intelligence Resource) URN helpers.
 *
 * Format: urn:air:{ecosystem}:{urnType}:civitai:{modelId}@{versionId}
 *
 * Mirrors civitai's `stringifyAIR` (src/shared/utils/air.ts) so the URNs this
 * server emits are the ones civitai shows on the model page and generates with.
 * Prefer the `air` civitai returns (GET /model-versions/:id has one); these are
 * for responses that carry none, such as /models.
 */
import { AIR_ECOSYSTEM_BY_BASE_MODEL } from './air-ecosystems.js';

/** Maps a Civitai model `type` to the AIR `urnType` segment (civitai's typeUrnMap). */
export const typeUrnMap: Record<string, string> = {
  AestheticGradient: 'ag',
  Checkpoint: 'checkpoint',
  Hypernetwork: 'hypernet',
  TextualInversion: 'embedding',
  MotionModule: 'motion',
  Upscaler: 'upscaler',
  VAE: 'vae',
  LORA: 'lora',
  DoRA: 'dora',
  LoCon: 'lycoris',
  Controlnet: 'controlnet',
  TextEncoder: 'text_encoders',
  UNet: 'unet',
  CLIPVision: 'clipvision',
  CLIP: 'clip',
  VisionLanguage: 'visionlanguage',
};

/**
 * A version whose generation file is a standalone diffusion model or UNet ships
 * only the denoiser, and civitai's AIR names that file kind instead of the model
 * type (e.g. a Flux or Wan Checkpoint becomes `diffusionmodel`).
 */
export const fileTypeUrnMap: Record<string, string> = {
  'Diffusion Model': 'diffusionmodel',
  UNet: 'unet',
};

/** The AIR urnType for a model type, or null for a type civitai gives no AIR (Workflows, Poses, ...). */
export function getUrnType(modelType: string | undefined | null, fileType?: string | null): string | null {
  return (fileType ? fileTypeUrnMap[fileType] : undefined) ?? (modelType ? typeUrnMap[modelType] : undefined) ?? null;
}

/** The AIR ecosystem segment for a base model, or null when it is not one civitai knows. */
export function airEcosystem(baseModel: string | undefined | null): string | null {
  if (!baseModel) return null;
  return Object.hasOwn(AIR_ECOSYSTEM_BY_BASE_MODEL, baseModel) ? AIR_ECOSYSTEM_BY_BASE_MODEL[baseModel] ?? null : null;
}

/**
 * Build an AIR URN for a model version, or null when the base model or type has
 * no AIR. `fileType` is the version's primary file type.
 */
export function buildAir(params: {
  modelType: string | undefined | null;
  baseModel: string | undefined | null;
  modelId: number;
  versionId: number;
  fileType?: string | null;
}): string | null {
  const eco = airEcosystem(params.baseModel);
  const urnType = getUrnType(params.modelType, params.fileType);
  if (!eco || !urnType) return null;
  return `urn:air:${eco}:${urnType}:civitai:${params.modelId}@${params.versionId}`;
}
