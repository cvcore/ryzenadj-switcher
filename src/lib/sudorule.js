// Pure generation of the least-privilege sudoers rule shown in the
// preferences. The extension never modifies the system itself — the user
// installs the rule manually (visudo); the UI only displays and copies it.
// No gi:// imports — unit-testable under gjs or node.

export const SUDOERS_PATH = '/etc/sudoers.d/ryzenadj-gnome';

const USER_RE = /^[a-z_][a-z0-9_.-]*\$?$/i;
// Absolute path without whitespace or shell metacharacters. Anything fancier
// is rejected rather than quoted — sudoers command specs have their own
// escaping rules, and a binary path this unusual deserves manual setup.
const PATH_RE = /^\/[^\s'"\\;|&<>$`*?[\]()]+$/;

export function isSafeForRule(user, binaryPath) {
    return USER_RE.test(user ?? '') && PATH_RE.test(binaryPath ?? '');
}

/** The exact single line the user adds to the sudoers file. */
export function ruleText(user, binaryPath) {
    if (!isSafeForRule(user, binaryPath))
        throw new Error(`Cannot generate a sudoers rule for user "${user}" and path "${binaryPath}"`);
    return `${user} ALL=(root) NOPASSWD: ${binaryPath}`;
}

/** The command that opens the right file in visudo for manual editing. */
export function visudoCommand() {
    return `sudo visudo -f ${SUDOERS_PATH}`;
}
