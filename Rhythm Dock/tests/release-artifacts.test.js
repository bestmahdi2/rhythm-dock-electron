'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {verifyVersion,expectedFiles,collect}=require('../scripts/release-artifacts');
(async()=>{
    const version=verifyVersion('');assert.equal(verifyVersion(`refs/tags/v${version}`),version);
    assert.throws(()=>verifyVersion('refs/tags/v0.0.0'),/tag/);
    // Verify actual builder naming, rather than deriving every fixture from the checker.
    const {Arch,getArtifactArchName}=require('builder-util/out/arch');
    const {expandMacro}=require('app-builder-lib/out/util/macroExpander');
    const pkg=require('../package.json');
    const info={version,productName:pkg.build.productName,sanitizedProductName:pkg.build.productName};
    const builderLinux=['AppImage','deb','rpm','tar.gz'].map(ext=>{
        const options=ext==='AppImage'?pkg.build.appImage:pkg.build[ext];
        const pattern=options?.artifactName||pkg.build.linux.artifactName;
        return expandMacro(pattern,getArtifactArchName(Arch.x64,ext),info,{ext});
    });
    assert.deepEqual(expectedFiles('linux-x64'),builderLinux);
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'rhythm-release-'));
    try{
        for(const platform of ['windows-x64','macos-x64','macos-arm64','linux-x64']){
            const dir=path.join(root,platform);fs.mkdirSync(dir);
            await assert.rejects(collect(platform,dir),/Missing required/);
            const files=platform==='linux-x64'?builderLinux:expectedFiles(platform);
            for(const name of files)fs.writeFileSync(path.join(dir,name),`fixture:${name}`);
            assert.deepEqual(await collect(platform,dir),files);
            const sums=fs.readFileSync(path.join(dir,'release',`SHA256SUMS-${platform}.txt`),'utf8').trim().split('\n');
            assert.equal(sums.length,files.length);assert.ok(sums.every(line=>/^[a-f0-9]{64}  /.test(line)));
        }
    }finally{fs.rmSync(root,{recursive:true,force:true});}
    console.log('PASS: version/tag agreement, required installer and portable outputs, checksums and release staging');
})().catch(error=>{console.error(error);process.exitCode=1;});
