import { describe, expect, it } from 'vitest';
import { VoiceAllocator, VOICE_LIMITS } from '../voices';

const { max, ambienceFloor, bellMax } = VOICE_LIMITS;

describe('VoiceAllocator', () => {
  it('drops sounds past the total cap and takes voices back on release', () => {
    const v = new VoiceAllocator();
    for (let i = 0; i < max; i++) expect(v.reserve('ambience', 1, 0)).toBe(true);
    expect(v.reserve('ambience', 1, 0)).toBe(false);
    v.release('ambience');
    expect(v.reserve('ambience', 1, 0)).toBe(true);
    // Releasing more than was held never goes negative.
    v.release('ambience', 100);
    expect(v.held('ambience')).toBe(0);
  });

  it('reserves a group atomically (a bird takes two voices or none)', () => {
    const v = new VoiceAllocator();
    for (let i = 0; i < max - 1; i++) v.reserve('ambience', 1, 0);
    expect(v.reserve('ambience', 2, 0)).toBe(false);
    expect(v.held('ambience')).toBe(max - 1);
  });

  it('never lets effects starve the ambience layers', () => {
    const v = new VoiceAllocator();
    let fx = 0;
    while (v.reserve('fx', 1, 0)) fx++;
    expect(fx).toBe(max - ambienceFloor);
    // Birds, crickets and drips still get their floor.
    for (let i = 0; i < ambienceFloor; i++) expect(v.reserve('ambience', 1, 0)).toBe(true);
    expect(v.reserve('ambience', 1, 0)).toBe(false);
  });

  it('caps tower bells ringing at the same instant', () => {
    const v = new VoiceAllocator();
    for (let i = 0; i < bellMax; i++) expect(v.reserveBell(0, 1, 9)).toBe(true);
    expect(v.reserveBell(0, 2, 9)).toBe(false);
    // Once the first six have died away the next one fits.
    expect(v.reserveBell(9, 10, 12)).toBe(true);
  });

  it('counts bells by the time they ring, not from scheduling', () => {
    // A peal: 16 strikes 0.3 s apart, each ringing 1.7 s — never more than six in the air.
    const v = new VoiceAllocator();
    let accepted = 0;
    for (let i = 0; i < 16; i++) if (v.reserveBell(0, 0.05 + i * 0.3, 0.05 + i * 0.3 + 1.7)) accepted++;
    expect(accepted).toBe(16);
    // Scheduled far ahead, the queued strikes don't occupy anything now.
    expect(v.active(0)).toBe(0);
    expect(v.reserve('ambience', 1, 0)).toBe(true);
  });

  it('holds a long peal below the total cap so birds keep singing', () => {
    const v = new VoiceAllocator();
    // A peal that starts ringing now and is still going at t = 1.
    for (let i = 0; i < 16; i++) v.reserveBell(0, i * 0.3, i * 0.3 + 1.7);
    let birds = 0;
    while (v.reserve('ambience', 1, 1.0)) birds++;
    expect(birds).toBeGreaterThanOrEqual(ambienceFloor);
    expect(v.active(1.0)).toBeLessThanOrEqual(max);
  });

  it('lets bells and other effects share, but not push ambience under its floor', () => {
    const v = new VoiceAllocator();
    for (let i = 0; i < bellMax; i++) v.reserveBell(0, 0, 10);
    let fx = 0;
    while (v.reserve('fx', 1, 1)) fx++;
    expect(fx + bellMax).toBe(max - ambienceFloor);
    // ...and a bell that would cross the effects budget is dropped, too.
    const w = new VoiceAllocator();
    while (w.reserve('fx', 1, 0)) { /* fill the effects budget */ }
    expect(w.reserveBell(0, 0, 5)).toBe(false);
  });

  it('forgets expired bells so the interval list stays short', () => {
    const v = new VoiceAllocator();
    for (let i = 0; i < 1000; i++) v.reserveBell(i, i, i + 0.5);
    // Every earlier ring is over by now; nothing is still counted at t = 1000.
    expect(v.active(1000)).toBe(0);
    expect(v.reserveBell(1000, 1000, 1001)).toBe(true);
  });
});
