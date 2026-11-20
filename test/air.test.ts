import { describe, it, expect } from 'vitest';
import { airEcosystem, getUrnType, buildAir, typeUrnMap } from '../src/lib/air.js';
import { formatModelResult, formatVersionDetail, modelAirUrns, versionAir } from '../src/lib/format.js';

describe('getUrnType', () => {
  it('maps model types the way civitai does', () => {
    expect(getUrnType('Checkpoint')).toBe('checkpoint');
    expect(getUrnType('LORA')).toBe('lora');
    expect(getUrnType('LoCon')).toBe('lycoris');
    expect(getUrnType('DoRA')).toBe('dora');
    expect(getUrnType('TextualInversion')).toBe('embedding');
    expect(getUrnType('Hypernetwork')).toBe('hypernet');
    expect(getUrnType('TextEncoder')).toBe('text_encoders');
  });

  it('names a diffusion-model or UNet file instead of the model type', () => {
    expect(getUrnType('Checkpoint', 'Diffusion Model')).toBe('diffusionmodel');
    expect(getUrnType('Checkpoint', 'UNet')).toBe('unet');
    expect(getUrnType('Checkpoint', 'Model')).toBe('checkpoint');
  });

  it('gives no type for one civitai has no AIR for', () => {
    expect(getUrnType('Workflows')).toBeNull();
    expect(getUrnType(undefined)).toBeNull();
    expect(getUrnType(null)).toBeNull();
  });

  it('covers the whole map', () => {
    for (const [k, v] of Object.entries(typeUrnMap)) {
      expect(getUrnType(k)).toBe(v);
    }
  });
});

describe('airEcosystem', () => {
  it('returns the root ecosystem key civitai uses', () => {
    expect(airEcosystem('SDXL 1.0')).toBe('sdxl');
    expect(airEcosystem('Pony')).toBe('sdxl');
    expect(airEcosystem('Illustrious')).toBe('sdxl');
    expect(airEcosystem('SD 1.5')).toBe('sd1');
    expect(airEcosystem('Flux.1 D')).toBe('flux1');
    expect(airEcosystem('Upscaler')).toBe('other');
  });

  it('keeps the ecosystems a substring guess got wrong', () => {
    // Each of these came out as the left-hand value before.
    expect(airEcosystem('Flux.1 Krea')).toBe('fluxkrea'); // flux1
    expect(airEcosystem('Pony V7')).toBe('auraflow'); // sdxl
    expect(airEcosystem('Qwen 2')).toBe('qwen2'); // qwen
    expect(airEcosystem('Wan Video 2.2 I2V-A14B')).toBe('wanvideo-22-i2v-a14b'); // wan
    expect(airEcosystem('ZImageTurbo')).toBe('zimageturbo'); // zimage
    expect(airEcosystem('Hunyuan Video')).toBe('hyv1'); // hunyuan
  });

  it('knows base models a substring guess had no rule for', () => {
    expect(airEcosystem('Krea 2')).toBe('krea2');
    expect(airEcosystem('Krea 2 Turbo')).toBe('krea2');
    expect(airEcosystem('LTXV2')).toBe('ltxv2');
    expect(airEcosystem('Anima')).toBe('anima');
  });

  it('returns null for a base model civitai does not list', () => {
    expect(airEcosystem('TotallyUnknown')).toBeNull();
    expect(airEcosystem('constructor')).toBeNull();
    expect(airEcosystem('')).toBeNull();
    expect(airEcosystem(undefined)).toBeNull();
  });
});

describe('buildAir', () => {
  it('builds a valid AIR URN', () => {
    expect(
      buildAir({ modelType: 'Checkpoint', baseModel: 'SDXL 1.0', modelId: 101055, versionId: 128078 })
    ).toBe('urn:air:sdxl:checkpoint:civitai:101055@128078');
  });

  it('matches the AIR civitai.red returns for a Krea 2 Turbo checkpoint', () => {
    // GET /api/v1/model-versions/mini/3091481 -> air
    expect(
      buildAir({ modelType: 'Checkpoint', baseModel: 'Krea 2 Turbo', modelId: 2726029, versionId: 3091481, fileType: 'Model' })
    ).toBe('urn:air:krea2:checkpoint:civitai:2726029@3091481');
  });

  it('builds a diffusion-model URN for a checkpoint that ships only the denoiser', () => {
    expect(
      buildAir({ modelType: 'Checkpoint', baseModel: 'Flux.1 D', modelId: 1, versionId: 2, fileType: 'Diffusion Model' })
    ).toBe('urn:air:flux1:diffusionmodel:civitai:1@2');
  });

  it('returns null when the base model or the type has no AIR', () => {
    expect(buildAir({ modelType: 'Checkpoint', baseModel: 'Mystery', modelId: 1, versionId: 2 })).toBeNull();
    expect(buildAir({ modelType: 'Workflows', baseModel: 'SDXL 1.0', modelId: 1, versionId: 2 })).toBeNull();
  });
});

describe('version AIRs in tool output', () => {
  const site = 'https://civitai.red';

  it('uses the AIR civitai sent over one built locally', () => {
    const v = { id: 2, baseModel: 'Mystery', air: 'urn:air:mystery:lora:civitai:1@2' };
    expect(versionAir(v, 'LORA', 1)).toBe('urn:air:mystery:lora:civitai:1@2');
    expect(formatVersionDetail({ ...v, modelId: 1, model: { type: 'LORA' } }, site)).toContain(
      'AIR: urn:air:mystery:lora:civitai:1@2'
    );
  });

  it('builds list AIRs from each version primary file', () => {
    const model = {
      id: 7,
      name: 'm',
      type: 'Checkpoint',
      modelVersions: [
        { id: 70, baseModel: 'Wan Video 14B t2v', files: [{ type: 'Diffusion Model', primary: true }] },
        { id: 71, baseModel: 'Krea 2', files: [{ type: 'Model', primary: true }] },
      ],
    };
    expect(modelAirUrns(model)).toEqual([
      { versionId: 70, air: 'urn:air:wanvideo14b_t2v:diffusionmodel:civitai:7@70' },
      { versionId: 71, air: 'urn:air:krea2:checkpoint:civitai:7@71' },
    ]);
    expect(formatModelResult(model, 0, site)).toContain('AIR: urn:air:wanvideo14b_t2v:diffusionmodel:civitai:7@70');
  });
});
