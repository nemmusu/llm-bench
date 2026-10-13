/** "Le migliori dai tuoi test" of the start flow, on its own: a test measured without a generation speed. */
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigEntry } from '../../../../src/contract/configs';
import { SettingsStep, type SettingsStepProps } from '../../../../src/renderer/components/servers/start/settings-step';
import { formFromParams } from '../../../../src/renderer/components/bench/expert-form';
import { renderUi } from '../helpers';

const entry: ConfigEntry = {
  id: 'c1',
  engineKind: 'llamacpp-native',
  engineLabel: 'llama.cpp b11438',
  engineRelease: 'b11438',
  model: { key: 'k', name: 'Qwen3 8B', weakKey: 'local/q' },
  gpu: { key: 'g', name: 'RTX 5090', hostId: 'h', hostLabel: 'PC' },
  params: { other: [] },
  points: [{ depth: 4096, prefillTps: 900, n: 1 }],
  tags: [],
  sources: [],
  latest: '2026-10-07T10:00:00.000Z',
};

const props = (over: Partial<SettingsStepProps> = {}): SettingsStepProps => ({
  engineKind: 'llamacpp-native',
  tab: 'best',
  onTab: vi.fn(),
  best: 'auto',
  onBest: vi.fn(),
  autoTuned: undefined,
  provenance: undefined,
  configs: [{ entry, headline: undefined }],
  loadingConfig: false,
  presets: [],
  preset: undefined,
  onPreset: vi.fn(),
  othersCount: 0,
  form: formFromParams(undefined),
  invalid: [],
  onForm: vi.fn(),
  unsupported: undefined,
  ...over,
});

describe('settings step', () => {
  it('a configuration measured without a generation speed says so instead of a number', () => {
    renderUi(<SettingsStep {...props()} />, { withSettings: true });
    expect(screen.getByRole('radio', { name: /nessuna velocità misurata/ })).toBeTruthy();
  });
});
