// RyzenAdj service: async subprocess I/O, binary detection, status ladder
// and the polling loop. Imports only gi:// modules so it is usable from both
// the extension (shell) and the preferences (gtk) processes.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Status, classifyInfoOutput, classifyRunOutput} from './lib/parser.js';
import {profileArgs, modeArgs, isValidMode, deserializeProfiles} from './lib/profiles.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const FALLBACK_PATHS = [
    '/usr/bin/ryzenadj',
    '/usr/local/bin/ryzenadj',
    '/opt/ryzenadj/ryzenadj',
    '/run/current-system/sw/bin/ryzenadj',
];

const EXEC_TIMEOUT_MS = 8000
const FAST_POLL_SECONDS = 2;
// Delay before re-asserting our state after an AC transition or resume: the
// platform applies its own automatic changes first; ours must land after.
const REASSERT_DELAY_SECONDS = 3;

/** Resolve the ryzenadj binary: explicit setting → PATH → common locations. */
export function resolveBinaryPath(settings) {
    const configured = settings.get_string('binary-path').trim();
    if (configured !== '') {
        return GLib.file_test(configured, GLib.FileTest.IS_EXECUTABLE)
            ? configured : null;
    }
    const found = GLib.find_program_in_path('ryzenadj');
    if (found)
        return found;
    for (const path of FALLBACK_PATHS) {
        if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
            return path;
    }
    return null;
}

/** Run a command, capture output, never hang (force-exit after timeout). */
export async function execCommand(argv, {timeoutMs = EXEC_TIMEOUT_MS, cancellable = null} = {}) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        timeoutId = 0;
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    // Cancelling only aborts the read; the child would keep running and
    // outlive the extension, so kill it too. The service's cancellable is
    // long-lived — leaving the handler connected would leak one per call.
    const cancelId = cancellable ? cancellable.connect(() => proc.force_exit()) : 0;
    try {
        const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
        const exitCode = proc.get_if_exited() ? proc.get_exit_status() : -1;
        return {exitCode, stdout: stdout ?? '', stderr: stderr ?? ''};
    } finally {
        if (timeoutId !== 0)
            GLib.source_remove(timeoutId);
        if (cancelId !== 0)
            cancellable.disconnect(cancelId);
    }
}

/** One-shot check used by the preferences window. */
export async function checkSudoRule(binaryPath) {
    const result = await execCommand(['sudo', '-n', binaryPath, '--info']);
    const {status} = classifyInfoOutput(result);
    return status !== Status.NO_SUDO_RULE;
}

