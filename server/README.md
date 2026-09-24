# Rhythm Dock — Room Server

Turn your laptop into a listening room. Your VPS is the meeting point; your laptop
streams the music; anyone in the room listens in sync from a phone, a laptop, or the
app on any OS.

---

## How it works

```
   YOUR LAPTOP (host)                YOUR VPS                    EVERYONE ELSE
   ------------------                --------                    -------------
   music on disk                     room codes                  phone (browser)
   plays locally          <ws>       state fan-out     <ws>      laptop (browser)
   serves file bytes  ------------>  audio relay   ------------> desktop app
   publishes state                   clock source                (Win/macOS/Linux)
```

The VPS relays playback from the host without storing those tracks. A friend's
contributed file is held temporarily under the server's `/tmp` until the host imports
it, then deleted; pending files expire after two days and are lost on a server restart.
The host stores imported songs under its stable `RhythmDock/incoming` data directory.
Room state is in memory, so a server restart requires everyone to rejoin and the host
to republish its queue.

Controllers can upload supported audio files up to 30 MB from the browser or desktop
app. Listen-only members cannot upload. The room host can click **Pair Telegram chat**
to get a ten-minute code, then send `/pair CODE` to the configured bot. Private chats
can send audio attachments up to the hosted Bot API's 20 MB download limit. Telegram
links are not supported yet. Set `TELEGRAM_BOT_TOKEN` in `.env` on the server to enable
the bot; it is never sent to room clients. The bot uses `getUpdates` polling, so do not
also configure a webhook for that token.

**Everything else is mirrored too:** the queue, the lyrics (with your offset and sync
tweaks), the theme and accent colour, playback speed, and the equalizer settings. A
phone in the room looks and behaves like the laptop driving it.

---

## Part 1 — Bring up the VPS

Anything with 1 vCPU and 512MB RAM is plenty. Ubuntu 22.04+ or Debian 12 assumed.

### 1. Point a domain at it

Create an `A` record for e.g. `music.example.com` pointing at your VPS IP. You need a
real domain: browsers refuse to open a `ws://` socket from an `https://` page, and
refuse microphone-free autoplay on insecure origins. A bare IP will fight you.

### 2. Install Docker and the code

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo git clone https://github.com/bestmahdi2/rhythm-dock-electron /opt/rhythm-dock
cd /opt/rhythm-dock/server
```

### 3. Set your create secret

```bash
cp .env.example .env
openssl rand -hex 24        # copy the output
sudo nano .env              # paste it as CREATE_SECRET
```

`CREATE_SECRET` gates **room creation only**. Your friends never need it — they just
need the 6-character room code. Without it, anyone who finds your server can use it as
a free relay.

### 4. Start it

```bash
sudo docker compose up -d
curl localhost:8420/healthz     # {"ok":true,"rooms":0,"members":0}
```

### 5. TLS and reverse proxy

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

sudo cp deploy/nginx.conf /etc/nginx/sites-available/rhythm-dock
sudo sed -i 's/music.example.com/YOUR-DOMAIN/g' /etc/nginx/sites-available/rhythm-dock
sudo ln -s /etc/nginx/sites-available/rhythm-dock /etc/nginx/sites-enabled/
```

Add this to the `http { }` block of `/etc/nginx/nginx.conf` if it is not already there:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

Then:

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR-DOMAIN
```

### 6. Firewall

```bash
sudo ufw allow 80,443/tcp
sudo ufw enable
```

Port 8420 stays closed to the world — nginx reaches it over localhost.

Visit `https://YOUR-DOMAIN`. You should see the join screen.

### Without Docker

```bash
sudo useradd -r -s /usr/sbin/nologin rhythm
cd /opt/rhythm-dock/server && sudo npm install --omit=dev
echo 'CREATE_SECRET=your-secret-here' | sudo tee /etc/rhythm-dock.env
sudo chmod 600 /etc/rhythm-dock.env
sudo cp deploy/rhythm-dock-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now rhythm-dock-server
```

---

## Part 2 — Host a room from your laptop

In the app: **Settings → Sharing**.

1. Server URL: `https://YOUR-DOMAIN`
2. Create secret: the value from your `.env`
3. Optional room password (separate from the create secret — this is what guests type)
4. **Everyone can control** — on, or off for a listen-only broadcast
5. **Start Room**

