import { describe, it, expect } from 'vitest';
import { SHEET_FRAMES, facingFromStep, pickAgentFrame, WALK_PX_PER_FRAME } from '../agentFrames';

describe('facingFromStep', () => {
  it('turns its back when heading mostly north', () => {
    expect(facingFromStep(0, -1, 'down')).toBe('up');
    expect(facingFromStep(0.4, -1, 'down')).toBe('up');
  });

  it('faces the camera when heading south', () => {
    expect(facingFromStep(0, 1, 'up')).toBe('down');
  });

  it('shows the front for sideways walks — the side view is the mirrored front', () => {
    expect(facingFromStep(1, -0.2, 'up')).toBe('down');
    expect(facingFromStep(-1, 0.1, 'up')).toBe('down');
  });

  it('keeps the current facing when there is no movement', () => {
    expect(facingFromStep(0, 0, 'up')).toBe('up');
    expect(facingFromStep(0, 0, 'down')).toBe('down');
  });
});

describe('pickAgentFrame', () => {
  const still = { walking: false, walkDistance: 0, blinking: false };

  it('stands on the idle frame of the current facing', () => {
    expect(pickAgentFrame({ ...still, facing: 'down' })).toBe(SHEET_FRAMES.idleDown);
    expect(pickAgentFrame({ ...still, facing: 'up' })).toBe(SHEET_FRAMES.idleUp);
  });

  it('blinks only when the face is visible', () => {
    expect(pickAgentFrame({ ...still, facing: 'down', blinking: true })).toBe(SHEET_FRAMES.blinkDown);
    expect(pickAgentFrame({ ...still, facing: 'up', blinking: true })).toBe(SHEET_FRAMES.idleUp);
  });

  it('steps through the four walk frames by distance covered', () => {
    const at = (d: number) =>
      pickAgentFrame({ facing: 'down', walking: true, walkDistance: d, blinking: false });
    expect([0, 1, 2, 3, 4].map(i => at(i * WALK_PX_PER_FRAME + 0.5))).toEqual([
      ...SHEET_FRAMES.walkDown,
      SHEET_FRAMES.walkDown[0],
    ]);
  });

  it('walks away from the camera on the back-view frames', () => {
    const f = pickAgentFrame({ facing: 'up', walking: true, walkDistance: 0, blinking: false });
    expect(SHEET_FRAMES.walkUp).toContain(f);
  });
});
