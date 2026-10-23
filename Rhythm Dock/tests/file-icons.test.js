'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const sharp=require('sharp');
const {FILE_TYPES,fileTypeSvg,fileTypeIco}=require('../scripts/generate-icons');
const {EXTRA_FORMATS}=require('../src/main/services/media-tools');
const pkg=require('../package.json');

(async()=>{
    const extensions=FILE_TYPES.map(type=>type.ext);
    assert.equal(new Set(extensions).size,extensions.length);
    assert.equal(new Set(FILE_TYPES.map(type=>type.from)).size,extensions.length,'every format must have its own color');
    assert.equal(new Set(FILE_TYPES.map(type=>fileTypeSvg(type))).size,extensions.length);
    assert.deepEqual(pkg.build.fileAssociations.map(item=>item.ext).sort(),[...extensions].sort());
    for(const ext of EXTRA_FORMATS)assert.ok(extensions.includes(ext.slice(1)));
    for(const type of FILE_TYPES){
        const association=pkg.build.fileAssociations.find(item=>item.ext===type.ext);
        assert.equal(association.icon,`build/icons/filetypes/${type.ext}`);
        assert.equal(association.mimeType,type.mime);
        assert.ok(fileTypeSvg(type,32).includes(`>${type.label}</text>`),'small icons need a file-type label');
        const ico=await fileTypeIco(type);
        assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),7);
        for(let index=0;index<7;index++){
            const at=6+index*16,size=ico[at]||256,length=ico.readUInt32LE(at+8),offset=ico.readUInt32LE(at+12);
            const metadata=await sharp(ico.subarray(offset,offset+length)).metadata();
            assert.equal(metadata.width,size);assert.equal(metadata.height,size);assert.equal(metadata.hasAlpha,true);
        }
    }
    const {validateConfig}=require('app-builder-lib/out/util/config');
    await validateConfig(pkg.build,new (require('builder-util').DebugLogger)());
    for(const script of ['linux-after-install.sh','linux-after-remove.sh']){
        const source=fs.readFileSync(path.join(__dirname,'../scripts',script),'utf8');
        assert.ok(source.includes('rhythmdock-formats.xml'));
        const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'/bin/bash';
        if(fs.existsSync(bash)){
            const result=require('node:child_process').spawnSync(bash,['-n'],{input:source,encoding:'utf8'});
            assert.equal(result.status,0,result.stderr);
        }
    }
    console.log('PASS: all registered formats have distinct palettes, labels, associations, valid multi-resolution icons and valid build/install configuration');
})().catch(error=>{console.error(error);process.exitCode=1;});
