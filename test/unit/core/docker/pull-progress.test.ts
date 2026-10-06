import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/contract/errors';
import { pullError, pullFailureReason, PullAggregator, type PullMessage } from '../../../../src/core/docker/pull-progress';
import { DOCKER_FIXTURES } from './helpers';

const lines = (name: string): PullMessage[] =>
  readFileSync(path.join(DOCKER_FIXTURES, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PullMessage);

describe('PullAggregator', () => {
  it('aggregates a real-format pull stream into bytes and layers', () => {
    const agg = new PullAggregator();
    const snaps = lines('pull-vllm.jsonl').map((m) => agg.push(m));
    expect(snaps[0]).toEqual({ status: 'resolving', bytesDone: 0, bytesTotal: 0, layersDone: 0, layersTotal: 0 });
    // After the first Downloading message: 1 MiB of 4 MiB known so far.
    expect(snaps[5]).toMatchObject({ status: 'downloading', bytesDone: 1048576, bytesTotal: 4194304, layersDone: 1, layersTotal: 3 });
    // The retry resets that layer's progress.
    const retry = snaps[10] as (typeof snaps)[number];
    expect(retry.bytesDone).toBe(4194304);
    // All downloaded, extraction running.
    expect(snaps[13]?.status).toBe('extracting');
    const last = snaps.at(-1);
    expect(last).toEqual({ status: 'done', bytesDone: 12582912, bytesTotal: 12582912, layersDone: 3, layersTotal: 3 });
    expect(agg.digest).toBe('sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3');
    expect(agg.done).toBe(true);
  });

  it('ignores messages without status or layer id and clamps current to total', () => {
    const agg = new PullAggregator();
    agg.push({});
    agg.push({ id: 'x', status: '' });
    agg.push({ id: 'l1', status: 'Downloading', progressDetail: { current: 50, total: 10 } });
    agg.push({ id: 'l1', status: 'Downloading', progressDetail: { total: 10 } });
    expect(agg.snapshot()).toMatchObject({ bytesDone: 0, bytesTotal: 10 });
    agg.push({ id: 'l1', status: 'Downloading', progressDetail: { current: 4, total: 0 } });
    agg.push({ id: 'l1', status: 'Downloading' });
    expect(agg.snapshot()).toMatchObject({ bytesDone: 0, bytesTotal: 10, status: 'downloading' });
    expect(agg.done).toBe(false);
  });

  it('throws the in-stream error', () => {
    const agg = new PullAggregator();
    const [first, second] = lines('pull-manifest-unknown.jsonl') as [PullMessage, PullMessage];
    agg.push(first);
    expect(() => agg.push(second)).toThrow(AppError);
    try {
      agg.push(second);
    } catch (e) {
      expect((e as AppError).code).toBe('DOCKER_PULL_FAILED');
      expect((e as AppError).params).toEqual({ reason: 'not-found' });
    }
    expect(() => new PullAggregator().push({ error: 'plain error' })).toThrow('plain error');
  });
});

describe('pull errors', () => {
  it('classifies the daemon message', () => {
    expect(pullFailureReason('manifest unknown')).toBe('not-found');
    expect(pullFailureReason("pull access denied for x, repository does not exist or may require 'docker login'")).toBe('not-found');
    expect(pullFailureReason('toomanyrequests: You have reached your pull rate limit')).toBe('rate-limited');
    expect(pullFailureReason('unauthorized: authentication required')).toBe('auth');
    expect(pullFailureReason('net/http: TLS handshake timeout')).toBe('network');
    expect(pullFailureReason('something else')).toBe('other');
  });

  it('maps a full disk to DISK_FULL and keeps the image', () => {
    const e = pullError('write /var/lib/docker/tmp: no space left on device', 'a/b:c');
    expect(e.code).toBe('DISK_FULL');
    expect(e.params).toEqual({ reason: 'other', image: 'a/b:c' });
    expect(pullError('denied').code).toBe('DOCKER_PULL_FAILED');
  });
});
