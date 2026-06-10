import { buildAir } from './air.js';

/** Compact a number to K/M form (matches browse.mjs). */
export function formatNumber(n: number | undefined | null): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K';
  return String(v);
}

/** Single-line truncate (strips newlines). */
export function truncate(str: string | undefined | null, max = 80): string {
  if (!str) return '';
  const s = str.replace(/\n/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

/** Strip HTML tags to plain text. */
export function stripHtml(html: string | undefined | null): string {
  if (!html) return '';
  return html
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// ---------------------------------------------------------------------------
// Domain types (partial — only the fields we read).
// ---------------------------------------------------------------------------
export interface ModelVersionLite {
  id: number;
  name?: string;
  baseModel?: string;
  createdAt?: string;
  publishedAt?: string;
  trainedWords?: string[];
  files?: Array<{ name?: string; primary?: boolean; sizeKB?: number; metadata?: { format?: string } }>;
  stats?: { downloadCount?: number; thumbsUpCount?: number };
  images?: Array<{ url?: string; width?: number; height?: number }>;
}

export interface ModelLite {
  id: number;
  name?: string;
  type?: string;
  nsfw?: boolean;
  poi?: boolean;
  description?: string;
  creator?: { username?: string };
  stats?: { downloadCount?: number; rating?: number; favoriteCount?: number };
  tags?: Array<string | { name?: string }>;
  modelVersions?: ModelVersionLite[];
}

function tagNames(tags: ModelLite['tags']): string[] {
  if (!tags) return [];
  return tags.map((t) => (typeof t === 'string' ? t : t.name ?? '')).filter(Boolean);
}

/** Attach an AIR URN to a model's latest version (or each version). */
export function modelAirUrns(model: ModelLite): Array<{ versionId: number; air: string }> {
  const out: Array<{ versionId: number; air: string }> = [];
  for (const v of model.modelVersions ?? []) {
    const air = buildAir({
      modelType: model.type,
      baseModel: v.baseModel,
      modelId: model.id,
      versionId: v.id,
    });
    if (air) out.push({ versionId: v.id, air });
  }
  return out;
}

/** Compact one-line-ish model summary for search results. */
export function formatModelResult(model: ModelLite, index: number, siteUrl: string): string {
  const versions = model.modelVersions ?? [];
  const latest = versions[0];
  const baseModels = [...new Set(versions.map((v) => v.baseModel).filter(Boolean))];
  const stats = model.stats ?? {};
  const lines = [
    `${index + 1}. ${model.name} (ID: ${model.id})`,
    `   Type: ${model.type}  |  Base: ${baseModels.join(', ') || 'N/A'}  |  Creator: ${
      model.creator?.username ?? 'Unknown'
    }`,
    `   Downloads: ${formatNumber(stats.downloadCount)}  |  Rating: ${
      stats.rating ? stats.rating.toFixed(1) : 'N/A'
    }  |  Favorites: ${formatNumber(stats.favoriteCount)}`,
  ];
  if (latest) {
    lines.push(`   Latest: ${latest.name} (Version ID: ${latest.id})`);
    if (latest.trainedWords?.length) lines.push(`   Triggers: ${latest.trainedWords.join(', ')}`);
    const air = buildAir({
      modelType: model.type,
      baseModel: latest.baseModel,
      modelId: model.id,
      versionId: latest.id,
    });
    if (air) lines.push(`   AIR: ${air}`);
  }
  const tags = tagNames(model.tags);
  if (tags.length) lines.push(`   Tags: ${tags.slice(0, 8).join(', ')}`);
  lines.push(`   URL: ${siteUrl}/models/${model.id}`);
  return lines.join('\n');
}

/** Full model detail block. */
export function formatModelDetail(model: ModelLite, siteUrl: string): string {
  const versions = model.modelVersions ?? [];
  const stats = model.stats ?? {};
  const lines = [
    `# ${model.name} (ID: ${model.id})`,
    `Type: ${model.type}  |  Creator: ${model.creator?.username ?? 'Unknown'}`,
    `URL: ${siteUrl}/models/${model.id}`,
    `Downloads: ${formatNumber(stats.downloadCount)}  |  Rating: ${
      stats.rating ? stats.rating.toFixed(1) : 'N/A'
    }  |  Favorites: ${formatNumber(stats.favoriteCount)}`,
    `NSFW: ${model.nsfw ? 'Yes' : 'No'}  |  POI: ${model.poi ? 'Yes' : 'No'}`,
    '',
  ];
  if (model.description) {
    lines.push(`Description: ${truncate(stripHtml(model.description), 300)}`, '');
  }
  const tags = tagNames(model.tags);
  if (tags.length) lines.push(`Tags: ${tags.join(', ')}`, '');

  lines.push(`## Versions (${versions.length})`);
  for (const v of versions.slice(0, 10)) {
    const air = buildAir({
      modelType: model.type,
      baseModel: v.baseModel,
      modelId: model.id,
      versionId: v.id,
    });
    lines.push(`  - ${v.name} (Version ID: ${v.id})`);
    lines.push(`    Base: ${v.baseModel ?? 'Unknown'}  |  Created: ${v.createdAt?.slice(0, 10) ?? 'N/A'}`);
    if (air) lines.push(`    AIR: ${air}`);
    if (v.trainedWords?.length) lines.push(`    Triggers: ${v.trainedWords.join(', ')}`);
    const primary = v.files?.find((f) => f.primary) ?? v.files?.[0];
    if (primary) {
      lines.push(
        `    File: ${primary.name} (${((primary.sizeKB ?? 0) / 1024).toFixed(0)} MB, ${
          primary.metadata?.format ?? 'unknown'
        })`
      );
    }
    lines.push('');
  }
  if (versions.length > 10) lines.push(`  ... and ${versions.length - 10} more versions`);
  return lines.join('\n');
}

/** Full model-version detail block. */
export function formatVersionDetail(
  v: ModelVersionLite & { modelId?: number; model?: { name?: string; type?: string }; status?: string; description?: string },
  siteUrl: string
): string {
  const lines = [
    `# ${v.model?.name ?? 'Unknown'} — ${v.name} (Version ID: ${v.id})`,
    `Model ID: ${v.modelId}  |  Type: ${v.model?.type ?? 'Unknown'}  |  Base: ${v.baseModel ?? 'Unknown'}`,
    `Status: ${v.status ?? 'Unknown'}  |  Published: ${v.publishedAt?.slice(0, 10) ?? 'N/A'}`,
    `URL: ${siteUrl}/models/${v.modelId}?modelVersionId=${v.id}`,
    '',
  ];
  const air = buildAir({
    modelType: v.model?.type,
    baseModel: v.baseModel,
    modelId: v.modelId ?? 0,
    versionId: v.id,
  });
  if (air) lines.push(`AIR: ${air}`, '');
  if (v.trainedWords?.length) lines.push(`Triggers: ${v.trainedWords.join(', ')}`, '');
  if (v.description) lines.push(`Description: ${truncate(stripHtml(v.description), 300)}`, '');
  if (v.files?.length) {
    lines.push('## Files');
    for (const f of v.files) {
      lines.push(`  - ${f.name}${f.primary ? ' (primary)' : ''}  |  ${((f.sizeKB ?? 0) / 1024).toFixed(0)} MB  |  ${f.metadata?.format ?? 'unknown'}`);
    }
  }
  return lines.join('\n');
}

export interface ImageLite {
  id: number;
  width?: number;
  height?: number;
  type?: string;
  url?: string;
  username?: string;
  createdAt?: string;
  nsfwLevel?: string;
  baseModel?: string;
  postId?: number;
  modelVersionIds?: number[];
  stats?: Record<string, number>;
  meta?: {
    prompt?: string;
    negativePrompt?: string;
    sampler?: string;
    steps?: number;
    cfgScale?: number;
    seed?: number;
    Model?: string;
    civitaiResources?: Array<{ type?: string; modelVersionId?: number; versionId?: number; weight?: number }>;
  };
}

/** Full image detail with generation metadata. */
export function formatImageDetail(img: ImageLite, siteUrl: string): string {
  const stats = img.stats ?? {};
  const lines = [
    `# Image ID: ${img.id}`,
    `Dimensions: ${img.width}x${img.height}  |  Type: ${img.type ?? 'image'}`,
    `Creator: ${img.username ?? 'Unknown'}  |  Posted: ${img.createdAt?.slice(0, 10) ?? 'N/A'}`,
    `NSFW Level: ${img.nsfwLevel ?? 'None'}  |  Base model: ${img.baseModel ?? 'N/A'}`,
    `Reactions: Heart ${stats.heartCount ?? 0} | Like ${stats.likeCount ?? 0} | Laugh ${
      stats.laughCount ?? 0
    } | Cry ${stats.cryCount ?? 0} | Comments ${stats.commentCount ?? 0}`,
    '',
  ];
  if (img.meta) {
    lines.push('## Generation Metadata');
    if (img.meta.prompt) lines.push(`Prompt: ${img.meta.prompt}`);
    if (img.meta.negativePrompt) lines.push(`Negative: ${img.meta.negativePrompt}`);
    const params: string[] = [];
    if (img.meta.sampler) params.push(`Sampler: ${img.meta.sampler}`);
    if (img.meta.steps) params.push(`Steps: ${img.meta.steps}`);
    if (img.meta.cfgScale) params.push(`CFG: ${img.meta.cfgScale}`);
    if (img.meta.seed) params.push(`Seed: ${img.meta.seed}`);
    if (img.meta.Model) params.push(`Model: ${img.meta.Model}`);
    if (params.length) lines.push(params.join('  |  '));
    if (img.meta.civitaiResources?.length) {
      lines.push('Resources:');
      for (const r of img.meta.civitaiResources) {
        const vid = r.modelVersionId ?? r.versionId;
        lines.push(`  - ${r.type}: modelVersionId=${vid}${r.weight ? ` weight=${r.weight}` : ''}`);
      }
    }
    lines.push('');
  }
  if (img.postId) lines.push(`Post: ${siteUrl}/posts/${img.postId}`);
  if (img.url) lines.push(`Full image: ${img.url}`);
  return lines.join('\n');
}

/** Compact image search result. */
export function formatImageResult(img: ImageLite, index: number): string {
  const stats = img.stats ?? {};
  const reactions = (stats.heartCount ?? 0) + (stats.likeCount ?? 0) + (stats.laughCount ?? 0);
  const lines = [
    `${index + 1}. Image ID: ${img.id}  |  ${img.width}x${img.height}  |  ${img.type ?? 'image'}`,
    `   Creator: ${img.username ?? 'Unknown'}  |  Reactions: ${formatNumber(reactions)}  |  Comments: ${formatNumber(
      stats.commentCount
    )}`,
  ];
  if (img.baseModel) lines.push(`   Base: ${img.baseModel}`);
  if (img.meta?.prompt) lines.push(`   Prompt: ${truncate(img.meta.prompt, 120)}`);
  if (img.modelVersionIds?.length) lines.push(`   Model version IDs: ${img.modelVersionIds.join(', ')}`);
  if (img.url) lines.push(`   Preview: ${img.url}`);
  return lines.join('\n');
}
