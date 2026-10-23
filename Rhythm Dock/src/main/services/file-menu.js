'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const run = require('node:util').promisify(require('node:child_process').execFile);
const label = 'Add to Rhythm Dock Queue';
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const xml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plist = body => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${body}</plist>`;

function artifacts({platform, home, dataHome, command, extensions, mimeTypes}) {
    const launch = command.map(quote).join(' ');
    const patterns = extensions.map(ext => `*${ext}`).join('|');
    const filter = `files=()\nwhile IFS= read -r file; do\n case "$(printf '%s' "$file" | tr '[:upper:]' '[:lower:]')" in ${patterns}) files+=("$file");; esac\ndone\n[ "\${#files[@]}" -eq 0 ] || ${launch} --enqueue "\${files[@]}"\n`;
    if (platform === 'linux') {
        const root = dataHome || path.join(home, '.local', 'share');
        const wrapper = path.join(root, 'rhythm-dock', 'enqueue-files');
        const exec = '"' + wrapper.replace(/([\\"`$])/g, '\\\\$1').replace(/%/g, '%%') + '"';
        const script = `#!/bin/bash\nif [ "$#" -gt 0 ]; then\n printf '%s\\n' "$@"\nelse\n printf '%s\\n' "\${NAUTILUS_SCRIPT_SELECTED_FILE_PATHS:-\${NEMO_SCRIPT_SELECTED_FILE_PATHS:-}}"\nfi | {\n${filter}}\n`;
        return [
            {path:wrapper, text:script},
            ...['nautilus','nemo'].map(manager => ({path:path.join(root,manager,'scripts',label),text:script})),
            {path:path.join(root,'kio','servicemenus','rhythm-dock-queue.desktop'),
                text:`[Desktop Entry]\nType=Service\nMimeType=${mimeTypes.join(';')};\nActions=enqueue;\nX-KDE-Priority=TopLevel\n\n[Desktop Action enqueue]\nName=${label}\nIcon=media-playlist-append\nExec=${exec} %F\n`},
        ];
    }
    if (platform === 'darwin') {
        const root = path.join(home,'Library','Services',`${label}.workflow`,'Contents');
        return [
            {path:path.join(root,'Info.plist'), text:plist(`<dict><key>NSServices</key><array><dict><key>NSMenuItem</key><dict><key>default</key><string>${label}</string></dict><key>NSMessage</key><string>runWorkflowAsService</string><key>NSSendFileTypes</key><array><string>public.audio</string><string>public.movie</string></array></dict></array></dict>`)},
            {path:path.join(root,'document.wflow'), text:plist(`<dict><key>AMDocumentVersion</key><string>2</string><key>actions</key><array><dict><key>action</key><dict><key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string><key>ActionName</key><string>Run Shell Script</string><key>ActionParameters</key><dict><key>COMMAND_STRING</key><string>${xml(filter)}</string><key>inputMethod</key><integer>0</integer><key>shell</key><string>/bin/bash</string></dict><key>AMAccepts</key><dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.path</string></array></dict><key>AMProvides</key><dict><key>Container</key><string>List</string><key>Types</key><array><string>com.apple.cocoa.string</string></array></dict><key>CFBundleIdentifier</key><string>com.apple.RunShellScript</string><key>UUID</key><string>E25081AF-3B8E-4B34-996E-438D71ED1028</string></dict></dict></array><key>workflowMetaData</key><dict><key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string><key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string><key>serviceProcessesInput</key><integer>0</integer><key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string></dict></dict>`)},
        ];
    }
    return [];
}

async function configure({enabled, platform=process.platform, command, extensions, ...options}) {
    if (platform === 'win32') {
        const launch = command.map(value => `"${value}"`).join(' ');
        for (const ext of extensions) {
            const key = `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\RhythmDock.Enqueue`;
            if (enabled) {
                await run('reg.exe',['add',key,'/ve','/d',label,'/f'],{windowsHide:true});
                await run('reg.exe',['add',key,'/v','MultiSelectModel','/d','Player','/f'],{windowsHide:true});
                await run('reg.exe',['add',`${key}\\command`,'/ve','/d',`${launch} --enqueue "%1"`,'/f'],{windowsHide:true});
            } else {
                try { await run('reg.exe',['query',key],{windowsHide:true}); }
                catch (error) { if(error.code===1)continue;throw error; }
                await run('reg.exe',['delete',key,'/f'],{windowsHide:true});
            }
        }
    } else {
        for (const file of artifacts({platform,command,extensions,...options})) {
            if (enabled) {
                await fs.mkdir(path.dirname(file.path),{recursive:true});
                await fs.writeFile(file.path,file.text,'utf8');
                if(platform==='linux')await fs.chmod(file.path,0o755);
            } else await fs.rm(file.path,{force:true});
        }
        if(platform==='darwin')await run('/System/Library/CoreServices/pbs',['-update'],{timeout:10000});
    }
    return {ok:true};
}
module.exports={artifacts,configure};
