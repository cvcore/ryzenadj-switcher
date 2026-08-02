import {test, assert, assertEq, summary} from './harness.js';
import {TOKENS, tokenLabel, sanitizeTokens, formatRow, maxFontPx, clampFontPx} from '../src/lib/panelformat.js';

const DATA = {
    profileName: 'Balanced',
    power: 12.06,
    stapm: 9.882,
    fast: 12.1,
    slow: 9.885,
    temp: 60.25,
};

test('token registry covers the documented set', () => {
    assertEq(TOKENS.map(t => t.id).join(','), 'profile,power,stapm,fast,slow,temp');
    for (const t of TOKENS)
        assert(t.label.length > 0 && typeof t.format === 'function', t.id);
});

test('tokenLabel resolves and falls back to the id', () => {
    assertEq(tokenLabel('profile'), 'Profile name');
    assertEq(tokenLabel('bogus'), 'bogus');
});

test('sanitizeTokens drops unknown ids and duplicates', () => {
    assertEq(sanitizeTokens(['profile', 'bogus', 'power', 'profile']).join(','), 'profile,power');
});

test('sanitizeTokens falls back on empty/invalid input', () => {
    assertEq(sanitizeTokens([]).join(','), 'profile');
    assertEq(sanitizeTokens(['bogus'], ['power']).join(','), 'power');
    assertEq(sanitizeTokens(null, ['temp']).join(','), 'temp');
});

test('formatRow renders each token type', () => {
    assertEq(formatRow(['profile'], DATA), 'Balanced');
    assertEq(formatRow(['power'], DATA), '12.1W');
    assertEq(formatRow(['temp'], DATA), '60°C');
    assertEq(formatRow(['profile', 'power', 'temp'], DATA), 'Balanced 12.1W 60°C');
});

test('formatRow shows placeholders for missing data', () => {
    assertEq(formatRow(['profile', 'power', 'temp'], {}), '— — —');
});

test('maxFontPx fits rows into the panel height', () => {
    assertEq(maxFontPx(32, 2), 12);
    assertEq(maxFontPx(32, 1), 24);
    assertEq(maxFontPx(26, 2), 10);
    assertEq(maxFontPx(0, 2), 6, 'floor at minimum');
    assertEq(maxFontPx(NaN, 2), 6, 'garbage height tolerated');
    assertEq(maxFontPx(32, 0), 24, 'rows floor at 1');
});

test('clampFontPx respects the request until it would overflow', () => {
    assertEq(clampFontPx(9, 32, 2), 9, 'fits → untouched');
    assertEq(clampFontPx(20, 32, 2), 12, 'too big → clamped');
    assertEq(clampFontPx(20, 32, 1), 20, 'one row has more room');
    assertEq(clampFontPx(2, 32, 2), 6, 'never below minimum');
});

summary();
