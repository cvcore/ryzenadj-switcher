// Pure profile model: defaults, (de)serialization, validation, argument
// building and measurement-based active-profile matching.
// No gi:// imports — unit-testable under gjs or node.

export const WATT_RANGE = Object.freeze({min: 4, max: 200});
export const TCTL_RANGE = Object.freeze({min: 40, max: 110});

export const DEFAULT_PROFILES = Object.freeze([
    Object.freeze({id: 'power-saver', name: 'Power Saver', stapm: 5, fast: 8, slow: 5, tctl: 85}),
    Object.freeze({id: 'balanced', name: 'Balanced', stapm: 10, fast: 15, slow: 10, tctl: 85}),
    Object.freeze({id: 'performance', name: 'Performance', stapm: 25, fast: 30, slow: 27, tctl: 95}),
]);

export function defaultProfiles() {
    return DEFAULT_PROFILES.map(p => ({...p}));
}

function inRange(n, {min, max}) {
    return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
}

export function isValidProfile(p) {
    return Boolean(p) && typeof p === 'object' &&
        typeof p.id === 'string' && p.id.length > 0 &&
        typeof p.name === 'string' && p.name.trim().length > 0 &&
        inRange(p.stapm, WATT_RANGE) &&
        inRange(p.fast, WATT_RANGE) &&
        inRange(p.slow, WATT_RANGE) &&
        inRange(p.tctl, TCTL_RANGE);
}

/** Parse the settings JSON; malformed input falls back to the defaults. */
export function deserializeProfiles(json) {
    if (typeof json === 'string' && json.trim() !== '') {
        try {
            const parsed = JSON.parse(json);
            if (Array.isArray(parsed)) {
                const valid = parsed.filter(isValidProfile)
                    .map(p => ({id: p.id, name: p.name, stapm: p.stapm, fast: p.fast, slow: p.slow, tctl: p.tctl}));
                if (valid.length > 0)
                    return valid;
            }
        } catch {
            // fall through to defaults
        }
    }
    return defaultProfiles();
}

export function serializeProfiles(profiles) {
    return JSON.stringify(profiles);
}

/** Build ryzenadj arguments; user-facing watts become milliwatts. */
export function profileArgs(p) {
    return [
        `--stapm-limit=${Math.round(p.stapm * 1000)}`,
        `--fast-limit=${Math.round(p.fast * 1000)}`,
        `--slow-limit=${Math.round(p.slow * 1000)}`,
        `--tctl-temp=${Math.round(p.tctl)}`,
    ];
}

/**
 * Whether a profile's limits match what is currently applied (parser
 * metrics). Only the three power limits are compared — tctl is excluded
 * because some platforms clamp or manage it independently.
 */
export function profileMatchesMetrics(profile, metrics, toleranceW = 0.5) {
    if (!metrics)
        return false;
    const near = (measured, target) =>
        typeof measured === 'number' && Math.abs(measured - target) <= toleranceW;
    return near(metrics.stapm?.limit, profile.stapm) &&
        near(metrics.fast?.limit, profile.fast) &&
        near(metrics.slow?.limit, profile.slow);
}

/**
 * Which profile is currently active, judged by measurement.
 *
 * `lastProfileId` (the profile last applied from the menu) only breaks ties
 * between profiles that all match the measurements — duplicates, or limits
 * close enough to fall inside the tolerance. It never marks a profile active
 * when the measurements disagree, so an externally changed machine still
 * reports honestly regardless of the auto-apply setting.
 *
 * @returns {object|null} the active profile, or null ("Custom")
 */
export function resolveActiveProfile(profiles, metrics, lastProfileId = null, toleranceW = 0.5) {
    const matches = (profiles ?? []).filter(p => profileMatchesMetrics(p, metrics, toleranceW));
    if (matches.length === 0)
        return null;
    return matches.find(p => p.id === lastProfileId) ?? matches[0];
}

/**
 * Performance modes, independent from power profiles. The platform applies
 * --max-performance / --power-saving automatically on AC plug/unplug, so the
 * user's selection is persisted in settings (never inferred from --info) and
 * re-asserted by the extension when the power source changes. 'default'
 * means the platform manages itself.
 */
export const PERFORMANCE_MODES = Object.freeze([
    Object.freeze({id: 'default', name: 'Automatic'}),
    Object.freeze({id: 'power-saving', name: 'Power Save'}),
    Object.freeze({id: 'max-performance', name: 'Max Performance'}),
]);

export function isValidMode(mode) {
    return PERFORMANCE_MODES.some(m => m.id === mode);
}

/** ryzenadj arguments for a mode; null when nothing should be run. */
export function modeArgs(mode) {
    switch (mode) {
    case 'power-saving':
        return ['--power-saving'];
    case 'max-performance':
        return ['--max-performance'];
    default:
        return null;
    }
}

/** Derive a unique id slug from a profile name. */
export function makeUniqueId(name, existingIds) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'profile';
    let id = base;
    let n = 2;
    const taken = new Set(existingIds);
    while (taken.has(id))
        id = `${base}-${n++}`;
    return id;
}
