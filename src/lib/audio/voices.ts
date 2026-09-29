/**
 * Voice budget for the synth: how many one-shots may sound at once, and who gets them.
 *
 * A flat counter (the first version) let a long sound crowd out everything else. The worst
 * offender was the bell: a peal is sixteen strikes scheduled in one go, and a strike keeps its
 * voice from the moment it is *scheduled* until its multi-second ring has died, so one peal
 * held half the pool for ~8 s and the birds, crickets and drips simply stopped. Three rules:
 *
 * - **Ambience floor.** Everything that is not ambience (bells and story/UI effects) may hold
 *   at most `max - ambienceFloor` voices together, so the ambience layers always have
 *   `ambienceFloor` voices no matter what the player triggers.
 * - **Bells are time-aware.** Tower bells (peal, knell, tolls, alarm) are counted by the
 *   interval they actually ring, not from scheduling, and at most `bellMax` may ring at the
 *   same instant. Sixteen scheduled strikes that never overlap more than six deep all fit.
 * - **Everything else** keeps the simple counter: reserved up front, given back on `ended`.
 *
 * Pure (no Web Audio), so the rules are unit-tested. Times are `AudioContext.currentTime`.
 */

export type VoiceClass = 'ambience' | 'fx';

export interface VoiceLimits {
  /** Voices in flight, all classes together. */
  max: number;
  /** Voices only ambience may use: fx + bells together stay under `max - ambienceFloor`. */
  ambienceFloor: number;
  /** Tower bells ringing at the same instant. */
  bellMax: number;
}

export const VOICE_LIMITS: VoiceLimits = { max: 32, ambienceFloor: 8, bellMax: 6 };

/** Seconds ahead in which a scheduled bell already counts against a new one-shot. */
const BELL_LOOKAHEAD = 1.5;

export class VoiceAllocator {
  private ambience = 0;
  private fx = 0;
  /** Ring intervals of accepted bells, [start, end). */
  private bells: Array<{ start: number; end: number }> = [];

  constructor(private readonly limits: VoiceLimits = VOICE_LIMITS) {}

  /** Bells ringing at `t`. */
  private bellsAt(t: number): number {
    let n = 0;
    for (const b of this.bells) if (b.start <= t && t < b.end) n++;
    return n;
  }

  /** The most bells ringing together at any instant of [start, end). */
  private bellPeak(start: number, end: number): number {
    let peak = this.bellsAt(start);
    for (const b of this.bells) {
      if (b.start > start && b.start < end) peak = Math.max(peak, this.bellsAt(b.start));
    }
    return peak;
  }

  private prune(now: number): void {
    if (this.bells.length > 0) this.bells = this.bells.filter((b) => b.end > now);
  }

  /** Voices in flight at `now`, for probes and tests. */
  active(now: number): number {
    return this.ambience + this.fx + this.bellsAt(now);
  }

  /** Counter voices held by a class (bells are not counted here — they are intervals). */
  held(cls: VoiceClass): number {
    return cls === 'ambience' ? this.ambience : this.fx;
  }

  /** Reserve `n` counted voices for `cls`; false (nothing reserved) when the budget says no. */
  reserve(cls: VoiceClass, n: number, now: number): boolean {
    this.prune(now);
    const { max, ambienceFloor } = this.limits;
    // Bells that will be ringing within the next moment count too: a one-shot reserved now is
    // still sounding then, and without the lookahead a full pool of birds plus a peal that
    // starts a heartbeat later would overshoot the cap by up to `bellMax`.
    const bellsNow = this.bellPeak(now, now + BELL_LOOKAHEAD);
    if (this.ambience + this.fx + bellsNow + n > max) return false;
    if (cls === 'fx' && this.fx + bellsNow + n > max - ambienceFloor) return false;
    if (cls === 'ambience') this.ambience += n;
    else this.fx += n;
    return true;
  }

  /** Give back `n` voices reserved with `reserve` (the sound ended). */
  release(cls: VoiceClass, n = 1): void {
    if (cls === 'ambience') this.ambience = Math.max(0, this.ambience - n);
    else this.fx = Math.max(0, this.fx - n);
  }

  /**
   * Reserve one tower-bell ring over [start, end). Nothing to release: the interval simply
   * expires. False when it would put more than `bellMax` bells in the air together, or would
   * eat into the ambience floor.
   */
  reserveBell(now: number, start: number, end: number): boolean {
    this.prune(now);
    const { max, ambienceFloor, bellMax } = this.limits;
    const peak = this.bellPeak(start, end);
    if (peak + 1 > bellMax) return false;
    if (this.fx + peak + 1 > max - ambienceFloor) return false;
    if (this.ambience + this.fx + peak + 1 > max) return false;
    this.bells.push({ start, end });
    return true;
  }
}
