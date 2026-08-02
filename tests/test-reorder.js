import {test, assertEq, summary} from './harness.js';
import {moveItem} from '../src/lib/reorder.js';
import {defaultProfiles} from '../src/lib/profiles.js';

const ids = list => list.map(x => x?.id ?? x).join(',');

// Chip token ids: plain strings, reordered horizontally.
const chips = () => ['profile', 'power', 'temp'];

test('moving down inserts before or after the target', () => {
    const list = chips();
    assertEq(ids(moveItem(list, 'profile', 'temp', 'before')), 'power,profile,temp');
    assertEq(ids(moveItem(list, 'profile', 'temp', 'after')), 'power,temp,profile');
});

test('moving up inserts before or after the target', () => {
    const list = chips();
    assertEq(ids(moveItem(list, 'temp', 'profile', 'before')), 'temp,profile,power');
    assertEq(ids(moveItem(list, 'temp', 'profile', 'after')), 'profile,temp,power');
});

test('adjacent items swap', () => {
    const list = chips();
    assertEq(ids(moveItem(list, 'profile', 'power', 'after')), 'power,profile,temp');
    assertEq(ids(moveItem(list, 'power', 'profile', 'before')), 'power,profile,temp');
});

test('placement defaults to before', () => {
    assertEq(ids(moveItem(chips(), 'profile', 'temp')), 'power,profile,temp');
});

test('equal or unknown ids leave the order untouched', () => {
    const list = chips();
    for (const args of [
        ['profile', 'profile', 'before'],
        ['profile', 'profile', 'after'],
        ['gone', 'temp', 'after'],
        ['profile', 'gone', 'after'],
    ])
        assertEq(ids(moveItem(list, ...args)), 'profile,power,temp', args.join('→'));
});

test('empty and missing lists yield an empty array', () => {
    assertEq(moveItem([], 'a', 'b', 'after').length, 0);
    assertEq(moveItem(null, 'a', 'b').length, 0);
});

test('the default key works for profile objects', () => {
    const list = defaultProfiles(); // power-saver, balanced, performance
    assertEq(ids(moveItem(list, 'power-saver', 'performance', 'after')),
        'balanced,performance,power-saver', 'dropped on the lower half of the last row');
    assertEq(ids(moveItem(list, 'power-saver', 'performance', 'before')),
        'balanced,power-saver,performance', 'dropped on the upper half of the last row');
    assertEq(ids(moveItem(list, 'performance', 'power-saver', 'before')),
        'performance,power-saver,balanced', 'to the very front');
});

test('a custom key extractor is honoured', () => {
    const list = [{key: 'a'}, {key: 'b'}, {key: 'c'}];
    const out = moveItem(list, 'a', 'c', 'after', x => x.key);
    assertEq(out.map(x => x.key).join(','), 'b,c,a');
});

test('the input list is never mutated and membership is preserved', () => {
    const list = defaultProfiles();
    const before = ids(list);
    const out = moveItem(list, 'performance', 'power-saver', 'before');
    assertEq(ids(list), before, 'input untouched');
    assertEq(out.length, list.length);
    assertEq(ids(out).split(',').sort().join(','), before.split(',').sort().join(','),
        'same members, different order');
    assertEq(out[0], list[2], 'items are moved, not copied');
});

summary();
