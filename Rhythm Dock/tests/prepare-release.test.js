'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const yaml=require('js-yaml');
const workflow=yaml.load(fs.readFileSync(path.join(__dirname,'../../.github/workflows/release.yml'),'utf8'));
assert.ok(workflow.jobs.release.needs.includes('prepare-release'));
assert.ok(workflow.jobs.release.steps.at(-1).run.includes('--verify-tag'));
assert.ok(!workflow.jobs.release.steps.at(-1).run.includes('--target'));
const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'/bin/bash';
if(!fs.existsSync(bash))throw new Error('Bash is needed to validate release orchestration.');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'rhythm-tag-test-'));
try{
    const bin=path.join(scratch,'bin');fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin,'gh'),`#!/usr/bin/env bash
echo "$*" >> "$MOCK_CALLS"
case "$*" in
  *matching-refs*) if [ "$MOCK_MODE" = denied ]; then exit 1; fi; if [ "$MOCK_MODE" = existing ] || [ "$MOCK_MODE" = different ]; then echo existing-sha; fi ;;
  *heads/master*) if [ "$MOCK_MODE" = stale ]; then echo newer-sha; else echo source-sha; fi ;;
  *'--method POST'*) exit 0 ;;
esac
`,{mode:0o755});
    fs.writeFileSync(path.join(bin,'git'),`#!/usr/bin/env bash
if [ "$1" = rev-list ]; then
  if [ "$MOCK_MODE" = different ]; then echo different-sha; else echo source-sha; fi
fi
`,{mode:0o755});
    const script=path.join(__dirname,'../scripts/prepare-release.sh').replace(/\\/g,'/');
    for(const [mode,publish,post,success] of [
        ['new',true,true,true],['existing',true,false,true],['different',false,false,true],
        ['stale',false,false,true],['denied',false,false,false],
    ]){
        const output=path.join(scratch,`${mode}.output`),summary=path.join(scratch,`${mode}.summary`),calls=path.join(scratch,`${mode}.calls`);
        const result=spawnSync(bash,['-c','unset MSYS_NO_PATHCONV MSYS2_ARG_CONV_EXCL; if command -v cygpath >/dev/null; then MOCK_BIN=$(cygpath -u "$MOCK_BIN"); fi; export PATH="$MOCK_BIN:$PATH"; bash "$MOCK_SCRIPT"'],{encoding:'utf8',env:{...process.env,
            MOCK_BIN:bin.replace(/\\/g,'/'),MOCK_SCRIPT:script,MOCK_CALLS:calls.replace(/\\/g,'/'),MOCK_MODE:mode,
            GITHUB_REF:'refs/heads/master',GITHUB_SHA:'source-sha',GITHUB_REPOSITORY:'fixture/repo',
            GITHUB_OUTPUT:output.replace(/\\/g,'/'),GITHUB_STEP_SUMMARY:summary.replace(/\\/g,'/'),MSYS_NO_PATHCONV:''}});
        assert.equal(result.status===0,success,`${mode}: ${result.stderr}`);
        const outputs=fs.readFileSync(output,'utf8').trim().split('\n');
        assert.equal(outputs.at(-1),`publish=${publish}`,mode);
        assert.equal(fs.readFileSync(calls,'utf8').includes('--method POST'),post,mode);
    }
    console.log('PASS: early tag creation, exact-commit reuse, immutable tags, stale runs and permission failures');
}finally{fs.rmSync(scratch,{recursive:true,force:true});}
