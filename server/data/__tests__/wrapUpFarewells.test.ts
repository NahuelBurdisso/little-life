import { describe, it, expect } from 'vitest';
import { WRAP_UP_FAREWELLS, farewellText } from '../wrapUpFarewells';

describe('farewellText', () => {
  it('addresses the partner by first name, without a title (playtest #3)', () => {
    const line = WRAP_UP_FAREWELLS.hunger.find((l) => l.text.includes('{other.name}'))!.text;
    expect(farewellText(line, 'Dr. Sofia Petrov')).toBe("Sorry, Sofia, I'm starving. I have to go find something to eat.");
    expect(farewellText(line, 'Rosa Chen')).toContain('Sorry, Rosa,');
  });

  it('falls back to "friend" without a name and leaves lines without a placeholder alone', () => {
    expect(farewellText('Goodnight, {other.name}.', null)).toBe('Goodnight, friend.');
    expect(farewellText("I've kept you long enough. See you around.", 'Rosa Chen')).toBe("I've kept you long enough. See you around.");
  });
});
