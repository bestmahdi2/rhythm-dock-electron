'use strict';

/**
 * Room registry.
 *
 * A room is a host plus any number of members. All shared state (playback, library,
 * lyrics, settings) is held here in memory and mirrored to members as it changes.
 *
 * Optional snapshots preserve identity, queue and settings with paused playback.
 * Guest uploads remain temporary, separately from this room registry.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const protocol = require('./protocol');

const {ROLES} = protocol;

// Ambiguous characters are excluded: a code read aloud or copied from a phone screen
// should not turn 0 into O or 1 into I.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

// How long a room survives without its host, so a laptop that sleeps or changes
// network does not destroy the room and evict everyone.
const HOST_GRACE_MS = 2 * 60 * 1000;
// A room with no members at all is reaped after this.
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

function randomCode() {
    let code = '';
    const bytes = crypto.randomBytes(CODE_LENGTH);
    for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return code;
}

/** Constant-time comparison, so a password cannot be guessed by timing the response. */
function safeEqual(a, b) {
    const bufferA = Buffer.from(String(a || ''));
    const bufferB = Buffer.from(String(b || ''));
    if (bufferA.length !== bufferB.length) return false;
    return crypto.timingSafeEqual(bufferA, bufferB);
}

function hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

class Room {
    constructor(code, options = {}) {
        this.code = code;
        this.name = options.name || 'Rhythm Dock';
        this.createdAt = Date.now();
        this.lastActivityAt = this.createdAt;
        this.retentionMs = 0;

        // Password is stored salted+hashed even though rooms are ephemeral: a heap dump
        // or a log line should never contain it in the clear.
        this.salt = crypto.randomBytes(16).toString('hex');
        this.passwordHash = options.password ? hashPassword(options.password, this.salt) : null;

        /**
         * Token the host must present to reclaim the room after a reconnect. Without
         * this, anyone who knew the code could take over a running room.
         */
        this.hostToken = crypto.randomBytes(24).toString('hex');

        /** @type {Map<string, object>} memberId -> member */
        this.members = new Map();
        this.hostId = null;
        this.hostLostAt = null;
        this.emptySince = Date.now();

        this.state = protocol.makeState();
        this.settings = protocol.makeSettings();
        this.library = {tracks: [], queue: [], updatedAt: 0};
        this.lyrics = {trackId: null, lines: [], isSynced: false, translation: null};

        /**
         * Whether newly joining members get CONTROLLER or LISTENER by default.
         * "Everyone can control" is the friendly default for a room of friends; a host
         * can flip this to make it a listen-only broadcast.
         */
        this.defaultRole = options.defaultRole === ROLES.LISTENER ? ROLES.LISTENER : ROLES.CONTROLLER;
    }

    get isEmpty() {
        return this.members.size === 0;
    }

    get host() {
        return this.hostId ? this.members.get(this.hostId) : null;
    }

    get hostOnline() {
        const host = this.host;
        return Boolean(host && host.socket && host.socket.readyState === 1);
    }

    checkPassword(password) {
        if (!this.passwordHash) return true;
        if (!password) return false;
        return safeEqual(hashPassword(password, this.salt), this.passwordHash);
    }

    /**
     * Adds a member.
     *
     * The host slot is special: it is claimed by presenting `hostToken`. If the host
     * slot is already held by a live connection, a second host claim is rejected rather
     * than silently stealing the room.
     */
    addMember({socket, name, role, hostToken}) {
        const memberId = crypto.randomBytes(12).toString('hex');

        let resolvedRole = role;
        if (role === ROLES.HOST) {
            const valid = this.hostTokenHash ? safeEqual(crypto.createHash('sha256').update(String(hostToken||'')).digest('hex'),this.hostTokenHash) : safeEqual(hostToken,this.hostToken);
            if (!valid) {
                return {error: 'invalid host token'};
            }
            if (this.hostOnline) {
                return {error: 'this room already has an active host'};
            }
            this.hostId = memberId;
            this.hostLostAt = null;
        } else {
            // A client cannot promote itself; anything other than an authenticated host
            // claim falls back to the room's default role.
            resolvedRole = this.defaultRole;
        }

        const member = {
            id: memberId,
            uploadToken: crypto.randomBytes(24).toString('hex'),
            name: String(name || 'Guest').slice(0, 40),
            role: resolvedRole,
            socket,
            joinedAt: Date.now(),
            clockOffsetMs: 0,
            lastSeen: Date.now(),
        };

        this.members.set(memberId, member);
        this.lastActivityAt=Date.now();
        this.emptySince = null;
        return {member};
    }

