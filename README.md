# Tavern

A self-hosted, Discord-style chat for roleplaying with friends. It has servers, text channels, voice spaces, roles, DMs, replies, pins, reactions, custom emoji, uploads, link previews and search. On top of that it has the tabletop pieces: characters with full D&D 5e sheets, dice everyone sees roll, a narrator voice for the Dungeon Master, text effects for dramatic moments, a jukebox that plays the same song at the same moment for everyone listening, and a theater that does the same for videos.

```
backend/    FastAPI + SQLite (Python 3.12): API, live gateway, voice signalling, jukebox, theater, dice
frontend/   React + Vite app
data/       created on first run: the database and uploads
```

## Running it (Docker Compose)

On the Linux box, with Docker installed:

1. Copy this folder to the machine (e.g. `scp -r Tavern you@linuxbox:~/tavern`) and `cd` into it.
2. `cp .env.example .env` and fill it in (see the Cloudflare and Gmail sections below).
3. `docker compose up -d --build`
4. `docker compose logs tavern` and look for the setup box:
   ```
   Tavern has no accounts yet.
   Create the owner account here:
     https://tavern.example.com/register?setup=1A2B3C4D
   ```
   Open that link and create your account. The code only works once.
5. Create a server, then use **Invite People** (right-click the server icon, or the menu under the server's name). Registration is invite-only, so friends sign up through an invite link.

A new server starts with a **General** text channel, a **The Lounge** voice space, and two roles: **Dungeon Master** and **DJ**. The owner can do everything.

Everything Tavern stores is in `./data`.

**Trying it on Windows first:** Docker Desktop runs the same compose file. In `.env`, comment out `COMPOSE_PROFILES=tunnel`, set `PUBLIC_URL=http://localhost:8080`, then open http://localhost:8080.

## Cloudflare Tunnel

The tunnel lets friends open `https://tavern.yourdomain.com` without you opening ports on your router. It needs a domain that uses Cloudflare DNS. Cloudflare Registrar sells domains at cost.

1. In the Cloudflare dashboard, go to **Networking → Tunnels → Create a tunnel** and name it `tavern`.
2. When it shows install commands, pick **Docker** and copy the long token after `--token`. Put it in `.env` as `TUNNEL_TOKEN=...`.
3. On the tunnel's **Routes** tab, choose **Add route → Published application**. Set the subdomain to `tavern`, pick your domain, and set the service URL to `http://tavern:8080`.
4. Set `PUBLIC_URL=https://tavern.yourdomain.com` in `.env` and run `docker compose up -d`.

The `cloudflared` container runs next to Tavern. `COMPOSE_PROFILES=tunnel` in `.env` is what turns it on. Cloudflare's free plan caps each upload at 100 MB, which is why `.env.example` sets `MAX_UPLOAD_MB=95`. The same cap applies to songs uploaded to the jukebox and videos uploaded to the theater (each file is sent on its own); imports from links download on the server and aren't affected.

Cloudflare's terms also don't allow serving a lot of video through its free plan. Theater videos from YouTube never touch the tunnel (each person's browser plays them from YouTube), so that's the way to go for anything long; keep uploaded videos to short clips.

Voice and the live chat use WebSockets, which Cloudflare Tunnels carry without extra setup.

## Gmail (password-reset emails)

1. Turn on 2-Step Verification for the Google account. Google requires it for app passwords.
2. Create an app password at https://myaccount.google.com/apppasswords.
3. In `.env`, set `SMTP_USER=you@gmail.com` and `SMTP_PASSWORD=` followed by the 16-letter app password. Spaces are fine.
4. Run `docker compose up -d` to apply.

**Without email:** "Forgot your password?" still works. The reset link is printed in `docker compose logs tavern` for you to pass along.

## Voice spaces

Voice spaces work like Discord voice channels: click one to join, then talk, share your camera or your screen. Mute and deafen live next to your name at the bottom left. Right-click someone for their volume, a local mute, or (with the right role) server mute, **Move To** and disconnect. People with **Move Members** can also drag someone from one voice space onto another in the sidebar.

Hover **Voice Connected** (the green bars above your name) to see your latency to the server and to each person in the space. "(relay)" after a name means your voices reach each other through a TURN relay (see below).

Each voice space has its own **Bitrate** (the gear next to it, or right-click → **Edit Channel**): 8 to 256 kbps, 64 by default. It sets how clear everyone's voice sounds in that space. 64 is plenty for talking; go higher for singing or music. Everyone sends their voice to everyone else, so a higher bitrate also means more upload for everyone.

Settings → **Voice & Video**:

- **Input sensitivity** is one slider with your voice moving along it live: the mic opens when the bar passes the handle, and it turns green when people can hear you. Leave **Automatically determine input sensitivity** on and Tavern works out the level from how noisy your room is.
- **Noise suppression:** **Voice isolation** (the default on most computers) keeps your voice and removes keyboards, fans, dogs and other background noise, a lot like Discord's Krisp. It runs the free GTCRN model in your browser and adds about 30 ms of delay. **Standard** is the browser's own suppression (lighter, and the default on phones), and **Off** sends your mic as it is.
- **Screen share quality:** resolution (720p, 1080p, 1440p or your screen's own size), frame rate (15, 30 or 60) and what it's **Best for**: **Motion** keeps games and videos smooth; **Text** keeps documents and maps sharp. You pick it when you go live, and the tune button next to **Stop Sharing** changes it mid-stream and shows what's really being sent. Every viewer gets their own copy of your stream, so if it stutters, lower the resolution first (or the frame rate for text).

Chrome and Edge can share a tab with its sound, and on Windows (or a Mac on macOS 14.2 or newer with a recent Chrome) a whole screen with the computer's sound: turn on the audio switch in the browser's picker. Phones can watch streams but can't share their screen from a browser.

Audio and video go directly between browsers (a WebRTC mesh), which is great for a group of friends; with more than about eight people sharing cameras, everyone's upload starts to strain.

**If some people can't hear each other:** most home networks connect fine with the built-in STUN servers, but strict networks (some mobile carriers, schools, offices) need a relay. Create a free Cloudflare Realtime TURN key (the first 1,000 GB a month are free) at https://dash.cloudflare.com/?to=/:account/calls, put the key ID and API token in `.env` as `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`, and restart. Your own coturn server works too (`TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`).

Browsers only allow the microphone and camera on `https://` pages (or `localhost`), so use the tunnel address when you're not testing locally.

## Jukebox

The card at the top of the right-hand panel. Press **Listen in** and you hear exactly what everyone else listening hears, at the same moment. **My Volume** is yours alone; the **Jukebox Volume** is shared. The eye at the top of the card folds it down to one line (the theater card has one too). While a theater video's sound is playing, the music steps back so you can hear it.

- **DJs** (anyone with the DJ permission) manage everything else: upload songs or import links in the **Library**, queue, skip, reorder, shuffle, repeat, seek, fade out, set the shared volume.
- **Find Music:** a tab in the jukebox window that searches YouTube. **Add to Queue** downloads the song and plays it when its turn comes; **Add to Library** just keeps it. Songs already in the library aren't downloaded twice.
- **DM Lock:** when a Dungeon Master switches it on (top of the right-hand panel, or Server Settings), only Dungeon Masters can touch the jukebox until it's switched off again. The member list shows who's in the session.
- **Link imports** use [yt-dlp](https://github.com/yt-dlp/yt-dlp) (YouTube, SoundCloud, Bandcamp and many more; playlists too). Sites change often, so the container updates yt-dlp every time it starts. Only import things you're allowed to.
- **Spotify links** (songs, albums and playlists) work once you add a Spotify API key (below). Spotify doesn't hand out audio, so Tavern reads the song names from Spotify and downloads the matching audio from YouTube, keeping Spotify's titles and cover art. Now and then a song isn't found, or the match is a different version; delete it and add the right one from Find Music.
- Songs are loudness-matched so a quiet track doesn't need the volume cranked.

## Theater

The card under the jukebox. It works like the jukebox, but for videos: press **Take a Seat** and you see the same moment of the same video as everyone else who's seated (the card shows who's in the audience). **My Volume** is yours alone.

- **Videos:** mainly YouTube. Paste a link (playlists work too) in the theater's **Library**, or search on the **Find Videos** tab. YouTube videos play in YouTube's own player straight from YouTube, so nothing is downloaded and nothing goes through your server or the tunnel. You can also upload video files; Tavern converts them to play in every browser (see the Cloudflare notes about uploads).
- **Where you watch:** in the card; in a **mini player** you can drag and resize (it pops out by itself when the card is folded, scrolled away or covered); on the **big screen** (with full screen); or in **picture-in-picture** so it floats over other windows (Chrome and Edge; uploaded videos also in Safari).
- **Clicking the video** pauses it on your screen only. **Catch up** jumps you back to where everyone is (DJs also get **Pause for everyone**).
- **DJs** run it, the same people who run the jukebox: queue, skip, seek, shuffle, repeat. **DM Lock** covers the theater too.
- **Sound:** browsers only allow sound after you've clicked something on the page, so if you open Tavern already seated, the video plays muted with a **Click for sound** button.
- If YouTube says a video can't be shown outside YouTube (or it's been removed), Tavern checks for itself and skips it for everyone.

### Spotify API key (optional)

1. The Spotify account you use needs **Premium**: since 2026, Spotify only runs developer apps for Premium accounts.
2. Go to https://developer.spotify.com/dashboard, choose **Create app**, give it a name (Tavern) and add this **Redirect URI**: your `PUBLIC_URL` followed by `/api/spotify/callback`, e.g. `https://tavern.yourdomain.com/api/spotify/callback`. Tick **Web API** and save.
3. In the app's **Settings**, copy the **Client ID** and **Client secret** into `.env` as `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`, then run `docker compose up -d`.

Songs and albums work straight away. Spotify only lets apps read a playlist's songs for the person who owns it (or collaborates on it), so for playlists a DJ clicks **connect your Spotify account** in the jukebox Library once. A developer app can have up to five Spotify users: add your friends' Spotify emails under **User Management** in the dashboard if they want to import their own playlists too.

## Characters, sheets and dice

- **Create characters** in User Settings → **Characters**: a name, a picture (you can crop and zoom it when you pick it), a name colour and an optional proxy tag. Pick who you speak as with the picture beside the message box, with a proxy tag (`x:hello` sends "hello" as Xargorf if his tag is `x:text`), or with **Alt + ↑ / ↓**.
- **Book look:** the **Book** button in the formatting bar (or next to the message box if you've turned the bar off). While it's on, what you send shows as story for everyone: your name in your character's colour, and the text in a box with a faint tint of that colour. "Text in quotes" is speech, in white; everything else is action, in italics and a darker shade of the colour. Each channel remembers your choice (on for characters, off for yourself until you change it). With it off, messages look like plain Discord. Narration always has the book look. Settings → **Roleplay** has the **Book font** switch.
- **Formatting:** while you type, a bar above the message box does bold, italic, underline, strikethrough, text size, text colour, speech quotes, spoilers and the book look. **Ctrl+B / I / U** work too.
- **Text effects:** the sparkly **T** in the formatting bar. Select some text (or pick an effect before you type) and choose from wave, shake, float, fire, frost, rainbow, glitch, whisper, shout, echo, telepathy, runes, redacted, typewriter, slam and two dozen more, previewed as you hover. Everyone sees them move; Settings → **Roleplay** → **Animate text effects** makes them hold still for you, and so does your system's reduced-motion setting.
- **Character sheets:** every character has a full D&D 5e sheet: abilities, saves, skills, hit points, attacks, spells and slots, inventory, coins, features, and pages for backstory and notes. Open it from the character's card (click their name) or the **Sheet** button in Settings → Characters. Each sheet is **Public** (anyone in your servers can read it) or **Private** (only you and the Dungeon Masters). Dungeon Masters can edit any sheet.
- **Rolling:** click any number on a sheet to roll it into the channel you have open (right-click for advantage, disadvantage or a private roll). The dice button in the message box has quick dice and every check from your sheet. Or type:
  - `/roll 2d6+3`, `/r d20`, `/roll 4d6kh3 for Strength`
  - `/roll stealth`, `/roll dex save dc 15`, `/roll init`, `/roll perc adv`
  - `/proll ...` rolls privately (only you and the Dungeon Masters see it)
- **Dungeon Masters** can speak as the **narrator** (pick it in the picker; rename it in Server Settings), roll for any player's character from the dice tray or their sheet, and see private rolls.
- **Puppeteer or Immersive** (Settings → Roleplay): Puppeteer shows a small player tag next to each character's name; Immersive hides who plays whom. Each person chooses for themselves.
- **Out-of-character channels:** deny **Use Characters** in a channel's permissions to make everyone talk as themselves there.

## Messages

Right-click a message (or use the buttons that appear when you hover it) to reply, react, edit, pin or delete it. Hold **Shift** while you hover a message and a red delete button appears: one click deletes it without asking. **Shift**-clicking **Delete Message** in the right-click menu skips the question too.

Videos in messages and link previews play in Tavern's own player: it takes the video's shape (no black bars), and has a seek bar you can drag, a volume slider, playback speed, picture-in-picture and full screen.

Big pictures (maps, portraits, art) show in chat as a smaller copy, so a channel full of them opens quickly, even on a phone. Click one to see the original at full size. GIFs and other moving pictures are shown as they are.

Long channels stay quick: Tavern keeps about 250 messages loaded at a time, like Discord. Scroll up and older messages load in. Once you're far back, a bar says you're viewing older messages, and **Jump To Present** (or sending a message) takes you back down.

## Roles

Server Settings → **Roles**. **Admin** sits at the top of the list and grants every permission below it (Tavern asks before you turn it on). **Dungeon Master** lets someone roll for players, narrate, see private rolls, and turn on DM Lock (and run the jukebox and theater while it's on). **DJ** runs the jukebox and theater the rest of the time. Voice permissions (Connect, Speak, Video & Screen Share, Mute, Deafen and Move Members) can be set per role and per voice space.

## Updating

Replace the files with the new version, keeping `.env` and `data/`, then run:

```
docker compose up -d --build
```

New database columns and tables are added automatically on startup.

**Coming from Tavern 1.x:** the first start of 2.x also tidies up existing servers once. Each one gets a **The Lounge** voice space, empty **Dungeon Master** and **DJ** roles (hand them out in Server Settings → Roles), and voice permissions for @everyone. Channel names get their capitals back ("ooc-chat" becomes "OOC Chat"), and the old "Text Channels" category is removed, since the sidebar has its own Text Channels heading now (unless you gave that category its own permissions). Its channels stay, in the same order. Rename anything you'd like differently.

## Backups

```
docker compose exec -u tavern tavern python -m tavern.backup
```

This writes a consistent copy of the database to `data/backups/`. Copy `data/backups/` and `data/uploads/` (pictures, attachments, jukebox songs and theater videos) somewhere safe. You can leave out `data/uploads/previews/`, since Tavern makes those small copies of pictures again when they're needed. Another option is `docker compose stop tavern`, then copy the whole `data` folder.

**Restoring:**

1. Stop Tavern.
2. Put the backup at `data/tavern.db` and delete any `tavern.db-wal` or `tavern.db-shm` files next to it.
3. Restore `data/uploads/`.
4. Start Tavern again.

## Settings (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | The address people open. Used in invite and reset links and in security checks. |
| `COMPOSE_PROFILES` | not set | Set to `tunnel` to start the cloudflared container. |
| `TUNNEL_TOKEN` | not set | Cloudflare Tunnel token. |
| `SMTP_USER`, `SMTP_PASSWORD` | not set | Gmail address and app password. |
| `SMTP_FROM` | same as `SMTP_USER` | Sender, e.g. `Tavern <you@gmail.com>`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` | `smtp.gmail.com`, `587`, `starttls` | For other mail providers. Use `ssl` with port 465. |
| `MAX_UPLOAD_MB` | `100` | Total upload size per message. |
| `LINK_EMBEDS` | `true` | Link previews. The server fetches the linked page. |
| `STUN_URLS` | Cloudflare and Google STUN | Comma-separated STUN servers for voice. |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | not set | Cloudflare Realtime TURN relay for voice (see Voice spaces). |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | not set | Your own TURN server instead. |
| `JUKEBOX_URL_IMPORTS` | `true` | Let DJs import songs from links with yt-dlp. |
| `JUKEBOX_MAX_TRACK_MB` | `300` | Biggest song file accepted. |
| `JUKEBOX_ALLOW_PRIVATE_URLS` | `false` | Let link imports reach addresses on your own network (a NAS, say). Off so nobody can make the server poke around your home network. |
| `YTDLP_AUTO_UPDATE` | `true` | Update yt-dlp each time the container starts. |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | not set | Spotify API key for Spotify links in the jukebox (see Jukebox). |
| `THEATER_MAX_VIDEO_MB` | `500` | Biggest video file the theater accepts (through the Cloudflare tunnel, 100 MB is the real limit). |
| `ALLOWED_ORIGINS` | not set | Extra origins allowed to use the API, comma-separated. |
| `COOKIE_SECURE` | on for `https` URLs | Forces the Secure flag on the login cookie. |
| `TRUST_PROXY_HEADERS` | `true` | Reads visitors' IPs from Cloudflare's headers. Rate limits use them. |
| `LOG_LEVEL` | `info` | |

## Development

Backend (Python 3.12, plus `ffmpeg` on your PATH for the jukebox, and [Deno](https://deno.com) for YouTube imports):

```
cd backend
python -m venv .venv
.venv\Scripts\activate            (Linux: source .venv/bin/activate)
pip install -r requirements.txt
uvicorn tavern.main:app --port 8080 --reload
```

Frontend (Node 22), in a second terminal:

```
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Vite forwards API and WebSocket traffic to the backend, and data goes to `backend/data`. End-to-end checks of the API and gateway live in `backend/tests/`: `python tests/smoke_test.py`, `python tests/smoke_v2.py`, `python tests/check_imports.py` and `python tests/smoke_theater.py` (the last three need ffmpeg; the last two fake YouTube and Spotify, so they need no network).

Working on the code? Read `handoff.txt` next. It explains how Tavern works inside and the rules that keep it working.

## Notes

- Run exactly one Tavern process. Live updates, voice rooms, the jukebox and theater clocks and rate limits are held in memory, so don't add workers.
- Not in this version: a light theme, maps and initiative trackers.

## License

Tavern is free to use, change and share for any noncommercial purpose under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). Commercial use isn't allowed without the author's permission.
