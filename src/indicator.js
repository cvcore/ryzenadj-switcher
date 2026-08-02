import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Status} from './lib/parser.js';
import {deserializeProfiles, resolveActiveProfile, PERFORMANCE_MODES} from './lib/profiles.js';
import {sanitizeTokens, formatRow, maxFontPx} from './lib/panelformat.js';

const DIM = 160; // St actor opacity for secondary text, theme-agnostic
const MIN_FONT_PX = 6;

const APPEARANCE_KEYS = [
    'panel-rows', 'panel-font-family',
    'row1-content', 'row2-content', 'row1-dim', 'row2-dim',
];

const ROW_DEFAULTS = [['profile'], ['power']];

function formatValue(value, digits = 1) {
    return typeof value === 'number' ? value.toFixed(digits) : '—';
}

const TOOLTIP_HOVER_MS = 2000;

/** Delayed hover tooltip for a popup menu item (the shell has none built in). */
class ItemTooltip {
    constructor(item, text) {
        this._item = item;
        this._text = text;
        this._timeoutId = 0;
        this._label = null;
        item.connect('notify::hover', () => {
            if (item.hover)
                this._schedule();
            else
                this.hide();
        });
        item.connect('destroy', () => this.destroy());
    }

    _schedule() {
        if (this._timeoutId !== 0)
            return;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_HOVER_MS, () => {
            this._timeoutId = 0;
            if (this._item.hover && this._item.mapped)
                this._show();
            return GLib.SOURCE_REMOVE;
        });
    }

    _show() {
        if (this._label)
            return;
        this._label = new St.Label({text: this._text, style_class: 'ryzenadj-tooltip'});
        this._label.clutter_text.line_wrap = true;
        Main.uiGroup.add_child(this._label);
        const [x, y] = this._item.get_transformed_position();
        const [width, height] = this._item.get_transformed_size();
        const monitor = Main.layoutManager.findMonitorForActor(this._item);
        let tx = Math.round(x + width / 2 - this._label.width / 2);
        if (monitor) {
            tx = Math.min(tx, monitor.x + monitor.width - this._label.width - 8);
            tx = Math.max(tx, monitor.x + 8);
        }
        this._label.set_position(tx, Math.round(y + height + 4));
    }

    hide() {
        if (this._timeoutId !== 0) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._label?.destroy();
        this._label = null;
    }

    destroy() {
        this.hide();
        this._item = null;
    }
}

