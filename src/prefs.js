import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {resolveBinaryPath, checkSudoRule} from './ryzenadj.js';
import {deserializeProfiles, serializeProfiles, makeUniqueId, WATT_RANGE, TCTL_RANGE} from './lib/profiles.js';
import {moveItem} from './lib/reorder.js';
import {TOKENS, tokenLabel} from './lib/panelformat.js';
import * as SudoRule from './lib/sudorule.js';

// Icon names restricted to GTK4's built-in set so they render even when no
// full icon theme is resolvable (observed on NixOS).
const ICON_OK = 'object-select-symbolic';
const ICON_WARN = 'dialog-warning-symbolic';

/** The GNOME drag handle, with a fallback for themes that lack it. */
function dragHandleIconName() {
    const display = Gdk.Display.get_default();
    const theme = display ? Gtk.IconTheme.get_for_display(display) : null;
    return theme?.has_icon('list-drag-handle-symbolic')
        ? 'list-drag-handle-symbolic' : 'view-list-symbolic';
}

const PREFS_CSS = `
.ryzenadj-chip {
    border-radius: 99px;
    padding: 2px 4px 2px 10px;
    background: alpha(@window_fg_color, 0.08);
}
.ryzenadj-chip-add {
    border-radius: 99px;
}
/* insertion hint: the edge the dragged row would land on */
.ryzenadj-drop-before {
    box-shadow: inset 0 3px 0 0 @accent_bg_color;
}
.ryzenadj-drop-after {
    box-shadow: inset 0 -3px 0 0 @accent_bg_color;
}
`;

