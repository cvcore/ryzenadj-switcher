// Pure formatting of the panel widget rows from configurable content tokens.
// No gi:// imports — unit-testable under gjs or node.
//
// The data object consumed by formatters:
//   {profileName, power, stapm, fast, slow, temp}
// where profileName is a display string and the rest are numbers or null.

const fmtW = v => typeof v === 'number' ? `${v.toFixed(1)}W` : '—';
const fmtC = v => typeof v === 'number' ? `${Math.round(v)}°C` : '—';

/** Ordered registry of the tokens a panel row can contain. */
export const TOKENS = Object.freeze([
    Object.freeze({id: 'profile', label: 'Profile name', format: d => d.profileName ?? '—'}),
    Object.freeze({id: 'power', label: 'Power draw', format: d => fmtW(d.power)}),
    Object.freeze({id: 'stapm', label: 'STAPM power', format: d => fmtW(d.stapm)}),
    Object.freeze({id: 'fast', label: 'Fast PPT power', format: d => fmtW(d.fast)}),
    Object.freeze({id: 'slow', label: 'Slow PPT power', format: d => fmtW(d.slow)}),
    Object.freeze({id: 'temp', label: 'Temperature', format: d => fmtC(d.temp)}),
]);

const TOKEN_IDS = new Set(TOKENS.map(t => t.id));

export function tokenLabel(id) {
    return TOKENS.find(t => t.id === id)?.label ?? id;
}

/**
 * Clean a token list coming from settings: drop unknown ids and duplicates.
 * An empty result falls back to the given default so a row never goes blank.
 */
export function sanitizeTokens(list, fallback = ['profile']) {
    const seen = new Set();
    const clean = [];
    for (const id of Array.isArray(list) ? list : []) {
        if (TOKEN_IDS.has(id) && !seen.has(id)) {
            seen.add(id);
            clean.push(id);
        }
    }
    return clean.length > 0 ? clean : [...fallback];
}

// Approximate line-height factor of a Pango layout relative to the font's
// pixel size; used to fit N rows inside the panel.
const LINE_FACTOR = 1.3;
const MIN_FONT_PX = 6;

/** Largest font size (px) whose rows still fit into availableHeight. */
export function maxFontPx(availableHeight, rows, lineFactor = LINE_FACTOR) {
    const usable = Number.isFinite(availableHeight) ? availableHeight : 0;
    const n = Math.max(1, rows | 0);
    return Math.max(MIN_FONT_PX, Math.floor(usable / (n * lineFactor)));
}

/** The user's requested size, clamped so the widget stays inside the bar. */
export function clampFontPx(requested, availableHeight, rows) {
    return Math.min(Math.max(MIN_FONT_PX, requested | 0), maxFontPx(availableHeight, rows));
}

/** Render one panel row: token values joined by a thin separator. */
export function formatRow(tokenIds, data) {
    return sanitizeTokens(tokenIds)
        .map(id => TOKENS.find(t => t.id === id).format(data))
        .join(' ');
}
