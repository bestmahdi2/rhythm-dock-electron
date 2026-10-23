#!/bin/bash
# RPM passes 1 while replacing an installed version; Debian passes "upgrade".
# The replacement package owns the icons by then, so leave its files in place.
case "$1" in upgrade|1) exit 0 ;; esac
if command -v update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}' || true
else
    rm -f '/usr/bin/${executable}'
fi
# Only remove this application's named MIME definitions and icon files.
rm -f /usr/share/mime/packages/rhythmdock-formats.xml
for icon in /usr/share/icons/hicolor/*/mimetypes/audio-x-rhythmdock-*.png; do
    [ ! -f "$icon" ] || rm -f "$icon"
done
if command -v update-mime-database >/dev/null 2>&1; then update-mime-database /usr/share/mime || true; fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database /usr/share/applications || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -f -t /usr/share/icons/hicolor || true; fi