export const RyzenAdjService = GObject.registerClass({
    Signals: {'changed': {}},
}, class RyzenAdjService extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this.status = Status.BINARY_MISSING;
        this.statusMessage = '';
        this.metrics = null;
        this.binaryPath = null;
        this._timerId = 0;
        this._fastPolling = false;
        this._refreshing = false;
        this._destroyed = false;
        this._upowerProxy = null;
        this._upowerId = 0;
        this._resumeId = 0;
        this._reassertId = 0;
        // Aborts any in-flight subprocess call at destroy(); screen lock
        // disables extensions while a sudo ryzenadj run may still be pending.
        this._cancellable = new Gio.Cancellable();
        this._settingsIds = [
            settings.connect('changed::binary-path', () => this.refresh()),
            settings.connect('changed::poll-interval', () => this._restartTimer()),
        ];
    }

    start() {
        this.refresh();
        this._restartTimer();
        this._watchPowerSource();
        this._watchResume();
        // Re-assert persisted state once at startup; the platform may have
        // reset limits while the extension was not running. Errors are
        // expected before setup is complete — swallow them.
        this._reassertState().catch(() => {});
    }

    /** Apply a performance mode; persists only after a successful run. */
    async applyMode(mode) {
        if (!isValidMode(mode))
            throw new Error(`Unknown performance mode: ${mode}`);
        const args = modeArgs(mode);
        if (args)
            await this._run(args);
        if (this._destroyed)
            return;
        this._settings.set_string('performance-mode', mode);
    }

    /** The profile that would be restored, or null when that is disabled. */
    _autoApplyProfile() {
        if (!this._settings.get_boolean('auto-apply-profile'))
            return null;
        const id = this._settings.get_string('last-profile');
        if (id === '')
            return null;
        const profiles = deserializeProfiles(this._settings.get_string('profiles'));
        return profiles.find(p => p.id === id) ?? null;
    }

    /** Arguments needed to restore the user's selections; empty when none. */
    _reassertArgs() {
        const args = [];
        const profile = this._autoApplyProfile();
        if (profile)
            args.push(...profileArgs(profile));
        const mode = modeArgs(this._settings.get_string('performance-mode'));
        if (mode)
            args.push(...mode);
        return args;
    }

    /**
     * Restore profile limits and performance mode in a single invocation, so
     * the two cannot fight over ordering.
     */
    async _reassertState() {
        const args = this._reassertArgs();
        if (args.length > 0)
            await this._run(args);
    }

    /** Systems commonly reset SMU limits on resume; restore them on wake. */
    _watchResume() {
        try {
            this._resumeId = Gio.DBus.system.signal_subscribe(
                'org.freedesktop.login1', 'org.freedesktop.login1.Manager',
                'PrepareForSleep', '/org/freedesktop/login1', null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    const [sleeping] = params.deep_unpack();
                    if (!sleeping) // false = waking up
                        this._scheduleReassert();
                });
        } catch (e) {
            console.warn(`RyzenAdj: logind unavailable, no re-assert on resume (${e.message})`);
        }
    }

    /**
     * The platform auto-applies --max-performance on AC and --power-saving
     * on battery, and may reset limits with it. When the power source flips,
     * re-assert our state shortly after the automatic change.
     */
    _watchPowerSource() {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower',
            'org.freedesktop.UPower', null, (_source, result) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(result);
                    if (this._destroyed)
                        return;
                    this._upowerProxy = proxy;
                    this._upowerId = proxy.connect('g-properties-changed',
                        (_proxy, changed) => {
                            if ('OnBattery' in changed.deep_unpack())
                                this._scheduleReassert();
                        });
                } catch (e) {
                    console.warn(`RyzenAdj: UPower unavailable, mode re-assert on AC changes disabled (${e.message})`);
                }
            });
    }

    _scheduleReassert() {
        if (this._destroyed || this._reassertArgs().length === 0)
            return;
        if (this._reassertId !== 0)
            GLib.source_remove(this._reassertId);
        this._reassertId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            REASSERT_DELAY_SECONDS, () => {
                this._reassertId = 0;
                this._reassertState().catch(e =>
                    console.warn(`RyzenAdj: failed to re-assert state: ${e.message}`));
                return GLib.SOURCE_REMOVE;
            });
    }

    async refresh() {
        if (this._refreshing || this._destroyed)
            return;
        this._refreshing = true;
        try {
            const binary = resolveBinaryPath(this._settings);
            this.binaryPath = binary;
            if (!binary) {
                this._update(Status.BINARY_MISSING, '', null);
                return;
            }
            const result = await execCommand(['sudo', '-n', binary, '--info'],
                {cancellable: this._cancellable});
            if (this._destroyed)
                return;
            const classified = classifyInfoOutput(result);
            this._update(classified.status, classified.message, classified.metrics ?? null);
        } catch (e) {
            // Cancellation is our own teardown, not a device failure.
            if (this._destroyed || e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._update(Status.SMU_ERROR, e.message, null);
        } finally {
            this._refreshing = false;
        }
    }

    async applyProfile(profile) {
        await this._run(profileArgs(profile));
        if (this._destroyed)
            return;
        this._settings.set_string('last-profile', profile.id);
    }

    async _run(args) {
        const binary = resolveBinaryPath(this._settings);
        if (!binary)
            throw new Error('ryzenadj binary not found');
        const result = await execCommand(['sudo', '-n', binary, ...args],
            {cancellable: this._cancellable});
        if (this._destroyed)
            return;
        // Apply commands print no info table, so they are classified by the
        // run rules — the table-based --info rules would reject a clean run.
        const classified = classifyRunOutput(result);
        if (classified.status === Status.NO_SUDO_RULE) {
            throw new Error('Passwordless sudo for RyzenAdj is not configured. ' +
                'Open Settings → Permissions for setup instructions.');
        }
        if (classified.status !== Status.OK)
            throw new Error(classified.message);
        await this.refresh();
    }

    setFastPolling(fast) {
        if (this._fastPolling === fast)
            return;
        this._fastPolling = fast;
        this._restartTimer();
    }

    _restartTimer() {
        if (this._timerId !== 0) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._destroyed)
            return;
        const interval = this._fastPolling
            ? FAST_POLL_SECONDS
            : this._settings.get_int('poll-interval');
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _update(status, message, metrics) {
        this.status = status;
        this.statusMessage = message;
        this.metrics = metrics;
        this.emit('changed');
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        if (this._timerId !== 0) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._reassertId !== 0) {
            GLib.source_remove(this._reassertId);
            this._reassertId = 0;
        }
        if (this._upowerProxy && this._upowerId !== 0) {
            this._upowerProxy.disconnect(this._upowerId);
            this._upowerId = 0;
        }
        this._upowerProxy = null;
        if (this._resumeId !== 0) {
            Gio.DBus.system.signal_unsubscribe(this._resumeId);
            this._resumeId = 0;
        }
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        // _settings deliberately stays: continuations resuming after teardown
        // are guarded by _destroyed, and a null here would turn each of those
        // harmless no-ops back into a TypeError in front of the user.
    }
});
