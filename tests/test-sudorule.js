import {test, assert, assertEq, assertThrows, summary} from './harness.js';
import {
    SUDOERS_PATH, isSafeForRule, ruleText, visudoCommand,
} from '../src/lib/sudorule.js';

const USER = 'core';
const BIN = '/run/current-system/sw/bin/ryzenadj';

test('rule text is exactly the least-privilege per-user line', () => {
    assertEq(ruleText(USER, BIN), 'core ALL=(root) NOPASSWD: /run/current-system/sw/bin/ryzenadj');
    assertEq(ruleText('alice', '/usr/bin/ryzenadj'), 'alice ALL=(root) NOPASSWD: /usr/bin/ryzenadj');
});

test('unsafe users/paths are rejected, not quoted', () => {
    assert(!isSafeForRule('a user', BIN), 'space in user');
    assert(!isSafeForRule(USER, '/path with space/ryzenadj'), 'space in path');
    assert(!isSafeForRule(USER, '/tmp/$(evil)/ryzenadj'), 'command substitution');
    assert(!isSafeForRule(USER, "/tmp/it's/ryzenadj"), 'single quote');
    assert(!isSafeForRule(USER, 'relative/ryzenadj'), 'relative path');
    assert(!isSafeForRule('', BIN), 'empty user');
    assertThrows(() => ruleText(USER, '/bad path/ryzenadj'));
});

test('visudo command targets only the extension-owned file', () => {
    assertEq(SUDOERS_PATH, '/etc/sudoers.d/ryzenadj-gnome');
    assertEq(visudoCommand(), 'sudo visudo -f /etc/sudoers.d/ryzenadj-gnome');
});

summary();
