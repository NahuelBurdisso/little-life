import { describe, it, expect } from 'vitest';
import { playbackChange, speedArrows, speedText } from '../playbackLabel';

describe('playbackChange', () => {
  it('flashes when the speed changes while running', () => {
    expect(playbackChange({ paused: false, speed: 1 }, { paused: false, speed: 2 })).toBe('flash');
    expect(playbackChange({ paused: false, speed: 4 }, { paused: false, speed: 0.5 })).toBe('flash');
  });
  it('flashes on resume, at whatever speed it resumes', () => {
    expect(playbackChange({ paused: true, speed: 2 }, { paused: false, speed: 2 })).toBe('flash');
  });
  it('is silent when nothing changed, and while paused (the PAUSED banner covers it)', () => {
    expect(playbackChange({ paused: false, speed: 1 }, { paused: false, speed: 1 })).toBe('none');
    expect(playbackChange({ paused: false, speed: 1 }, { paused: true, speed: 1 })).toBe('none');
    expect(playbackChange({ paused: true, speed: 1 }, { paused: true, speed: 4 })).toBe('none');
  });
});

describe('speed label', () => {
  it('reads like the buttons do', () => {
    expect(speedText(0.5)).toBe('0.5x');
    expect(speedText(1)).toBe('1x');
    expect(speedText(2)).toBe('2x');
    expect(speedText(4)).toBe('4x');
    expect(speedText(0)).toBe('1x');
    expect(speedText(NaN)).toBe('1x');
  });
  it('more arrows for faster', () => {
    expect([0.5, 1, 2, 4, 8].map(speedArrows)).toEqual([1, 1, 2, 3, 3]);
  });
});
