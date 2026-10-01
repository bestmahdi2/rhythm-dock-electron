'use strict';
const crypto = require('node:crypto');
const database = require('./database');
const USER_AGENT = 'RhythmDock/1.6.0 (https://github.com/bestmahdi2/rhythm-dock-electron)';
async function jsonRequest(url, options={}, fetchImpl=fetch) {
    const response = await fetchImpl(url, {...options, signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error(`The service returned ${response.status}. Check your connection and account settings.`);
    const bytes=[]; let size=0;
    for await (const chunk of response.body) {
        size += chunk.length; if (size>2*1024*1024) throw new Error('The service response is too large.'); bytes.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(bytes).toString('utf8'));
}
function signature(params, secret) {
    const text = Object.keys(params).filter(k => !['format','callback','api_sig'].includes(k)).sort()
        .map(k => k + params[k]).join('') + secret;
    return crypto.createHash('md5').update(text,'utf8').digest('hex');
}
async function lastfm(method, params, config, fetchImpl=fetch) {
    if (!config.apiKey || !config.apiSecret) throw new Error('Enter your Last.fm API key and secret first.');
    const fields={method,api_key:config.apiKey,...params};
    const body=new URLSearchParams({...fields,api_sig:signature(fields,config.apiSecret),format:'json'});
    const data=await jsonRequest('https://ws.audioscrobbler.com/2.0/',{method:'POST',body},fetchImpl);
    if (data.error) throw new Error(`Last.fm rejected the request (${data.error}). Reconnect your account.`);
    return data;
}
let nextMusicBrainz = 0;
async function musicBrainz({title='',artist='',album=''},fetchImpl=fetch) {
    const wait=Math.max(0,nextMusicBrainz-Date.now()); nextMusicBrainz=Math.max(nextMusicBrainz,Date.now())+1100;
    if (wait>10000) throw new Error('Too many lookups. Please wait a moment.');
    if(wait) await new Promise(resolve => setTimeout(resolve,wait));
    const quote=v => '"'+String(v).slice(0,200).replace(/["\\]/g,'\\$&')+'"';
    const query=[title && 'recording:'+quote(title),artist && 'artist:'+quote(artist),album && 'release:'+quote(album)].filter(Boolean).join(' AND ');
    if(!query) throw new Error('Enter a title, artist or album to look up.');
    const url=new URL('https://musicbrainz.org/ws/2/recording/');
    url.search=new URLSearchParams({query,fmt:'json',limit:'20'}).toString();
    const data=await jsonRequest(url,{headers:{'User-Agent':USER_AGENT}},fetchImpl);
    return (data.recordings || []).map(r => ({id:r.id,title:r.title,artist:(r['artist-credit']||[])
        .map(a => (a.name || a.artist?.name || '') + (a.joinphrase || '')).join(''),
        album:r.releases?.[0]?.title || '', releaseId:r.releases?.[0]?.id || '', year:r['first-release-date']?.slice(0,4) || '', score:r.score}));
}
async function similarArtists(artist,apiKey,fetchImpl=fetch) {
    if(!artist || !apiKey) throw new Error('Set a Last.fm API key and choose an artist.');
    const url=new URL('https://ws.audioscrobbler.com/2.0/'); url.search=new URLSearchParams({method:'artist.getSimilar',artist,
        api_key:apiKey,format:'json',limit:'20'}).toString();
    const data=await jsonRequest(url,{},fetchImpl);
    if(data.error) throw new Error('Could not find similar artists. Check the API key.');
    return (data.similarartists?.artist || []).map(a => ({artist:a.name,match:Number(a.match)||0}));
}
async function acoustID({filePath,executable='fpcalc',client},fetchImpl=fetch) {
    if(!client)throw new Error('Set your AcoustID application key in Accounts.');
    let result;
    try {result=await require('./media-tools').run(executable,['-json',filePath],{timeoutMs:30000});}
    catch(_){throw new Error('Choose a working Chromaprint fpcalc executable in Accounts.');}
    const fingerprint=JSON.parse(result.stdout);
    if(!fingerprint.fingerprint || !Number.isFinite(fingerprint.duration))throw new Error('No audio fingerprint was returned.');
    const body=new URLSearchParams({client,duration:String(Math.round(fingerprint.duration)),fingerprint:fingerprint.fingerprint,
        meta:'recordings releases releasegroups',format:'json'});
    const data=await jsonRequest('https://api.acoustid.org/v2/lookup',{method:'POST',body},fetchImpl);
    if(data.status!=='ok')throw new Error('AcoustID rejected the lookup. Check the application key.');
    return (data.results||[]).flatMap(r=>(r.recordings||[]).map(t=>({id:t.id,title:t.title,
        artist:(t.artists||[]).map(a=>a.name).join('; '),album:t.releases?.[0]?.title||'',releaseId:t.releases?.[0]?.id||'',score:r.score})));
}
async function coverArt(releaseId,fetchImpl=fetch) {
    if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(releaseId||''))throw new Error('Choose a MusicBrainz release match.');
    const response=await fetchImpl(`https://coverartarchive.org/release/${releaseId}/front-250`,{signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error('This release has no available front cover.');
    const mime=response.headers.get('content-type')?.split(';')[0];if(!['image/jpeg','image/png'].includes(mime))throw new Error('Unsupported cover image.');
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>5*1024*1024)throw new Error('Cover exceeds 5 MB.');chunks.push(Buffer.from(chunk));}
    return {data:Buffer.concat(chunks).toString('base64'),mimeType:mime};
}
class Scrobbler {
    constructor({getConfig,fetchImpl=fetch}) { this.getConfig=getConfig; this.fetch=fetchImpl; this.running=false; }
    hasEnabled(){const c=this.getConfig();return Boolean(c.listenbrainz?.enabled||c.lastfm?.enabled);}
    enqueue({artist,title,album,duration,listenedMs,startedAt}) {
        if(!artist || !title || !Number.isFinite(duration) || !Number.isFinite(listenedMs) ||
            duration<30 || listenedMs < Math.min(duration*500,240000)) return false;
        const config=this.getConfig();
        const payload={artist:String(artist).slice(0,300),title:String(title).slice(0,300),album:String(album||'').slice(0,300),
            duration:Math.round(duration),timestamp:Math.floor((Number.isFinite(startedAt)&&startedAt>0?startedAt:Date.now()-listenedMs)/1000)};
        for(const provider of ['listenbrainz','lastfm']) {
            if(!config[provider]?.enabled) continue;
            database.handle().prepare('INSERT INTO delivery_jobs(provider,payload,createdAt) VALUES(?,?,?)')
                .run(provider,JSON.stringify(payload),new Date().toISOString());
        }
        database.handle().prepare('DELETE FROM delivery_jobs WHERE id NOT IN (SELECT id FROM delivery_jobs ORDER BY id DESC LIMIT 1000)').run();
        return true;
    }
    status() { return database.handle().prepare('SELECT provider,COUNT(*) AS pending,MAX(attempts) AS attempts FROM delivery_jobs GROUP BY provider').all(); }
    async flush() {
        if(this.running) return {busy:true}; this.running=true; let sent=0,failed=0;
        try {
            const config=this.getConfig();
            database.handle().prepare('DELETE FROM delivery_jobs WHERE createdAt<?').run(new Date(Date.now()-30*86400000).toISOString());
            const jobs=database.handle().prepare('SELECT * FROM delivery_jobs WHERE nextAttempt<=? ORDER BY id LIMIT 20').all(Date.now());
            for(const job of jobs) {
                const c=config[job.provider]; if(!c?.enabled) continue;
                const p=JSON.parse(job.payload);
                try {
                    if(job.provider==='listenbrainz') {
                        if(!c.token) throw new Error('Connect ListenBrainz first.');
                        const data=await jsonRequest('https://api.listenbrainz.org/1/submit-listens',{method:'POST',headers:{
                            Authorization:'Token '+c.token,'Content-Type':'application/json'},body:JSON.stringify({listen_type:'single',payload:[{
                                listened_at:p.timestamp,track_metadata:{artist_name:p.artist,track_name:p.title,release_name:p.album,
                                    additional_info:{duration:p.duration,submission_client:'Rhythm Dock'}}}]})},this.fetch);
                        if(data.status!=='ok') throw new Error('ListenBrainz did not accept this listen.');
                    } else {
                        if(!c.sessionKey) throw new Error('Connect Last.fm first.');
                        const data=await lastfm('track.scrobble',{artist:p.artist,track:p.title,album:p.album,
                            timestamp:p.timestamp,duration:p.duration,sk:c.sessionKey},c,this.fetch);
                        if(Number(data.scrobbles?.['@attr']?.accepted)!==1) throw new Error('Last.fm did not accept this listen.');
                    }
                    database.handle().prepare('DELETE FROM delivery_jobs WHERE id=?').run(job.id); sent++;
                } catch (_) {
                    const attempts=job.attempts+1;
                    database.handle().prepare('UPDATE delivery_jobs SET attempts=?,nextAttempt=? WHERE id=?')
                        .run(attempts,Date.now()+Math.min(86400000,60000*2**Math.min(attempts,10)),job.id); failed++;
                }
            }
            return {sent,failed,pending:this.status()};
        } finally {this.running=false;}
    }
    clear() { database.handle().prepare('DELETE FROM delivery_jobs').run(); return true; }
}
module.exports={jsonRequest,signature,lastfm,musicBrainz,similarArtists,acoustID,coverArt,Scrobbler};
