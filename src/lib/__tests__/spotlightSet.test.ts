import { describe, it, expect } from 'vitest';
import {
  MAX_IN_VIEW,
  SPOTLIGHT_KEEPALIVE_MS,
  buildSpotlight,
  residentsInView,
  shouldSendSpotlight,
  spotlightKey,
} from '../spotlightSet';
import { SPOTLIGHT_MAX_AGENTS, SPOTLIGHT_TTL_MS } from '../../../server/lib/spotlight';
import { registerCameraView, getCameraView } from '../cameraView';

const none = { selectedAgentId: null, shotAgentIds: [], brewing: [], inView: [], favorites: new Set<string>() };

describe('buildSpotlight', () => {
  it('orders selected, shot, top brewing, camera view, favourites — deduped', () => {
    const ids = buildSpotlight({
      selectedAgentId: '4',
      shotAgentIds: [4, 7],
      brewing: [{ agentIds: [9] }, { agentIds: [10, 7] }, { agentIds: [11] }, { agentIds: [12] }],
      inView: [2, 9],
      favorites: new Set(['1', '4']),
    });
    // Brewing item #4 (agent 12) is past the top three.
    expect(ids).toEqual([4, 7, 9, 10, 11, 2, 1]);
  });

  it('is empty with nothing on screen, and ignores junk ids', () => {
    expect(buildSpotlight(none)).toEqual([]);
    expect(buildSpotlight({ ...none, selectedAgentId: 'abc', favorites: new Set(['0', '-3']) })).toEqual([]);
  });

  it('caps at the server limit, keeping the most important', () => {
    const favorites = new Set(Array.from({ length: 40 }, (_, i) => String(i + 100)));
    const ids = buildSpotlight({ ...none, selectedAgentId: '5', favorites });
    expect(ids).toHaveLength(SPOTLIGHT_MAX_AGENTS);
    expect(ids[0]).toBe(5);
  });
});

describe('residentsInView', () => {
  const view = { x: 100, y: 100, width: 200, height: 100 };

  it('keeps residents inside the rect, nearest the centre first', () => {
    const agents = [
      { id: 1, position: { x: 110, y: 110 } },
      { id: 2, position: { x: 200, y: 150 } }, // centre
      { id: 3, position: { x: 400, y: 150 } }, // outside
      { id: 4, position: null },
    ];
    expect(residentsInView(agents, view)).toEqual([2, 1]);
  });

  it('caps a zoomed-out view and returns nothing without a camera', () => {
    const agents = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, position: { x: 150 + i, y: 150 } }));
    expect(residentsInView(agents, view)).toHaveLength(MAX_IN_VIEW);
    expect(residentsInView(agents, null)).toEqual([]);
  });
});

describe('shouldSendSpotlight', () => {
  it('sends the first set (even empty), then only on change or keep-alive', () => {
    expect(shouldSendSpotlight({ key: '', lastKey: null, lastSentAt: 0, now: 0 })).toBe(true);
    expect(shouldSendSpotlight({ key: '1,2', lastKey: '1,2', lastSentAt: 0, now: 5_000 })).toBe(false);
    expect(shouldSendSpotlight({ key: '1,3', lastKey: '1,2', lastSentAt: 0, now: 5_000 })).toBe(true);
    expect(shouldSendSpotlight({ key: '1,2', lastKey: '1,2', lastSentAt: 0, now: SPOTLIGHT_KEEPALIVE_MS })).toBe(true);
    // No keep-alive for an empty set: the server's empty spotlight doesn't expire into anything.
    expect(shouldSendSpotlight({ key: '', lastKey: '', lastSentAt: 0, now: SPOTLIGHT_KEEPALIVE_MS })).toBe(false);
  });

  it('keeps the spotlight alive well inside the server TTL', () => {
    expect(SPOTLIGHT_KEEPALIVE_MS).toBeLessThan(SPOTLIGHT_TTL_MS - 5_000);
  });

  it('spotlightKey ignores order', () => {
    expect(spotlightKey([3, 1, 2])).toBe(spotlightKey([1, 2, 3]));
  });
});

describe('cameraView', () => {
  it('pulls from the registered camera until it unregisters', () => {
    expect(getCameraView()).toBeNull();
    const off = registerCameraView(() => ({ x: 1, y: 2, width: 3, height: 4 }));
    expect(getCameraView()).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    off();
    expect(getCameraView()).toBeNull();
  });
});