function installPrefsCss() {
    const provider = new Gtk.CssProvider();
    provider.load_from_string(PREFS_CSS); // GTK >= 4.12 (GNOME 46 floor)
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

function copyToClipboard(widget, window, text, toastTitle) {
    widget.get_clipboard().set(text);
    window.add_toast(new Adw.Toast({title: toastTitle}));
}

/** Icon + colored text suffix for a status row: green ok / amber warning. */
function statusBadge() {
    const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
    const icon = new Gtk.Image();
    const label = new Gtk.Label();
    box.append(icon);
    box.append(label);
    const set = (state, text) => {
        icon.visible = state !== 'none';
        icon.icon_name = state === 'ok' ? ICON_OK : ICON_WARN;
        for (const widget of [icon, label]) {
            widget.remove_css_class('success');
            widget.remove_css_class('warning');
            widget.remove_css_class('dim-label');
            if (state === 'ok')
                widget.add_css_class('success');
            else if (state === 'warn')
                widget.add_css_class('warning');
            else
                widget.add_css_class('dim-label');
        }
        label.label = text;
    };
    return {box, set};
}

function monospaceLabel(text) {
    return new Gtk.Label({
        label: text,
        selectable: true,
        wrap: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR,
        xalign: 0,
        hexpand: true,
        css_classes: ['monospace'],
        margin_top: 10,
        margin_bottom: 10,
        margin_start: 12,
        margin_end: 6,
    });
}

// ---------------------------------------------------------------- General --

function buildGeneralPage(settings, window) {
    const page = new Adw.PreferencesPage({
        title: _('General'),
        icon_name: 'preferences-system-symbolic',
    });
    const user = GLib.get_user_name();

    const general = new Adw.PreferencesGroup({title: _('General')});
    const pollRow = new Adw.SpinRow({
        title: _('Refresh interval'),
        subtitle: _('Seconds between power readings'),
        adjustment: new Gtk.Adjustment({lower: 1, upper: 120, step_increment: 1}),
    });
    settings.bind('poll-interval', pollRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    general.add(pollRow);
    page.add(general);

    const perms = new Adw.PreferencesGroup({
        title: _('Permissions'),
        description: _('RyzenAdj needs root to talk to the SMU — even for reading. ' +
            'The extension runs it via "sudo -n", which requires a one-time sudoers ' +
            'rule granting only your user passwordless execution of only this binary.'),
    });

    const pathRow = new Adw.EntryRow({title: _('RyzenAdj binary path (empty = autodetect)')});
    settings.bind('binary-path', pathRow, 'text', Gio.SettingsBindFlags.DEFAULT);
    perms.add(pathRow);

    const binRow = new Adw.ActionRow({title: _('Current RyzenAdj binary')});
    const binBadge = statusBadge();
    binRow.add_suffix(binBadge.box);
    perms.add(binRow);

    const sudoRow = new Adw.ActionRow({title: _('Passwordless sudo rule status')});
    const sudoBadge = statusBadge();
    const refreshBtn = new Gtk.Button({
        icon_name: 'view-refresh-symbolic',
        css_classes: ['flat'],
        valign: Gtk.Align.CENTER,
        tooltip_text: _('Re-check'),
        visible: false,
    });
    sudoRow.add_suffix(sudoBadge.box);
    sudoRow.add_suffix(refreshBtn);
    perms.add(sudoRow);

    const setupRow = new Adw.ExpanderRow({
        title: _('Setup instructions'),
        subtitle: _('Add the rule below to %s').replace('%s', SudoRule.SUDOERS_PATH),
    });

    const cmdLabel = monospaceLabel(SudoRule.visudoCommand());
    const cmdCopy = new Gtk.Button({
        icon_name: 'edit-copy-symbolic',
        css_classes: ['flat'],
        valign: Gtk.Align.CENTER,
        margin_end: 8,
        tooltip_text: _('Copy command'),
    });
    const cmdBox = new Gtk.Box({spacing: 4});
    cmdBox.append(cmdLabel);
    cmdBox.append(cmdCopy);
    setupRow.add_row(cmdBox);

    const ruleLabel = monospaceLabel('');
    const ruleCopy = new Gtk.Button({
        icon_name: 'edit-copy-symbolic',
        css_classes: ['flat'],
        valign: Gtk.Align.CENTER,
        margin_end: 8,
        tooltip_text: _('Copy rule'),
    });
    const ruleBox = new Gtk.Box({spacing: 4});
    ruleBox.append(ruleLabel);
    ruleBox.append(ruleCopy);
    setupRow.add_row(ruleBox);

    const hintLabel = new Gtk.Label({
        label: _('Run the command in a terminal, paste the rule line, save and exit. ' +
            'Then press the refresh button above to re-check.'),
        wrap: true,
        xalign: 0,
        css_classes: ['dim-label', 'caption'],
        margin_top: 6,
        margin_bottom: 10,
        margin_start: 12,
        margin_end: 12,
    });
    setupRow.add_row(hintLabel);
    perms.add(setupRow);
    page.add(perms);

    let currentBinary = null;

    const refreshStatus = () => {
        currentBinary = resolveBinaryPath(settings);
        const canGenerate = Boolean(currentBinary) && SudoRule.isSafeForRule(user, currentBinary);
        binRow.subtitle = currentBinary ?? _('Not found — install RyzenAdj or set its path above');
        binBadge.set(currentBinary ? 'ok' : 'warn',
            currentBinary ? _('Detected') : _('Not found'));

        ruleLabel.label = canGenerate
            ? SudoRule.ruleText(user, currentBinary)
            : _('(no valid binary path — the rule will appear here)');
        ruleCopy.sensitive = canGenerate;

        if (!currentBinary) {
            sudoRow.subtitle = _('Waiting for a valid binary path');
            sudoBadge.set('warn', _('Not configured'));
            refreshBtn.visible = true;
            return;
        }
        sudoRow.subtitle = _('Checking…');
        sudoBadge.set('none', _('Checking…'));
        checkSudoRule(currentBinary).then(ok => {
            sudoRow.subtitle = ok
                ? _('Configured — RyzenAdj runs without a password prompt')
                : _('Not configured — see the setup instructions below');
            sudoBadge.set(ok ? 'ok' : 'warn', ok ? _('Detected') : _('Not configured'));
            refreshBtn.visible = !ok;
            setupRow.expanded = !ok;
        }).catch(e => {
            sudoRow.subtitle = e.message;
            sudoBadge.set('warn', _('Not configured'));
            refreshBtn.visible = true;
        });
    };

    refreshBtn.connect('clicked', refreshStatus);
    settings.connect('changed::binary-path', refreshStatus);
    cmdCopy.connect('clicked', () =>
        copyToClipboard(cmdCopy, window, SudoRule.visudoCommand(), _('Command copied')));
    ruleCopy.connect('clicked', () => {
        if (ruleCopy.sensitive)
            copyToClipboard(ruleCopy, window, ruleLabel.label, _('Rule copied'));
    });

    const support = new Adw.PreferencesGroup({title: _('Support')});
    const coffeeRow = new Adw.ActionRow({
        title: _('Buy Me a Coffee'),
        subtitle: _('Enjoying the extension? A coffee keeps development going ❤'),
        activatable: true,
    });
    coffeeRow.add_prefix(new Gtk.Label({label: '☕'}));
    coffeeRow.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    coffeeRow.connect('activated', () => {
        new Gtk.UriLauncher({uri: 'https://buymeacoffee.com/cvcore'})
            .launch(window, null, null);
        window.add_toast(new Adw.Toast({title: _('Thanks for the support ❤')}));
    });
    support.add(coffeeRow);
    page.add(support);

    refreshStatus();
    return page;
}

// ------------------------------------------------------------- Appearance --

/**
 * Chips editor for one row's content tokens: current tokens as removable,
 * drag-reorderable pill chips; the remaining options as "+" chips below.
 */
function buildChipsEditor(settings, key) {
    const container = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        margin_top: 10,
        margin_bottom: 10,
        margin_start: 12,
        margin_end: 12,
    });

    const validIds = new Set(TOKENS.map(t => t.id));
    const readTokens = () => {
        const seen = new Set();
        return settings.get_strv(key).filter(id => {
            if (!validIds.has(id) || seen.has(id))
                return false;
            seen.add(id);
            return true;
        });
    };
    const writeTokens = list => settings.set_strv(key, list);

    const selectedBox = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        column_spacing: 6,
        row_spacing: 6,
        max_children_per_line: 10,
    });
    const selectedFrame = new Gtk.Frame({child: selectedBox});
    selectedBox.margin_top = 6;
    selectedBox.margin_bottom = 6;
    selectedBox.margin_start = 6;
    selectedBox.margin_end = 6;

    const paletteLabel = new Gtk.Label({
        label: _('Click to add:'),
        xalign: 0,
        css_classes: ['dim-label', 'caption'],
    });
    const paletteBox = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        column_spacing: 6,
        row_spacing: 6,
        max_children_per_line: 10,
    });

    const makeChip = id => {
        // halign START keeps the pill at natural width — the auto-created
        // FlowBoxChild would otherwise stretch it to the column width.
        const chip = new Gtk.Box({
            spacing: 2,
            css_classes: ['ryzenadj-chip'],
            halign: Gtk.Align.START,
        });
        chip.append(new Gtk.Label({label: tokenLabel(id)}));
        const close = new Gtk.Button({
            icon_name: 'window-close-symbolic',
            css_classes: ['flat', 'circular'],
            valign: Gtk.Align.CENTER,
        });
        close.connect('clicked', () => {
            writeTokens(readTokens().filter(t => t !== id));
            rebuild();
        });
        chip.append(close);

        // Drag to reorder within the row.
        const drag = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
        drag.connect('prepare', () => Gdk.ContentProvider.new_for_value(id));
        chip.add_controller(drag);
        const drop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        drop.connect('drop', (_t, draggedId, x) => {
            if (draggedId === id || !validIds.has(draggedId))
                return false;
            // Chips flow horizontally: the half of the chip the pointer landed
            // on decides which side of it the dragged chip goes.
            const placement = x < chip.get_width() / 2 ? 'before' : 'after';
            writeTokens(moveItem(readTokens(), draggedId, id, placement));
            rebuild();
            return true;
        });
        chip.add_controller(drop);
        return chip;
    };

    const makeAddChip = id => {
        const btn = new Gtk.Button({
            css_classes: ['ryzenadj-chip-add', 'flat'],
            halign: Gtk.Align.START,
        });
        const inner = new Gtk.Box({spacing: 4});
        inner.append(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        inner.append(new Gtk.Label({label: tokenLabel(id)}));
        btn.set_child(inner);
        btn.connect('clicked', () => {
            writeTokens([...readTokens(), id]);
            rebuild();
        });
        return btn;
    };

    const rebuild = () => {
        selectedBox.remove_all();
        paletteBox.remove_all();
        const tokens = readTokens();
        for (const id of tokens)
            selectedBox.append(makeChip(id));
        const unused = TOKENS.map(t => t.id).filter(id => !tokens.includes(id));
        for (const id of unused)
            paletteBox.append(makeAddChip(id));
        paletteLabel.visible = unused.length > 0;
    };

    container.append(selectedFrame);
    container.append(paletteLabel);
    container.append(paletteBox);
    rebuild();
    return container;
}

