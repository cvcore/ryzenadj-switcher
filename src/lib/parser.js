// Pure parsing/classification logic for `ryzenadj --info` output.
// No gi:// imports — unit-testable under gjs or node.

export const Status = Object.freeze({
    OK: 'ok',
    BINARY_MISSING: 'binary-missing',
    NO_SUDO_RULE: 'no-sudo-rule',
    SMU_ERROR: 'smu-error',
});

/**
 * Parse the ASCII table printed by `ryzenadj --info`:
 *   | STAPM LIMIT         |   25.000  | stapm-limit        |
 * @returns {Map<string, number>} row name → numeric value
 */
export function parseInfoTable(stdout) {
    const values = new Map();
    for (const line of (stdout ?? '').split('\n')) {
        const cells = line.split('|');
        if (cells.length < 3)
            continue;
        const name = cells[1].trim();
        const value = Number.parseFloat(cells[2]);
        if (!name || name === 'Name' || !Number.isFinite(value))
            continue;
        values.set(name, value);
    }
    return values;
}

/**
 * Pick the metrics the UI cares about out of a parsed table.
 * Missing rows become null — some boards do not report every field.
 */
export function extractMetrics(values) {
    const pair = (valueKey, limitKey) => ({
        value: values.get(valueKey) ?? null,
        limit: values.get(limitKey) ?? null,
    });
    return {
        stapm: pair('STAPM VALUE', 'STAPM LIMIT'),
        fast: pair('PPT VALUE FAST', 'PPT LIMIT FAST'),
        slow: pair('PPT VALUE SLOW', 'PPT LIMIT SLOW'),
        temp: pair('THM VALUE CORE', 'THM LIMIT CORE'),
    };
}

/**
 * The failure signatures sudo and ryzenadj emit, shared by the read path
 * (--info) and the apply path (--stapm-limit=…, --max-performance). Keeping
 * one list means a new signature is recognized by both.
 * @param {{exitCode: number, stdout: string, stderr: string}} result
 * @returns {{status: string, message: string}|null} null when none matched
 */
function detectFailure({exitCode, stdout, stderr}) {
    const out = stdout ?? '';
    const err = stderr ?? '';

    if (/password is required|a terminal is required|askpass/i.test(err))
        return {status: Status.NO_SUDO_RULE, message: err.trim()};

    if (exitCode !== 0 && /command not found|no such file/i.test(err))
        return {status: Status.BINARY_MISSING, message: err.trim()};

    if (/unable to init ryzenadj|unable to get|not supported/i.test(`${out}\n${err}`))
        return {status: Status.SMU_ERROR, message: (err.trim() || out.trim())};

    return null;
}

/**
 * Classify the result of running `sudo -n <ryzenadj> --info`.
 * @param {{exitCode: number, stdout: string, stderr: string}} result
 * @returns {{status: string, message: string, metrics?: object, values?: Map}}
 */
export function classifyInfoOutput(result) {
    const failure = detectFailure(result);
    if (failure)
        return failure;

    const {exitCode, stdout, stderr} = result;
    const out = stdout ?? '';
    const values = parseInfoTable(out);
    if (values.size === 0) {
        return {
            status: Status.SMU_ERROR,
            message: (stderr ?? '').trim() || out.trim() ||
                `ryzenadj produced no data (exit ${exitCode})`,
        };
    }
    return {status: Status.OK, message: '', metrics: extractMetrics(values), values};
}

/**
 * Classify a command that only changes settings (--stapm-limit=…,
 * --max-performance). Those print no info table, so the missing-table check of
 * classifyInfoOutput would report a *successful* apply as SMU_ERROR: here
 * success is a clean exit with no failure signature in the output.
 * @param {{exitCode: number, stdout: string, stderr: string}} result
 * @returns {{status: string, message: string}}
 */
export function classifyRunOutput(result) {
    const failure = detectFailure(result);
    if (failure)
        return failure;

    const {exitCode, stdout, stderr} = result;
    if (exitCode === 0)
        return {status: Status.OK, message: ''};
    return {
        status: Status.SMU_ERROR,
        message: (stderr ?? '').trim() || (stdout ?? '').trim() ||
            `ryzenadj failed (exit ${exitCode})`,
    };
}