/** Right-aligned radio indicator shared by profile and mode items. */
function makeRadio() {
    return new St.Icon({
        icon_name: 'radio-symbolic',
        style_class: 'popup-menu-icon ryzenadj-radio',
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function setRadio(icon, checked) {
    icon.icon_name = checked ? 'radio-checked-symbolic' : 'radio-symbolic';
    icon.opacity = checked ? 255 : DIM;
}

class StatRow {
    constructor(title) {
        this.actor = new St.BoxLayout({style_class: 'ryzenadj-stat-row', x_expand: true});
        this._name = new St.Label({text: title, y_align: Clutter.ActorAlign.CENTER});
        this._name.opacity = DIM;
        this._value = new St.Label({
            style_class: 'ryzenadj-stat-value',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._name);
        this.actor.add_child(this._value);
    }

    set(value, limit, unit) {
        this._value.text = `${formatValue(value)} / ${formatValue(limit, 0)} ${unit}`;
    }
}

export const RyzenAdjIndicator = GObject.registerClass(
class RyzenAdjIndicator extends PanelMenu.Button {
    _init(extension, settings, service) {
        super._init(0.5, 'RyzenAdj');
        this._extension = extension;
        this._settings = settings;
        this._service = service;
        this._profiles = deserializeProfiles(settings.get_string('profiles'));
        this._profileItems = new Map();
        this._rowLabels = [];
        this._rowTokens = [];
        this._configDirty = false;

        this._buildPanelWidget();
        this._buildMenu();
        // Defer panel config until the actor is on stage: St theme nodes (and
        // therefore label height measurement) only exist once mapped. Settings
        // changed while off stage set _configDirty and are replayed here, so a
        // change made behind a fullscreen window is not lost.
        this.connect('notify::mapped', () => {
            if (this.mapped && (this._rowLabels.length === 0 || this._configDirty))
                this._updatePanelConfig();
        });

        // The empty-family default follows the system font.
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interfaceFontId = this._interfaceSettings.connect('changed::font-name',
            () => this._updatePanelConfig());

        this._serviceChangedId = service.connect('changed', () => this._sync());
        this._settingsIds = [
            settings.connect('changed::profiles', () => {
                this._profiles = deserializeProfiles(settings.get_string('profiles'));
                this._rebuildProfileItems();
                this._sync();
            }),
            settings.connect('changed::performance-mode', () => this._sync()),
            settings.connect('changed::last-profile', () => this._sync()),
            ...APPEARANCE_KEYS.map(key =>
                settings.connect(`changed::${key}`, () => this._updatePanelConfig())),
        ];
        this.menu.connect('open-state-changed', (_menu, open) => {
            this._service.setFastPolling(open);
            if (open)
                this._service.refresh();
            else
                this._tooltips?.forEach(t => t.hide());
        });

        this._sync();
    }

    _buildPanelWidget() {
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        // Configurable text rows (1 or 2), rebuilt by _updatePanelConfig().
        this._stack = new St.BoxLayout({
            vertical: true,
            style_class: 'ryzenadj-stack',
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });
        // Track the actual bar height so the font clamp follows it.
        this._panelHeightId = Main.panel.connect('notify::height',
            () => this._updatePanelConfig());

        this._warnBox = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._warnBox.add_child(new St.Icon({
            icon_name: 'dialog-warning-symbolic',
            style_class: 'system-status-icon',
        }));
        this._warnBox.add_child(new St.Label({
            text: 'RyzenAdj',
            style_class: 'ryzenadj-warn-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        box.add_child(this._stack);
        box.add_child(this._warnBox);
        this.add_child(box);
    }

    /** Re-create the panel labels from the appearance settings. */
    _updatePanelConfig() {
        if (!this.mapped) {
            this._configDirty = true;
            return; // deferred to notify::mapped — measuring needs the stage
        }
        this._configDirty = false;
        const rowCount = this._settings.get_int('panel-rows');
        const family = this._settings.get_string('panel-font-family').trim();

        // Stage coordinates are logical pixels; Clutter applies the HiDPI
        // resource scale when rasterizing, so no scale_factor math here.
        const available = Math.max(8, Math.floor(Main.panel.height) - 2);

        this._stack.destroy_all_children();
        this._rowLabels = [];
        this._rowTokens = [];
        for (let i = 0; i < rowCount; i++) {
            const tokens = sanitizeTokens(
                this._settings.get_strv(`row${i + 1}-content`), ROW_DEFAULTS[i]);
            const label = new St.Label({
                style_class: 'ryzenadj-line',
                text: 'Ag', // placeholder with ascender+descender for measuring
                x_align: Clutter.ActorAlign.CENTER,
            });
            label.opacity = this._settings.get_boolean(`row${i + 1}-dim`) ? DIM : 255;
            // Applied straight to the Pango layout (set below). StLabel's
            // style-changed CLASS handler (G_SIGNAL_RUN_LAST) re-applies the
            // theme font after normal handlers — connect_after is required
            // or the theme font silently wins every restyle.
            label.connect_after('style-changed', () => {
                if (this._panelFont)
                    label.clutter_text.font_description = this._panelFont;
            });
            this._stack.add_child(label);
            this._rowLabels.push(label);
            this._rowTokens.push(tokens);
        }

        // Auto-fit: start from a height-based guess, then measure the real
        // line height of the chosen family and shrink until all rows fit.
        let effectiveFamily = family;
        if (effectiveFamily === '') {
            // Follow the system font when no explicit family is chosen.
            try {
                effectiveFamily = Pango.FontDescription.from_string(
                    this._interfaceSettings.get_string('font-name')).get_family() ?? '';
            } catch {
                effectiveFamily = '';
            }
        }
        const applySize = size => {
            const font = Pango.FontDescription.new();
            if (effectiveFamily !== '')
                font.set_family(effectiveFamily);
            font.set_absolute_size(size * Pango.SCALE);
            this._panelFont = font;
            for (const label of this._rowLabels)
                label.clutter_text.font_description = font;
        };
        const totalHeight = () => this._rowLabels.reduce(
            (sum, label) => sum + label.get_preferred_height(-1)[1], 0);

        let size = maxFontPx(available, rowCount);
        applySize(size);
        while (size > MIN_FONT_PX && totalHeight() > available)
            applySize(--size);

        this._sync();
    }

    _makeSectionTitle(text) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_child(new St.Label({
            text,
            style_class: 'ryzenadj-section-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return item;
    }

    _buildMenu() {
        this._statusTitle = this._makeSectionTitle(_('Status'));
        this.menu.addMenuItem(this._statusTitle);

        // Live metrics, non-interactive.
        this._statsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const statsBox = new St.BoxLayout({vertical: true, style_class: 'ryzenadj-stats', x_expand: true});
        this._rows = {
            stapm: new StatRow(_('Sustained (STAPM)')),
            fast: new StatRow(_('Fast boost (PPT)')),
            slow: new StatRow(_('Slow boost (PPT)')),
            temp: new StatRow(_('Temperature')),
        };
        for (const row of Object.values(this._rows))
            statsBox.add_child(row.actor);
        this._statsItem.add_child(statsBox);
        this.menu.addMenuItem(this._statsItem);

        this._statsSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._statsSeparator);

        // Warning section, shown instead of profiles when setup is needed.
        this._warnSection = new PopupMenu.PopupMenuSection();
        this._warnItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._warnItem.label.clutter_text.line_wrap = true;
        // add, not assign: assigning drops the theme's popup-menu label class
        this._warnItem.label.add_style_class_name('ryzenadj-warn-text');
        this._warnSection.addMenuItem(this._warnItem);
        this.menu.addMenuItem(this._warnSection);

        // Profiles.
        this._profileTitle = this._makeSectionTitle(_('Profile'));
        this.menu.addMenuItem(this._profileTitle);
        this._profilesSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._profilesSection);
        this._rebuildProfileItems();

        // Performance modes: persisted selection, independent from profiles.
        this._modeSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._modeSeparator);
        this._modeTitle = this._makeSectionTitle(_('Power Option'));
        this.menu.addMenuItem(this._modeTitle);
        this._modeSection = new PopupMenu.PopupMenuSection();
        this._modeItems = new Map();
        const modeNames = {
            'default': _('Automatic'),
            'power-saving': _('Power Save'),
            'max-performance': _('Max Performance'),
        };
        const modeHints = {
            'default': _('Let the platform decide: it applies max performance on AC and power saving on battery.'),
            'power-saving': _('Prioritize efficiency. Re-applied automatically a few seconds after every plug/unplug.'),
            'max-performance': _('Prioritize performance. Re-applied automatically a few seconds after every plug/unplug.'),
        };
        this._tooltips = [];
        for (const mode of PERFORMANCE_MODES) {
            const item = new PopupMenu.PopupMenuItem(modeNames[mode.id] ?? mode.name);
            item.setOrnament(PopupMenu.Ornament.HIDDEN);
            const radio = makeRadio();
            item.add_child(radio);
            item.connect('activate',
                () => this._apply(() => this._service.applyMode(mode.id)));
            this._tooltips.push(new ItemTooltip(item, modeHints[mode.id] ?? ''));
            this._modeItems.set(mode.id, {item, radio});
            this._modeSection.addMenuItem(item);
        }
        this.menu.addMenuItem(this._modeSection);

        this._editSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._editSeparator);
        this._editItem = new PopupMenu.PopupImageMenuItem(
            _('Settings'), 'applications-system-symbolic');
        this._editItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(this._editItem);
    }

    _rebuildProfileItems() {
        this._profilesSection.removeAll();
        this._profileItems.clear();
        for (const profile of this._profiles) {
            const item = new PopupMenu.PopupMenuItem(profile.name);
            item.setOrnament(PopupMenu.Ornament.HIDDEN);
            const watts = new St.Label({
                text: `${profile.stapm}W`,
                style_class: 'ryzenadj-item-watts',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            watts.opacity = DIM;
            item.add_child(watts);
            const radio = makeRadio();
            radio.x_expand = false; // the watts label already claims the free space
            item.add_child(radio);
            item.connect('activate',
                () => this._apply(() => this._service.applyProfile(profile)));
            this._profileItems.set(profile.id, {item, radio});
            this._profilesSection.addMenuItem(item);
        }
    }

    async _apply(action) {
        try {
            await action();
        } catch (e) {
            Main.notifyError(_('RyzenAdj'), e.message);
        }
    }

    _sync() {
        const {status, statusMessage, metrics} = this._service;
        const ok = status === Status.OK;

        this._stack.visible = ok;
        this._warnBox.visible = !ok;
        this._statusTitle.visible = ok;
        this._statsItem.visible = ok;
        this._statsSeparator.visible = ok;
        this._profileTitle.visible = ok;
        this._profilesSection.actor.visible = ok;
        this._modeSeparator.visible = ok;
        this._modeTitle.visible = ok;
        this._modeSection.actor.visible = ok;
        this._warnSection.actor.visible = !ok;

        if (!ok) {
            this._warnItem.label.text = this._warningText(status, statusMessage);
            return;
        }

        const active = resolveActiveProfile(this._profiles, metrics,
            this._settings.get_string('last-profile'));
        const data = {
            profileName: active ? active.name : _('Custom'),
            power: metrics.fast.value ?? metrics.stapm.value,
            stapm: metrics.stapm.value,
            fast: metrics.fast.value,
            slow: metrics.slow.value,
            temp: metrics.temp.value,
        };
        this._rowLabels.forEach((label, i) => {
            label.text = formatRow(this._rowTokens[i], data);
        });

        this._rows.stapm.set(metrics.stapm.value, metrics.stapm.limit, _('W'));
        this._rows.fast.set(metrics.fast.value, metrics.fast.limit, _('W'));
        this._rows.slow.set(metrics.slow.value, metrics.slow.limit, _('W'));
        this._rows.temp.set(metrics.temp.value, metrics.temp.limit, _('°C'));

        for (const [id, entry] of this._profileItems)
            setRadio(entry.radio, active?.id === id);
        const selectedMode = this._settings.get_string('performance-mode');
        for (const [id, entry] of this._modeItems)
            setRadio(entry.radio, selectedMode === id);
    }

    _warningText(status, message) {
        switch (status) {
        case Status.BINARY_MISSING:
            return _('The RyzenAdj binary was not found.\nInstall RyzenAdj or set its path in Settings.');
        case Status.NO_SUDO_RULE:
            return _('Passwordless sudo for RyzenAdj is not configured.\nOpen Settings → Permissions for setup instructions.');
        case Status.SMU_ERROR:
        default:
            return message
                ? _('RyzenAdj failed:\n%s').replace('%s', message)
                : _('RyzenAdj could not read the SMU.');
        }
    }

    destroy() {
        if (this._panelHeightId) {
            Main.panel.disconnect(this._panelHeightId);
            this._panelHeightId = 0;
        }
        if (this._interfaceFontId) {
            this._interfaceSettings.disconnect(this._interfaceFontId);
            this._interfaceFontId = 0;
        }
        this._interfaceSettings = null;
        if (this._serviceChangedId) {
            this._service.disconnect(this._serviceChangedId);
            this._serviceChangedId = 0;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._service = null;
        this._settings = null;
        this._extension = null;
        super.destroy();
    }
});
