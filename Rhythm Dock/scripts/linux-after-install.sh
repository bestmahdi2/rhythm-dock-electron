#!/bin/bash
set -e
app='/opt/${sanitizedProductName}'
if command -v update-alternatives >/dev/null 2>&1; then
    if [ -L '/usr/bin/${executable}' ] && [ "$(readlink '/usr/bin/${executable}')" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' "$app/${executable}" 100
else
    ln -sf "$app/${executable}" '/usr/bin/${executable}'
fi
chmod 4755 "$app/chrome-sandbox" || true
icons="$app/resources/build/icons"
install -Dm644 "$icons/rhythmdock-mimetypes.xml" /usr/share/mime/packages/rhythmdock-formats.xml
for size in 16 24 32 48 64 128 256; do
    directory="/usr/share/icons/hicolor/$size"x"$size/mimetypes"
    install -d "$directory"
    for icon in "$icons/mimetypes/$size"x"$size"/*.png; do
        install -m644 "$icon" "$directory/"
    done
done
if command -v update-mime-database >/dev/null 2>&1; then update-mime-database /usr/share/mime || true; fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database /usr/share/applications || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -f -t /usr/share/icons/hicolor || true; fi
