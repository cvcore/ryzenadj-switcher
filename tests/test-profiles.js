import {test, assert, assertEq, summary} from './harness.js';
import {
    DEFAULT_PROFILES, defaultProfiles, isValidProfile,
    deserializeProfiles, serializeProfiles, profileArgs,
    profileMatchesMetrics, resolveActiveProfile, makeUniqueId,
    PERFORMANCE_MODES, isValidMode, modeArgs,
} from '../src/lib/profiles.js';

const metricsFor = (stapm, fast, slow) => ({
    stapm: {value: 1, limit: stapm},
    fast: {value: 1, limit: fast},
    slow: {value: 1, limit: slow},
    temp: {value: 50, limit: 85},
});

test('default profiles are valid and independent copies', () => {
    for (const p of DEFAULT_PROFILES)
        assert(isValidProfile(p), `default profile ${p.id} invalid`);
    const copy = defaultProfiles();
    copy[0].stapm = 99;
    assertEq(DEFAULT_PROFILES[0].stapm, 5, 'defaults must not be mutated');
});

test('serialize/deserialize round-trips', () => {
    const list = defaultProfiles();
    const back = deserializeProfiles(serializeProfiles(list));
    assertEq(JSON.stringify(back), JSON.stringify(list));
});

test('empty, corrupt or invalid JSON falls back to defaults', () => {
    for (const bad of ['', '   ', 'not json', '{}', '[]', '[{"id":"x"}]', null, undefined]) {
        const got = deserializeProfiles(bad);
        assertEq(JSON.stringify(got), JSON.stringify(defaultProfiles()), `input: ${JSON.stringify(bad)}`);
    }
});

test('deserialize keeps valid entries and drops invalid ones', () => {
    const mixed = JSON.stringify([
        {id: 'good', name: 'Good', stapm: 12, fast: 14, slow: 12, tctl: 90},
        {id: 'bad-watts', name: 'Bad', stapm: 5000, fast: 14, slow: 12, tctl: 90},
        {id: '', name: 'NoId', stapm: 12, fast: 14, slow: 12, tctl: 90},
    ]);
    const got = deserializeProfiles(mixed);
    assertEq(got.length, 1);
    assertEq(got[0].id, 'good');
});

test('profileArgs converts watts to milliwatts', () => {
    const args = profileArgs({id: 'x', name: 'X', stapm: 15, fast: 20.5, slow: 17, tctl: 90});
    assertEq(args.join(' '),
        '--stapm-limit=15000 --fast-limit=20500 --slow-limit=17000 --tctl-temp=90');
});

test('profileMatchesMetrics compares limits within ±0.5 W', () => {
    const balanced = defaultProfiles()[1];
    assert(profileMatchesMetrics(balanced, metricsFor(10.2, 15.4, 9.8)));
    assert(!profileMatchesMetrics(balanced, metricsFor(12, 15, 10)));
    assert(!profileMatchesMetrics(balanced, null), 'no metrics → no match');
    assert(!profileMatchesMetrics(balanced, metricsFor(null, 15, 10)), 'missing limit row');
});

// Auto-apply OFF (or nothing remembered yet): pure measurement matching.
test('resolveActiveProfile without a remembered id matches by measurement', () => {
    const profiles = defaultProfiles();
    assertEq(resolveActiveProfile(profiles, metricsFor(10.2, 15.4, 9.8))?.id, 'balanced');
    assertEq(resolveActiveProfile(profiles, metricsFor(5, 8, 5))?.id, 'power-saver');
});

test('resolveActiveProfile → null when nothing matches (Custom)', () => {
    assertEq(resolveActiveProfile(defaultProfiles(), metricsFor(45, 54, 45)), null);
    assertEq(resolveActiveProfile(defaultProfiles(), null), null);
    assertEq(resolveActiveProfile(defaultProfiles(), metricsFor(null, null, null)), null);
});

// Auto-apply ON: the remembered id disambiguates equally-matching profiles.
test('resolveActiveProfile prefers the remembered profile among duplicates', () => {
    const profiles = [
        {id: 'a', name: 'A', stapm: 10, fast: 15, slow: 10, tctl: 85},
        {id: 'b', name: 'B', stapm: 10, fast: 15, slow: 10, tctl: 95},
    ];
    const metrics = metricsFor(10, 15, 10);
    assertEq(resolveActiveProfile(profiles, metrics)?.id, 'a', 'no hint → first match');
    assertEq(resolveActiveProfile(profiles, metrics, 'b')?.id, 'b', 'hint wins');
    assertEq(resolveActiveProfile(profiles, metrics, 'a')?.id, 'a');
});

test('resolveActiveProfile ignores a remembered id that no longer matches', () => {
    const profiles = defaultProfiles();
    // Remembered Performance, but the machine now measures Balanced's limits.
    assertEq(resolveActiveProfile(profiles, metricsFor(10, 15, 10), 'performance')?.id,
        'balanced');
    // Remembered profile was deleted since it was applied.
    assertEq(resolveActiveProfile(profiles, metricsFor(10, 15, 10), 'gone')?.id, 'balanced');
    // Remembered id set, but nothing matches at all.
    assertEq(resolveActiveProfile(profiles, metricsFor(45, 54, 45), 'balanced'), null);
});

test('performance modes: registry shape and validation', () => {
    assertEq(PERFORMANCE_MODES.map(m => m.id).join(','),
        'default,power-saving,max-performance');
    for (const m of PERFORMANCE_MODES)
        assert(m.name.length > 0, m.id);
    assert(isValidMode('default') && isValidMode('power-saving') && isValidMode('max-performance'));
    assert(!isValidMode('turbo') && !isValidMode('') && !isValidMode(null));
});

test('modeArgs maps modes to ryzenadj flags', () => {
    assertEq(modeArgs('power-saving').join(' '), '--power-saving');
    assertEq(modeArgs('max-performance').join(' '), '--max-performance');
    assertEq(modeArgs('default'), null, 'default runs nothing');
    assertEq(modeArgs('garbage'), null, 'invalid runs nothing');
});

test('makeUniqueId slugifies and deduplicates', () => {
    assertEq(makeUniqueId('My Profile!', []), 'my-profile');
    assertEq(makeUniqueId('My Profile', ['my-profile']), 'my-profile-2');
    assertEq(makeUniqueId('My Profile', ['my-profile', 'my-profile-2']), 'my-profile-3');
    assertEq(makeUniqueId('***', []), 'profile');
});

summary();
