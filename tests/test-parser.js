import {test, assert, assertEq, assertClose, summary} from './harness.js';
import {
    Status, parseInfoTable, extractMetrics, classifyInfoOutput, classifyRunOutput,
} from '../src/lib/parser.js';
import {INFO_OK, INFO_STRIX, SUDO_DENIED, NO_PERMISSION, BINARY_MISSING} from './fixtures.js';

test('parses all numeric rows from a real --info table', () => {
    const values = parseInfoTable(INFO_OK);
    assertClose(values.get('STAPM LIMIT'), 25.0);
    assertClose(values.get('STAPM VALUE'), 9.882);
    assertClose(values.get('PPT LIMIT FAST'), 30.0);
    assertClose(values.get('PPT VALUE FAST'), 12.1);
    assertClose(values.get('THM VALUE CORE'), 60.25);
    assert(!values.has('Name'), 'header row must be skipped');
});

test('non-table preamble lines are ignored', () => {
    const values = parseInfoTable(INFO_OK);
    assert(!values.has('CPU Family: Rembrandt'));
    for (const key of values.keys())
        assert(!key.includes(':'), `unexpected key ${key}`);
});

test('malformed and empty input yield an empty map', () => {
    assertEq(parseInfoTable('').size, 0);
    assertEq(parseInfoTable(null).size, 0);
    assertEq(parseInfoTable('| BROKEN |\nrandom noise | |').size, 0);
});

test('extractMetrics picks value/limit pairs and nulls missing rows', () => {
    const m = extractMetrics(parseInfoTable(INFO_OK));
    assertClose(m.stapm.value, 9.882);
    assertClose(m.stapm.limit, 25.0);
    assertClose(m.fast.value, 12.1);
    assertClose(m.fast.limit, 30.0);
    assertClose(m.slow.limit, 28.0);
    assertClose(m.temp.value, 60.25);
    assertClose(m.temp.limit, 95.0);

    const empty = extractMetrics(new Map());
    assertEq(empty.stapm.value, null);
    assertEq(empty.temp.limit, null);
});

test('parses the Strix Point v0.19 table (different alignment)', () => {
    const m = extractMetrics(parseInfoTable(INFO_STRIX));
    assertClose(m.stapm.limit, 8.0);
    assertClose(m.stapm.value, 4.232);
    assertClose(m.fast.limit, 8.0);
    assertClose(m.slow.limit, 5.0);
    assertClose(m.temp.value, 47.049);
});

test('classify: good output → OK with metrics', () => {
    const r = classifyInfoOutput({exitCode: 0, stdout: INFO_OK, stderr: ''});
    assertEq(r.status, Status.OK);
    assertClose(r.metrics.fast.value, 12.1);
});

test('classify: sudo password required → NO_SUDO_RULE', () => {
    const r = classifyInfoOutput(SUDO_DENIED);
    assertEq(r.status, Status.NO_SUDO_RULE);
    assert(r.message.includes('password'));
});

test('classify: init failure without root → SMU_ERROR', () => {
    const r = classifyInfoOutput(NO_PERMISSION);
    assertEq(r.status, Status.SMU_ERROR);
});

test('classify: command not found → BINARY_MISSING', () => {
    const r = classifyInfoOutput(BINARY_MISSING);
    assertEq(r.status, Status.BINARY_MISSING);
});

test('classify: empty table with clean exit → SMU_ERROR', () => {
    const r = classifyInfoOutput({exitCode: 0, stdout: 'nothing here', stderr: ''});
    assertEq(r.status, Status.SMU_ERROR);
    assert(r.message.length > 0, 'must carry a diagnostic message');
});

// Apply commands print no table at all — a silent clean exit is the success
// case, and classifying it like --info would break every apply.
test('classifyRun: clean exit with no output → OK', () => {
    const r = classifyRunOutput({exitCode: 0, stdout: '', stderr: ''});
    assertEq(r.status, Status.OK);
    assertEq(r.message, '');
});

test('classifyRun: sudo password required → NO_SUDO_RULE', () => {
    const r = classifyRunOutput(SUDO_DENIED);
    assertEq(r.status, Status.NO_SUDO_RULE);
    assert(r.message.includes('password'));
});

test('classifyRun: init failure without root → SMU_ERROR', () => {
    const r = classifyRunOutput(NO_PERMISSION);
    assertEq(r.status, Status.SMU_ERROR);
    assert(r.message.includes('Unable to init ryzenadj'));
});

test('classifyRun: command not found → BINARY_MISSING', () => {
    const r = classifyRunOutput(BINARY_MISSING);
    assertEq(r.status, Status.BINARY_MISSING);
});

test('classifyRun: non-zero exit with unrecognised stderr → SMU_ERROR', () => {
    const r = classifyRunOutput({exitCode: 3, stdout: '', stderr: 'segfault, sorry\n'});
    assertEq(r.status, Status.SMU_ERROR);
    assertEq(r.message, 'segfault, sorry');

    const silent = classifyRunOutput({exitCode: 3, stdout: '', stderr: ''});
    assertEq(silent.status, Status.SMU_ERROR);
    assert(silent.message.includes('exit 3'), 'falls back to the exit code');
});

summary();