function buildAppearancePage(settings) {
    const page = new Adw.PreferencesPage({
        title: _('Appearance'),
        icon_name: 'applications-graphics-symbolic',
    });

    const panelGroup = new Adw.PreferencesGroup({
        title: _('Panel Widget'),
        description: _('How the indicator in the top bar is rendered.'),
    });

    const rowsRow = new Adw.ComboRow({
        title: _('Rows'),
        model: new Gtk.StringList({strings: [_('One row'), _('Two rows')]}),
        selected: settings.get_int('panel-rows') - 1,
    });
    rowsRow.connect('notify::selected', () =>
        settings.set_int('panel-rows', rowsRow.selected + 1));
    panelGroup.add(rowsRow);

    // Font size is auto-fitted to the bar height; only the family is chosen.
    const defaultEntry = _('Default (system font)');
    const families = PangoCairo.FontMap.get_default().list_families()
        .map(f => f.get_name())
        .sort((a, b) => a.localeCompare(b));
    const fontRow = new Adw.ComboRow({
        title: _('Font'),
        subtitle: _('Size adjusts automatically to the bar height'),
        model: new Gtk.StringList({strings: [defaultEntry, ...families]}),
        enable_search: true,
        expression: Gtk.PropertyExpression.new(Gtk.StringObject, null, 'string'),
    });
    const storedFamily = settings.get_string('panel-font-family');
    const storedIndex = families.indexOf(storedFamily);
    fontRow.selected = storedIndex >= 0 ? storedIndex + 1 : 0;
    fontRow.connect('notify::selected', () => {
        settings.set_string('panel-font-family',
            fontRow.selected === 0 ? '' : families[fontRow.selected - 1]);
    });
    panelGroup.add(fontRow);
    page.add(panelGroup);

    const rowGroup = index => {
        const group = new Adw.PreferencesGroup({
            title: index === 0 ? _('Row 1') : _('Row 2'),
            description: _('Drag chips to reorder, press × to remove.'),
        });
        group.add(buildChipsEditor(settings, `row${index + 1}-content`));
        const dimRow = new Adw.SwitchRow({
            title: _('Dim this row'),
            subtitle: _('Render slightly transparent'),
        });
        settings.bind(`row${index + 1}-dim`, dimRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(dimRow);
        return group;
    };

    const row1 = rowGroup(0);
    const row2 = rowGroup(1);
    page.add(row1);
    page.add(row2);

    const syncRow2 = () => {
        row2.visible = settings.get_int('panel-rows') === 2;
    };
    settings.connect('changed::panel-rows', syncRow2);
    syncRow2();

    return page;
}

// --------------------------------------------------------------- Profiles --

function buildProfilesPage(settings, window) {
    const page = new Adw.PreferencesPage({
        title: _('Profiles'),
        icon_name: 'view-list-symbolic',
    });
    const behaviour = new Adw.PreferencesGroup({title: _('Automation')});
    const autoApplyRow = new Adw.SwitchRow({
        title: _('Re-apply last profile automatically'),
        subtitle: _('Some systems reset CPU power limits after a reboot, on resume, ' +
            'or when the charger is plugged in. Keep this on to restore your last ' +
            'selected profile.'),
    });
    settings.bind('auto-apply-profile', autoApplyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    behaviour.add(autoApplyRow);

    const group = new Adw.PreferencesGroup({
        title: _('Power Profiles'),
        description: _('Limits are in watts; they are applied via RyzenAdj as ' +
            'sustained (STAPM), fast and slow package power limits plus the ' +
            'temperature limit. Deleting every profile restores the defaults.'),
    });
    const addBtn = new Gtk.Button({
        icon_name: 'list-add-symbolic',
        css_classes: ['flat'],
        valign: Gtk.Align.CENTER,
        tooltip_text: _('Add profile'),
    });
    group.set_header_suffix(addBtn);
    page.add(group);
    page.add(behaviour); // below the profile list

    let profiles = deserializeProfiles(settings.get_string('profiles'));
    let rows = [];
    const handleIcon = dragHandleIconName();

    const save = () => settings.set_string('profiles', serializeProfiles(profiles));
    const summarize = p => `${p.stapm} / ${p.fast} / ${p.slow} W · ${p.tctl} °C`;

    const makeSpinRow = (profile, row, key, title, range) => {
        const spin = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({
                lower: range.min,
                upper: range.max,
                step_increment: 1,
                value: profile[key],
            }),
        });
        spin.connect('notify::value', () => {
            profile[key] = spin.value;
            row.subtitle = summarize(profile);
            save();
        });
        return spin;
    };

    const makeRow = profile => {
        const row = new Adw.ExpanderRow({
            title: GLib.markup_escape_text(profile.name, -1),
            subtitle: summarize(profile),
        });

        // Drag to reorder. The source lives on the handle only, so expanding
        // and editing the row are unaffected; the drop target is the whole
        // row, and the array order it produces is what the menu renders.
        const handle = new Gtk.Image({
            icon_name: handleIcon,
            css_classes: ['dim-label'],
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Drag to reorder'),
        });
        const drag = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
        drag.connect('prepare', () => Gdk.ContentProvider.new_for_value(profile.id));
        drag.connect('drag-begin', (_source, drop) => {
            Gtk.DragIcon.get_for_drag(drop).set_child(
                new Gtk.Picture({paintable: new Gtk.WidgetPaintable({widget: row})}));
        });
        handle.add_controller(drag);
        row.add_prefix(handle);

        // Rows stack vertically: the half of the row the pointer is over
        // decides which side of it the dragged profile lands on, and the
        // highlight marks that same edge so the hint cannot contradict the drop.
        const placementFor = y => y < row.get_height() / 2 ? 'before' : 'after';
        const showDropHint = y => {
            const placement = placementFor(y);
            row.remove_css_class(`ryzenadj-drop-${placement === 'before' ? 'after' : 'before'}`);
            row.add_css_class(`ryzenadj-drop-${placement}`);
        };
        const clearDropHint = () => {
            row.remove_css_class('ryzenadj-drop-before');
            row.remove_css_class('ryzenadj-drop-after');
        };

        const drop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
        drop.connect('enter', (_target, _x, y) => {
            showDropHint(y);
            return Gdk.DragAction.MOVE;
        });
        drop.connect('motion', (_target, _x, y) => {
            showDropHint(y);
            return Gdk.DragAction.MOVE;
        });
        drop.connect('leave', clearDropHint);
        drop.connect('drop', (_target, draggedId, _x, y) => {
            clearDropHint();
            if (typeof draggedId !== 'string' || draggedId === profile.id)
                return false;
            profiles = moveItem(profiles, draggedId, profile.id, placementFor(y));
            save();
            rebuild();
            return true;
        });
        row.add_controller(drop);

        const nameRow = new Adw.EntryRow({title: _('Name'), text: profile.name});
        nameRow.connect('notify::text', () => {
            if (nameRow.text.trim() === '')
                return;
            profile.name = nameRow.text;
            row.title = GLib.markup_escape_text(profile.name, -1);
            save();
        });
        row.add_row(nameRow);

        row.add_row(makeSpinRow(profile, row, 'stapm', _('Sustained limit (STAPM, W)'), WATT_RANGE));
        row.add_row(makeSpinRow(profile, row, 'fast', _('Fast boost limit (W)'), WATT_RANGE));
        row.add_row(makeSpinRow(profile, row, 'slow', _('Slow boost limit (W)'), WATT_RANGE));
        row.add_row(makeSpinRow(profile, row, 'tctl', _('Temperature limit (°C)'), TCTL_RANGE));

        const deleteRow = new Adw.ActionRow({title: _('Delete this profile')});
        const deleteBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            css_classes: ['flat', 'destructive-action'],
            valign: Gtk.Align.CENTER,
        });
        deleteBtn.connect('clicked', () => {
            profiles = profiles.filter(p => p !== profile);
            save();
            rebuild();
            window.add_toast(new Adw.Toast({title: _('Profile deleted')}));
        });
        deleteRow.add_suffix(deleteBtn);
        deleteRow.set_activatable_widget(deleteBtn);
        row.add_row(deleteRow);
        return row;
    };

    const rebuild = () => {
        for (const r of rows)
            group.remove(r);
        rows = profiles.map(makeRow);
        for (const r of rows)
            group.add(r);
    };

    addBtn.connect('clicked', () => {
        const name = _('New Profile');
        profiles.push({
            id: makeUniqueId(name, profiles.map(p => p.id)),
            name,
            stapm: 15,
            fast: 20,
            slow: 17,
            tctl: 90,
        });
        save();
        rebuild();
    });

    rebuild();
    return page;
}

export default class RyzenAdjPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        installPrefsCss();
        // Anchored on the window: a bare local is only kept alive by bind(),
        // and a settings object whose sole remaining references are its own
        // `changed::` handlers forms a cycle GJS may collect — after which
        // those handlers silently stop firing.
        window._settings = this.getSettings();
        window.set_default_size(620, 720);
        window.add(buildGeneralPage(window._settings, window));
        window.add(buildAppearancePage(window._settings));
        window.add(buildProfilesPage(window._settings, window));
    }
}
