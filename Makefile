UUID = ryzenadj-switcher@cvcore.github.io
EXTDIR = src
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions

.PHONY: all schemas test install uninstall pack dev clean

all: schemas

schemas: $(EXTDIR)/schemas/gschemas.compiled

$(EXTDIR)/schemas/gschemas.compiled: $(EXTDIR)/schemas/org.gnome.shell.extensions.ryzenadj.gschema.xml
	glib-compile-schemas $(EXTDIR)/schemas

test: schemas
	./tests/run.sh

install: schemas
	mkdir -p $(INSTALL_DIR)
	ln -sfn $(abspath $(EXTDIR)) $(INSTALL_DIR)/$(UUID)

uninstall:
	rm -f $(INSTALL_DIR)/$(UUID)

# Windowed dev shell (GNOME >= 49); loads the extension fresh on every run —
# no logout needed to test extension-code changes.
dev: install
	dbus-run-session -- gnome-shell --devkit

pack: schemas
	gnome-extensions pack --force \
		--extra-source=indicator.js \
		--extra-source=ryzenadj.js \
		--extra-source=lib \
		$(EXTDIR)

clean:
	rm -f $(EXTDIR)/schemas/gschemas.compiled $(UUID).shell-extension.zip
