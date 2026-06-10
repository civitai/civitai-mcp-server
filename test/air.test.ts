import { describe, it, expect } from 'vitest';
import { guessEcosystem, getUrnType, buildAir, typeUrnMap } from '../src/lib/air.js';

describe('getUrnType', () => {
  it('maps known model types', () => {
    expect(getUrnType('Checkpoint')).toBe('checkpoint');
    expect(getUrnType('LORA')).toBe('lora');
    expect(getUrnType('LoCon')).toBe('lycoris');
    expect(getUrnType('DoRA')).toBe('dora');
    expect(getUrnType('TextualInversion')).toBe('embedding');
    expect(getUrnType('Hypernetwork')).toBe('hypernet');
  });

  it('lowercases unknown types', () => {
    expect(getUrnType('SomethingNew')).toBe('somethingnew');
  });

  it('returns unknown for nullish', () => {
    expect(getUrnType(undefined)).toBe('unknown');
    expect(getUrnType(null)).toBe('unknown');
  });

  it('covers the whole map', () => {
    for (const [k, v] of Object.entries(typeUrnMap)) {
      expect(getUrnType(k)).toBe(v);
    }
  });
});

describe('guessEcosystem', () => {
  it('maps base models to ecosystems', () => {
    expect(guessEcosystem('Flux.2')).toBe('flux2');
    expect(guessEcosystem('Flux.1 D')).toBe('flux1');
    expect(guessEcosystem('SD 3.5')).toBe('sd3');
    expect(guessEcosystem('SDXL 1.0')).toBe('sdxl');
    expect(guessEcosystem('Pony')).toBe('sdxl');
    expect(guessEcosystem('Illustrious')).toBe('sdxl');
    expect(guessEcosystem('NoobAI')).toBe('sdxl');
    expect(guessEcosystem('SD 1.5')).toBe('sd1');
    expect(guessEcosystem('SD 2.1')).toBe('sd2');
    expect(guessEcosystem('Chroma')).toBe('chroma');
    expect(guessEcosystem('Qwen')).toBe('qwen');
    expect(guessEcosystem('Wan Video')).toBe('wan');
  });

  it('returns null for unknown / empty base models', () => {
    expect(guessEcosystem('TotallyUnknown')).toBeNull();
    expect(guessEcosystem('')).toBeNull();
    expect(guessEcosystem(undefined)).toBeNull();
  });
});

describe('buildAir', () => {
  it('builds a valid AIR URN', () => {
    expect(
      buildAir({ modelType: 'Checkpoint', baseModel: 'SDXL 1.0', modelId: 101055, versionId: 128078 })
    ).toBe('urn:air:sdxl:checkpoint:civitai:101055@128078');
  });

  it('builds a LoRA URN', () => {
    expect(
      buildAir({ modelType: 'LORA', baseModel: 'Flux.1 D', modelId: 1, versionId: 2 })
    ).toBe('urn:air:flux1:lora:civitai:1@2');
  });

  it('returns null when ecosystem cannot be guessed', () => {
    expect(buildAir({ modelType: 'Checkpoint', baseModel: 'Mystery', modelId: 1, versionId: 2 })).toBeNull();
  });
});
