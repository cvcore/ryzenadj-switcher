// Minimal test harness that runs under both gjs (-m) and node.

const out = globalThis.print ?? (s => console.log(s));

let failures = 0;
let count = 0;

export function test(name, fn) {
    count++;
    try {
        fn();
        out(`  ok    ${name}`);
    } catch (e) {
        failures++;
        out(`  FAIL  ${name}`);
        out(`        ${e.message}`);
    }
}

export function assert(cond, msg = 'assertion failed') {
    if (!cond)
        throw new Error(msg);
}

export function assertEq(actual, expected, msg = '') {
    if (actual !== expected)
        throw new Error(`${msg} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`.trim());
}

export function assertClose(actual, expected, eps = 1e-6, msg = '') {
    if (typeof actual !== 'number' || Math.abs(actual - expected) > eps)
        throw new Error(`${msg} expected ≈${expected}, got ${JSON.stringify(actual)}`.trim());
}

export function assertThrows(fn, msg = 'expected an exception') {
    let threw = false;
    try {
        fn();
    } catch {
        threw = true;
    }
    if (!threw)
        throw new Error(msg);
}

/** Print a summary; throw (→ non-zero exit) if anything failed. */
export function summary() {
    out(`${count - failures}/${count} passed`);
    if (failures > 0)
        throw new Error(`${failures} test(s) failed`);
}
