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
    const builderLinux=arch=>['AppImage','deb','rpm','tar.gz'].map(ext=>{
        const options=ext==='AppImage'?pkg.build.appImage:pkg.build[ext];
        const pattern=options?.artifactName||pkg.build.linux.artifactName;
        return expandMacro(pattern,getArtifactArchName(arch,ext),info,{ext});
    });
    assert.deepEqual(expectedFiles('linux-x64'),builderLinux(Arch.x64));
    assert.deepEqual(expectedFiles('linux-arm64'),builderLinux(Arch.arm64));
    const workflow=require('js-yaml').load(fs.readFileSync(path.join(__dirname,'../../.github/workflows/release.yml'),'utf8'));
    const platforms=workflow.jobs.build.strategy.matrix.include.map(entry=>entry.name);
    const windowsArm=workflow.jobs.build.strategy.matrix.include.find(entry=>entry.name==='windows-arm64');
    assert.equal(windowsArm.os,'windows-2022','Windows ARM64 packaging must use the supported x64 Sharp host');
    assert.ok(windowsArm.args.includes('--arm64'),'host architecture must not change the output architecture');
    const nativeFpm=workflow.jobs.build.steps.find(step=>step.name==='Install native FPM for Linux ARM64');
    assert.equal(nativeFpm.if,"matrix.name == 'linux-arm64'");
    assert.ok(nativeFpm.run.includes('gem install fpm --version 1.16.0'));
    assert.ok(nativeFpm.run.includes('USE_SYSTEM_FPM=true'));
    assert.deepEqual([...platforms].sort(),['windows-x64','windows-ia32','windows-arm64','macos-x64','macos-arm64','linux-x64','linux-arm64'].sort());
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'rhythm-release-'));
    try{
        for(const platform of platforms){
            const dir=path.join(root,platform);fs.mkdirSync(dir);
            await assert.rejects(collect(platform,dir),/Missing required/);
            const files=platform.startsWith('linux-')?builderLinux(platform==='linux-x64'?Arch.x64:Arch.arm64):expectedFiles(platform);
            for(const name of files)fs.writeFileSync(path.join(dir,name),`fixture:${name}`);
            assert.deepEqual(await collect(platform,dir),files);
            const sums=fs.readFileSync(path.join(dir,'release',`SHA256SUMS-${platform}.txt`),'utf8').trim().split('\n');
            assert.equal(sums.length,files.length);assert.ok(sums.every(line=>/^[a-f0-9]{64}  /.test(line)));
        }
    }finally{fs.rmSync(root,{recursive:true,force:true});}
    console.log('PASS: version/tag agreement, required installer and portable outputs, checksums and release staging');
})().catch(error=>{console.error(error);process.exitCode=1;});