You get a 6-character code like `K7M2QP`. Share the code, or the link
`https://YOUR-DOMAIN/r/K7M2QP` which pre-fills it.

Your laptop keeps playing normally. It is now also serving.

---

## Part 3 — How people join

| Device | How |
|---|---|
| **Phone (any OS)** | Open `https://YOUR-DOMAIN`, type the code. No install. |
| **Any laptop** | Same — it is just a web page. |
| **Rhythm Dock app** (Win/macOS/Linux) | Settings → Sharing → Join Room |

All three speak the same protocol and land in the same room. A phone on the browser
client and a laptop running the desktop app are equal members.

> **Tap play once on mobile.** Browsers block audio until the user interacts with the
> page. The Join button doubles as that interaction, but if a phone joins while nothing
> is playing, the first track may need one tap.

---

## Part 4 — Roles

| | Listen | Play/pause/seek/skip | Reorder queue | Manage members |
|---|:--:|:--:|:--:|:--:|
| **Host** | ✅ | ✅ | ✅ | ✅ |
| **Controller** | ✅ | ✅ | ✅ | — |
| **Listener** *(only-viewer)* | ✅ | — | — | — |

A **listener** receives everything — audio, lyrics, artwork, theme, queue — and can
change nothing. Their own volume is local, so they can still turn themselves down.
Transport controls are hidden rather than disabled: a button you can press that only
produces an error is worse than no button.

Set the default for a room with the **Everyone can control** switch at creation, or
change any individual afterwards from the members list. The role check is enforced on
the **server**, not in the UI — a modified client cannot promote itself.

---

## Part 5 — Staying in sync

The server is the clock. Each client measures its offset NTP-style: it timestamps a
ping, the server stamps its arrival, and the client halves the round trip. Eight
samples are taken and the one with the **smallest** round trip wins, because a delayed
packet can only ever inflate the error.

Drift is then corrected by **nudging playback rate**, not by seeking:

| Drift | Response |
|---|---|
| under 60 ms | ignored — chasing it makes the rate audibly oscillate |
| 60 ms – 1.5 s | playback rate trimmed by up to 4% (inaudible) until aligned |
| over 1.5 s | hard seek — something big happened (a skip, a sleeping laptop) |

The little dot beside the timestamps shows link quality: green is good, amber is
usable, red means the network is struggling.

---

## Troubleshooting

**"Connects then immediately drops"** — the WebSocket upgrade headers are missing.
Check the `map $http_upgrade` block is in `nginx.conf`'s `http { }` section.

**Audio will not play on a phone** — tap the play button once. Browsers require a user
gesture before audio.

**Everyone hears a stutter every few seconds** — your laptop's upload is saturated.
Each listener consumes roughly one stream's bandwidth (~320 kbps for a typical MP3);
five listeners need ~1.5 Mbps *up*.

**"host is offline"** — your laptop lost its connection. The room survives for two
minutes to let it reconnect, then is reaped.

**Members drop after 60 seconds** — `proxy_read_timeout` is at its default. The supplied
nginx config sets it to 3600s.

---

## Security notes

- `CREATE_SECRET` gates room creation. Guests never need it.
- Room passwords are salted and scrypt-hashed, and compared in constant time.
- Members request opaque track **ids**, never paths. The id-to-path map lives only on
  your laptop and is built solely from the queue you published — a malicious member
  cannot request arbitrary files.
- The host slot is held by a token issued once at creation. Knowing the room code is
  not enough to take over a running room.
- The container runs unprivileged with a read-only root filesystem.

---

## Reference

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8420` | Listen port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` behind a proxy) |
| `CREATE_SECRET` | *(empty)* | Required to create rooms. **Set this.** |
| `MAX_ROOMS` | `50` | Concurrent room cap |

### HTTP

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Health and counts |
| `POST` | `/api/rooms` | Create a room → `{code, hostToken}` |
| `GET` | `/api/rooms/:code` | Public info (no token) |
| `GET` | `/api/rooms/:code/stream/:trackId` | Relayed audio, supports `Range` |
| `WS` | `/ws` | Everything else |

### Housekeeping

- A room with no host is reaped after **2 minutes**.
- A room with no members at all is reaped after **10 minutes**.
- Members that stop answering pings are dropped after **30 seconds**.

### Tests

```bash
cd "Rhythm Dock/server" && npm test
```

Boots a real server and drives it with real WebSocket clients: role enforcement,
password gating, clock projection, host disconnect and range parsing.
