'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const media=require('./media-tools');
const mm=require('music-metadata');
const ENCODERS={'.wav':['pcm_s24le','wav'],'.flac':['flac','flac'],'.mp3':['libmp3lame','mp3'],'.m4a':['aac','ipod'],'.ogg':['libvorbis','ogg']};
function plan(sections,duration,pitch=0) {
    if(!Number.isFinite(duration)||duration<=0)throw new Error('The song duration could not be measured.');
    if(!Array.isArray(sections)||!sections.length||sections.length>32)throw new Error('Choose between 1 and 32 sections.');
    if(!Number.isFinite(pitch)||Math.abs(pitch)>12)throw new Error('Pitch shift must be between −12 and +12 semitones.');
    const rows=sections.map(s=>{
        const start=Number(s.start),end=Number(s.end),gain=Number(s.gain||0),fadeIn=Number(s.fadeIn||0),fadeOut=Number(s.fadeOut||0);
        if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>duration+.05||
            !Number.isFinite(gain)||gain< -36||gain>12||!Number.isFinite(fadeIn)||!Number.isFinite(fadeOut)||
            fadeIn<0||fadeOut<0||fadeIn+fadeOut>end-start)throw new Error('Check section times, gain and fades. All sections must fit inside the song.');
        return {start,end,gain,fadeIn,fadeOut};
    });
    const split=`[0:a:0]asplit=${rows.length}`+rows.map((_,i)=>`[src${i}]`).join('');
    const filters=rows.map((s,i)=>{
        let f=`[src${i}]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo`;
        if(pitch){const factor=2**(pitch/12);f+=`,asetrate=${48000*factor},aresample=48000,atempo=${1/factor}`;}
        f+=`,volume=${s.gain}dB`;
        if(s.fadeIn)f+=`,afade=t=in:st=0:d=${s.fadeIn}`;
        if(s.fadeOut)f+=`,afade=t=out:st=${s.end-s.start-s.fadeOut}:d=${s.fadeOut}`;
        return f+`[cut${i}]`;
    });
    const filter=[split,...filters,rows.map((_,i)=>`[cut${i}]`).join('')+`concat=n=${rows.length}:v=0:a=1[out]`].join(';');
    return {filter,duration:rows.reduce((sum,s)=>sum+s.end-s.start,0),sections:rows};
}
async function exportTimeline({filePath,targetPath,sections,pitch=0},options={}) {
    if(!path.isAbsolute(filePath)||!fs.statSync(filePath).isFile())throw new Error('Choose a local audio file.');
    const encoding=ENCODERS[path.extname(targetPath).toLowerCase()];
    if(!path.isAbsolute(targetPath)||!encoding||fs.existsSync(targetPath))throw new Error('Choose a new WAV, FLAC, MP3, M4A or OGG filename.');
    const meta=await mm.parseFile(filePath,{duration:true,skipCovers:true});
    const edit=plan(sections,meta.format.duration,pitch),temporary=path.join(path.dirname(targetPath),`.rhythm-edit-${crypto.randomUUID()}.part`);
    try {
        await media.run(options.executable,['-hide_banner','-nostdin','-v','info','-progress','pipe:1','-i',filePath,
            '-filter_complex',edit.filter,'-map','[out]','-map_metadata','0','-map_chapters','-1','-c:a',encoding[0],'-f',encoding[1],temporary],
            {...options,outputPath:temporary});
        if(!fs.statSync(temporary).size)throw new Error('The editor produced an empty file.');
        fs.copyFileSync(temporary,targetPath,fs.constants.COPYFILE_EXCL);return {filePath:targetPath,duration:edit.duration};
    }finally{fs.rmSync(temporary,{force:true});}
}
module.exports={plan,exportTimeline};
