/**
 * AIR (Artificial Intelligence Resource) URN helpers.
 *
 * Format: urn:air:{ecosystem}:{urnType}:civitai:{modelId}@{versionId}
 *
 * Ported verbatim from the civitai-browse skill (browse.mjs) so the URNs this
 * server emits match what civitai-gen expects.
 */

/** Maps a Civitai model `type` to the AIR `urnType` segment. */
export const typeUrnMap: Record<string, string> = {
  Checkpoint: 'checkpoint',
  LORA: 'lora',
  LoCon: 'lycoris',
  DoRA: 'dora',
  TextualInversion: 'embedding',
  Hypernetwork: 'hypernet',
  AestheticGradient: 'ag',
  MotionModule: 'motion',
  Upscaler: 'upscaler',
  VAE: 'vae',
  Controlnet: 'controlnet',
};

/** Resolve the AIR urnType for a Civitai model type (falls back to lowercase). */
export function getUrnType(modelType: string | undefined | null): string {
  if (!modelType) return 'unknown';
  return typeUrnMap[modelType] ?? modelType.toLowerCase();
}

/**
 * Guess the AIR ecosystem segment from a baseModel string. Returns null when no
 * mapping is known (in which case an AIR URN cannot be safely constructed).
 */
export function guessEcosystem(baseModel: string | undefined | null): string | null {
  if (!baseModel) return null;
  const bm = baseModel.toLowerCase();
  if (bm.includes('flux.2') || bm.includes('flux2')) return 'flux2';
  if (bm.includes('flux')) return 'flux1';
  if (bm.includes('sd 3') || bm.includes('sd3')) return 'sd3';
  if (bm.includes('sdxl') || bm.includes('pony') || bm.includes('illustrious') || bm.includes('noobai'))
    return 'sdxl';
  if (bm.includes('sd 1') || bm.includes('sd1')) return 'sd1';
  if (bm.includes('sd 2') || bm.includes('sd2')) return 'sd2';
  if (bm.includes('hunyuan')) return 'hunyuan';
  if (bm.includes('kolors')) return 'kolors';
  if (bm.includes('lumina')) return 'lumina';
  if (bm.includes('auraflow')) return 'auraflow';
  if (bm.includes('chroma')) return 'chroma';
  if (bm.includes('hidream')) return 'hidream';
  if (bm.includes('wan')) return 'wan';
  if (bm.includes('qwen')) return 'qwen';
  if (bm.includes('zimage')) return 'zimage';
  if (bm.includes('pixart')) return 'pixart';
  return null;
}

/**
 * Build an AIR URN for a model version. Returns null when the ecosystem cannot
 * be guessed from the baseModel.
 */
export function buildAir(params: {
  modelType: string | undefined | null;
  baseModel: string | undefined | null;
  modelId: number;
  versionId: number;
}): string | null {
  const eco = guessEcosystem(params.baseModel);
  if (!eco) return null;
  const urnType = getUrnType(params.modelType);
  if (urnType === 'unknown') return null;
  return `urn:air:${eco}:${urnType}:civitai:${params.modelId}@${params.versionId}`;
}