    removeMember(memberId) {
        const member = this.members.get(memberId);
        if (!member) return null;

        this.members.delete(memberId);
        this.lastActivityAt=Date.now();

        if (memberId === this.hostId) {
            // Keep hostId set during the grace window so a reconnecting host can be
            // recognised, and so members know the host is merely absent, not gone.
            this.hostLostAt = Date.now();
            // Playback cannot continue without the host's audio.
            this.state = {...this.state, playing: false, atServerTime: Date.now()};
        }

        if (this.isEmpty) this.emptySince = Date.now();
        return member;
    }

    setRole(memberId, role) {
        const member = this.members.get(memberId);
        if (!member) return false;
        // The host role is not transferable this way; it is tied to the host token.
        if (member.id === this.hostId) return false;
        if (role !== ROLES.CONTROLLER && role !== ROLES.LISTENER) return false;
        member.role = role;
        return true;
    }

    /** Public member list, safe to broadcast (no sockets, no tokens). */
    memberList() {
        return [...this.members.values()].map((member) => ({
            id: member.id,
            name: member.name,
            role: member.role,
            isHost: member.id === this.hostId,
            joinedAt: member.joinedAt,
        }));
    }

    /** True once the room should be torn down. */
    isExpired(now = Date.now()) {
        if(this.retentionMs)return !this.hostOnline && now-this.lastActivityAt>this.retentionMs;
        if (this.emptySince && now - this.emptySince > EMPTY_ROOM_TTL_MS) return true;
        if (this.hostLostAt && !this.hostOnline && now - this.hostLostAt > HOST_GRACE_MS) return true;
        return false;
    }

    summary() {
        return {
            code: this.code,
            name: this.name,
            hasPassword: Boolean(this.passwordHash),
            memberCount: this.members.size,
            hostOnline: this.hostOnline,
            defaultRole: this.defaultRole,
        };
    }
}

class RoomRegistry {
    constructor({stateFile='',retentionMs=7*86400000}={}) {
        /** @type {Map<string, Room>} */
        this.rooms = new Map();
        this.stateFile=stateFile;this.retentionMs=retentionMs;this.saveTimer=null;
        if(stateFile){if(!path.isAbsolute(stateFile))throw new Error('ROOM_STATE_FILE must be an absolute path.');this.restore();}
        this.sweeper = setInterval(() => this.sweep(), 30 * 1000);
        // Do not hold the process open just for the sweeper.
        if (this.sweeper.unref) this.sweeper.unref();
    }

    create(options = {}) {
        let code = randomCode();
        // Vanishingly unlikely, but a collision would hand two hosts the same room.
        while (this.rooms.has(code)) code = randomCode();

        const room = new Room(code, options);
        if(this.stateFile)room.retentionMs=this.retentionMs;
        this.rooms.set(code, room);
        this.flush();
        return room;
    }

    get(code) {
        return this.rooms.get(String(code || '').toUpperCase()) || null;
    }

    destroy(code) {
        const room = this.rooms.get(code);
        if (!room) return false;
        for (const member of room.members.values()) {
            try {
                member.socket.close(4000, 'room closed');
            } catch (_) { /* already gone */ }
        }
        this.rooms.delete(code);
        this.flush();
        return true;
    }

    changed(room) {if(this.closed)return;room.lastActivityAt=Date.now();if(!this.stateFile||this.saveTimer)return;
        this.saveTimer=setTimeout(()=>{this.saveTimer=null;
            try{this.flush();this.storageError=false;}catch(_){this.storageError=true;console.error('[rooms] Could not save room state. Check the state path and available disk space.');}
        },500);this.saveTimer.unref();}

