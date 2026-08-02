import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {RyzenAdjService} from './ryzenadj.js';
import {RyzenAdjIndicator} from './indicator.js';

export default class RyzenAdjExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._service = new RyzenAdjService(this._settings);
        this._indicator = new RyzenAdjIndicator(this, this._settings, this._service);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._service.start();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._service?.destroy();
        this._service = null;
        this._settings = null;
    }
}
