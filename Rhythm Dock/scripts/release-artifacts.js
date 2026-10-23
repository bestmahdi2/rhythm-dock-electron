'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const pkg=require('../package.json');
function verifyVersion(ref=process.env.GITHUB_REF||''){
    const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
    const server=JSON.parse(fs.readFileSync(path.join(root,'../server/package.json'),'utf8'));
    if(!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)||
        [lock.version,lock.packages[''].version,server.version].some(version=>version!==pkg.version))
        throw new Error('App, lockfile and server versions must match.');
    if(ref.startsWith('refs/tags/')&&ref!==`refs/tags/v${pkg.version}`)throw new Error('Release tag does not match package version.');
    return pkg.version;
}
function expectedFiles(platform,version=pkg.version){
    const prefix=`Rhythm Dock-${version}`;
    if(platform==='windows-x64')return [`Rhythm Dock Setup ${version}-x64.exe`,`Rhythm Dock Portable ${version}-x64.exe`];
    if(platform==='macos-x64'||platform==='macos-arm64'){
        const arch=platform.slice(6);return [`${prefix}-${arch}.dmg`,`${prefix}-${arch}.zip`];
    }
    if(platform==='linux-x64')return [
        `${prefix}-x86_64.AppImage`,`${prefix}-amd64.deb`,
        `${prefix}-x86_64.rpm`,`${prefix}-x64.tar.gz`,
    ];
    throw new Error(`Unknown release platform: ${platform}`);
}
async function collect(platform,directory=path.join(root,'dist')){
    const names=expectedFiles(platform);
    for(const name of names){
        const file=path.join(directory,name);
        if(!fs.existsSync(file)||!fs.statSync(file).isFile()||fs.statSync(file).size===0)
            throw new Error(`Missing required installer/portable package: ${name}. Found: ${fs.existsSync(directory)?fs.readdirSync(directory).join(', '):'(output directory missing)'}`);
    }
    const output=path.join(directory,'release');fs.mkdirSync(output,{recursive:true});
    const checksums=[];
    for(const name of names){
        const source=path.join(directory,name);fs.copyFileSync(source,path.join(output,name));
        const hash=crypto.createHash('sha256');
        for await(const chunk of fs.createReadStream(source))hash.update(chunk);
        checksums.push(`${hash.digest('hex')}  ${name}`);
    }
    fs.writeFileSync(path.join(output,`SHA256SUMS-${platform}.txt`),checksums.join('\n')+'\n');
    return names;
}
if(require.main===module){
    (async()=>{
        verifyVersion();
        if(process.argv[2]==='version')console.log(`version=${pkg.version}`);
        else if(process.argv[2]==='collect')console.log((await collect(process.argv[3])).join('\n'));
        else throw new Error('Use version or collect <platform>.');
    })().catch(error=>{console.error(error.message);process.exitCode=1;});
}
module.exports={verifyVersion,expectedFiles,collect};
