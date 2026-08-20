# Shitcord on the Pi 4

Self-hosted chat for the IKEA/NINERSMP tuff school GC.

```
start.sh       one command to launch it, with checks
server.js      Node + SQLite + WebSocket backend
index.html     login / signup
chat.html      the chat
package.json   dependencies
```

The Pi serves both pages, so there's no more "put the files in the same folder"
problem — you just visit the Pi.

---

## Setup

Copy all five files to one folder on the Pi, then:

```bash
cd ~/shitcord
chmod +x start.sh
./start.sh
```

That checks Node is installed and new enough, checks the files are all there,
installs dependencies the first time, and starts the server. If something's
wrong it says exactly what.

Doing it by hand instead:

```bash
cd ~/shitcord
npm install
node server.js
```

Note the spacing and case: `node server.js` — a space after `node`, and `.js`
lowercase. Linux treats `server.JS` as a different file that doesn't exist.

If Node is missing or old (Raspberry Pi OS ships an ancient one):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

It prints the address to use:

```
  Shitcord is up.
  On this Pi      http://localhost:8080
  On your network http://192.168.1.42:8080
```

Everyone on your Wi-Fi opens that second address. First person to sign up gets
their username; everyone else shows up in each other's member lists immediately.

`npm install` may take a few minutes the first time if `better-sqlite3` has to
compile from source on the Pi. That's normal and only happens once.

---

## Keep it running

Right now it stops when you close the terminal. To make it start on boot:

```bash
sudo tee /etc/systemd/system/shitcord.service > /dev/null <<'EOF'
[Unit]
Description=Shitcord
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/shitcord
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now shitcord
systemctl status shitcord          # check it's alive
journalctl -u shitcord -f          # watch the logs
```

Adjust `User=` and the paths if you're not on the default `pi` account.

---

## The database

Everything lives in `shitcord.db` next to `server.js`. Back it up by copying
that file — accounts, messages, channels, the lot.

```bash
sqlite3 shitcord.db "SELECT name, datetime(joined/1000,'unixepoch') FROM users;"
```

It's in WAL mode, which handles sudden power loss on an SD card far better than
the default. If you'd rather keep it on the Lexar drive so the SD card isn't
taking the write load:

```bash
DB_PATH=/mnt/usb/shitcord.db node server.js
```

To wipe everything and start clean, stop the server and delete `shitcord.db`
along with the `-wal` and `-shm` files beside it.

---

## What changed now that the Pi is in charge

Everything I'd flagged as fake before is real:

**Passwords never reach the browser's storage.** They're hashed on the Pi with
scrypt and a per-user random salt. The database stores a 128-character hash;
the password itself is never written anywhere. Login comparison is constant-time
so it can't be probed by timing.

**Private channels are actually private.** The server decides who receives what.
If you're not a member, you don't get the messages, you don't get the history,
and the channel doesn't appear in your channel list at all. Opening devtools
gains you nothing — the data was never sent to you.

**DMs are between two people,** enforced the same way.

**No more polling.** One WebSocket per person. Messages, reactions, edits,
typing indicators and online status arrive the moment they happen instead of
up to 3 seconds later.

**Accounts work on any device.** Sign up on your laptop, log in on your phone —
same account, because it lives on the Pi now.

Sessions are httpOnly cookies, so page JavaScript can't read the token.

---

## Reaching it from outside your house

As-is this is LAN only, which is the safe default. If you want it reachable from
school, put Caddy in front rather than forwarding port 8080 directly — you'll get
HTTPS automatically, which also means the WebSocket upgrades to `wss://`:

```
your-pi.sslip.io {
    reverse_proxy localhost:8080
}
```

The client already picks `wss://` when the page is served over HTTPS, so nothing
in the app needs changing.

Two things worth thinking about before you open it up: anyone who can reach the
URL can create an account, and there are no moderator tools yet — no way to
delete someone else's messages, ban anyone, or lock a channel. Worth adding
before it's on the open internet.