    snapshot(room) {
        const pick=(object,keys)=>Object.fromEntries(keys.filter(k=>object?.[k]!==undefined).map(k=>[k,object[k]]));
        const track=t=>typeof t==='string'?t.slice(0,64):pick(t,['id','title','artist','album','durationMs','durationSeconds']);
        return {code:room.code,name:room.name,createdAt:room.createdAt,lastActivityAt:room.lastActivityAt,
            salt:room.salt,passwordHash:room.passwordHash,hostTokenHash:room.hostTokenHash||crypto.createHash('sha256').update(room.hostToken).digest('hex'),
            defaultRole:room.defaultRole,
            state:{...pick(room.state,Object.keys(protocol.makeState())),playing:false,atServerTime:Date.now()},
            settings:pick(room.settings,[...Object.keys(protocol.makeSettings()),'colorTheme']),
            library:{tracks:room.library.tracks.slice(0,20000).map(track),queue:room.library.queue.slice(0,20000).map(track),updatedAt:room.library.updatedAt}};
    }
    flush() {
        if(!this.stateFile)return;
        clearTimeout(this.saveTimer);this.saveTimer=null;
        const data=JSON.stringify({format:'rhythm-dock-rooms',version:1,rooms:[...this.rooms.values()].map(r=>this.snapshot(r))});
        if(Buffer.byteLength(data)>20*1024*1024)throw new Error('Room state exceeds the 20 MB storage limit.');
        fs.mkdirSync(path.dirname(this.stateFile),{recursive:true});const temp=this.stateFile+'.tmp';
        fs.writeFileSync(temp,data,{mode:0o600});fs.renameSync(temp,this.stateFile);
    }
    restore() {
        if(!fs.existsSync(this.stateFile))return;
        if(fs.statSync(this.stateFile).size>20*1024*1024)throw new Error('Room state exceeds the storage limit.');
        const data=JSON.parse(fs.readFileSync(this.stateFile,'utf8'));
        if(data.format!=='rhythm-dock-rooms'||data.version!==1||!Array.isArray(data.rooms)||data.rooms.length>1000)
            throw new Error('Invalid room state file; it has been preserved.');
        for(const r of data.rooms){
            if(!/^[A-Z2-9]{6}$/.test(r.code)||!Number.isFinite(r.lastActivityAt)||!/^[a-f0-9]{64}$/.test(r.hostTokenHash)||
                !/^[a-f0-9]{32}$/.test(r.salt)||(r.passwordHash&&!/^[a-f0-9]{64}$/.test(r.passwordHash))||this.rooms.has(r.code))
                throw new Error('Invalid room record; the state file has been preserved.');
            if(Date.now()-r.lastActivityAt>this.retentionMs)continue;
            const room=new Room(r.code,{name:String(r.name||'Rhythm Dock').slice(0,80),defaultRole:r.defaultRole});
            Object.assign(room,{createdAt:r.createdAt,lastActivityAt:r.lastActivityAt,salt:r.salt,passwordHash:r.passwordHash,
                hostToken:null,hostTokenHash:r.hostTokenHash,retentionMs:this.retentionMs,hostLostAt:Date.now()});
            room.state={...protocol.makeState(),...r.state,playing:false,atServerTime:Date.now()};
            room.settings={...protocol.makeSettings(),...r.settings};
            if(r.library&&Array.isArray(r.library.tracks)&&Array.isArray(r.library.queue))room.library=r.library;
            this.rooms.set(room.code,room);
        }
    }
    close(){if(this.closed)return;this.closed=true;clearInterval(this.sweeper);clearTimeout(this.saveTimer);this.flush();}

    sweep() {
        const now = Date.now();
        for (const [code, room] of this.rooms) {
            if (room.isExpired(now)) {
                console.log(`[rooms] Reaping expired room ${code}`);
                this.destroy(code);
            }
        }
    }

    stats() {
        return {
            rooms: this.rooms.size,
            members: [...this.rooms.values()].reduce((n, r) => n + r.members.size, 0),
            persistenceEnabled:Boolean(this.stateFile),
            storageHealthy:!this.storageError,
        };
    }
}

module.exports = {Room, RoomRegistry, randomCode, HOST_GRACE_MS, EMPTY_ROOM_TTL_MS};
