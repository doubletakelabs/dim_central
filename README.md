# Show Deploy

Push the room server and media from one central computer to every room
computer, see that they're running, and roll back if something's wrong.
Nothing happens automatically except "restart the room server if it dies."

```
central/   runs on your laptop (or the show's central machine)
agent/     runs on every room computer
room-server-example/   stand-in for the real room server
```

Both `config.json` files are ignored by git (they hold the token and
per-machine values). Copy the `config.example.json` next to each.

## How it works

- A **release** is a copy of the room server folder, `node_modules` included.
  Central keeps them in `central/releases/<id>/`. Room machines never run npm.
- Each room computer has `~/show/`:
  ```
  ~/show/releases/<id>/   downloaded releases (last 4 kept)
  ~/show/current.json     which release is live, and which was before it
  ~/show/content/         media synced from central (_common/ + <roomId>/)
  ~/show/shared/          per-machine config + logs, never touched by deploys
  ```
- **Deploy** = agent downloads the release (only changed files), writes
  `current.json`, restarts the room server, reports whether it answered HTTP.
- **Roll back** = swap `current.json` back to the previous release, restart.
- The agent starts the room server on boot and restarts it if it exits.
  It never changes releases on its own. If a release is bad you'll see red
  on the dashboard and you click Roll back.

## Office test: laptop = central, Mac = one room

### 1. Central (laptop)

```bash
cd central
npm install
cp config.example.json config.json    # then edit: token, rooms
npm start
```

It prints the dashboard URL (with the token) and the address room agents
should use, like `http://192.168.6.43:4000`. Open the dashboard.

`central/config.json` lists every room and the folder its server lives in
(paths are relative to `central/`):
```json
{
  "port": 4000,
  "token": "show-token",
  "rooms": {
    "influence": "../../02_influence",
    "example": "../room-server-example"
  }
}
```
Two rooms that run the same piece point at the same folder. A room's agent
must use one of these ids as its `roomId`, or the dashboard flags it as "not
in central config.json". Restart central after editing this file.

### 2. Make a release

Click **New release…** on that room's row (or `npm run release -- influence
"a note"`). It copies the room's folder into `central/releases/` as
`<date>-<time>-<room>`. **New release for all…** does every room at once.
If the piece has npm dependencies, run `npm install` in its folder first so
`node_modules` ships with it.

### 3. Agent (the Mac)

Copy the `agent/` folder to the Mac, then:

```bash
cd agent
npm install
cp config.example.json config.json
```

Edit `config.json` (three fields matter, delete the rest or leave defaults):
```json
{ "roomId": "mac-test", "central": "http://192.168.6.43:4000", "token": "show-token" }
```

```bash
node agent.js
```

The room appears on the dashboard within a few seconds. Its row shows the
newest release for that room; click **Deploy**. Open `http://<mac-ip>:8080`
to see the room server page.

### 4. Try breaking it

- Edit `room-server-example/server.js` to throw on startup, make a new release,
  deploy it. The dashboard shows "crashed N× in last minute" and the deploy
  result says failed. Click **Roll back**. Fix the file, make another release.
- Kill the room server process on the Mac (`kill <pid>`; the pid is in the logs).
  It comes back in a second or two and the dashboard shows "restarted 1×".
- Drop a file in `central/content/_common/`, click **Sync content to all**,
  refresh the room server page: the file is listed.
- Unplug the Mac from the network for a minute. Its row goes grey, then comes
  back. Nothing else happens.
- Reboot the Mac with the agent installed at startup (below). The room server
  is running again before anyone touches anything.

### 5. Start at boot

On each room computer, once:

```bash
cd agent
npm run install-startup
```

macOS uses launchd, Linux systemd, Windows a Startup-folder script. All three
also need the machine set to auto-login and never sleep. `npm run
remove-startup` undoes it.

## Day to day

1. Change a room's server code, `npm install` if dependencies changed.
2. Dashboard → that room's **New release…** → note what changed.
3. **Deploy** on that room. **Deploy to all rooms** sends each room its own
   selected release, and shows you the list before it goes.
4. Watch the Room server column go green. If one goes red, read its logs at
   the bottom, then **Roll back** that room.

Media: put files in `central/content/_common/` (all rooms) or
`central/content/<roomId>/` (one room), then **Sync content to all**. Files
already on a room are skipped; files removed from central are removed from rooms.

## Real room experiences (02_influence and friends)

A piece built to the handover contract (`experience.json`, zero dependencies,
`node server.js`) deploys as is. Three things the agent does for it:

- **Media and calibration stay out of releases.** "New release" skips whatever
  `media.dir` and `calibration.file` name in `experience.json`. Media goes in
  `central/content/<roomId>/` and reaches the room through **Sync content**.
- **Two env vars tell the piece where they are.** `MEDIA_DIR` is
  `~/show/content/<roomId>` and `CALIBRATION_FILE` is
  `~/show/shared/calibration.json`, so a projector mapping survives every
  deploy. A piece that ignores them falls back to its own folder and loses
  calibration on the next deploy, so make sure the contract asks for them.
- **Chrome kiosk, if you want it.** Add `"display": "chrome"` to that room's
  agent config and the agent opens `entry.display` from `experience.json`
  fullscreen once the server is up, and reopens it if Chrome exits. Rooms that
  show their display another way (TouchDesigner, no browser) just leave it out.
  `displayPath` overrides the page if needed.
- **Several monitors.** Add a `displays` list to that room's agent config,
  one entry per monitor, and the agent opens one kiosk window on each:
  ```json
  "display": "chrome",
  "displays": [
    { "path": "/wall.html?screen=1", "position": [0, 0] },
    { "path": "/wall.html?screen=2", "position": [1920, 0] }
  ]
  ```
  `position` is the monitor's top-left corner in the OS display arrangement
  (System Settings → Displays on macOS, Display settings on Windows). Set the
  arrangement once and leave it. The piece tells the windows apart by the
  query string. Windows and Linux place windows dependably; macOS needs
  "Displays have separate Spaces" on and is the one to test after a reboot.

The dashboard shows each room's IP and port, so DIM can be pointed at
`ws://<ip>:<port>` for its broker link.

## Per-room settings

Anything machine-specific goes in `~/show/shared/room-config.json` on that
machine. The room server reads it via `SHARED_DIR`. Deploys never touch it.

## If something's wrong

| Symptom | Look at |
|---|---|
| Room shows "not in central config.json" | Its `roomId` doesn't match a key under `rooms` in `central/config.json`. Fix one or the other and restart central. |
| Room not on dashboard | Is `node agent.js` running there? Does `central` in its config.json match what central printed? Same token? Same WiFi/VLAN? |
| "agent offline" | Agent process died or network dropped. It reconnects on its own. |
| "not running" / "crashed N×" | Room server is failing. Logs at the bottom of the dashboard (filter by room). Roll back. |
| "process up, no HTTP answer" | Room server started but isn't listening on its port yet, or listens on a different port. Check `roomServerPort` in agent config. |
| Deploy fails with "port already in use" | Another program on that machine owns the port (the old standalone launcher, a harness, AirPlay on 5000). Stop it or change `roomServerPort`. |
| Kiosk shows "closed" | Chrome isn't installed where the agent looks, or it crashed and is reopening. Agent log says which. |
| Deploy stuck on "download" | Big release or slow link. Progress shows in the Room server column. |
| Windows: nothing after reboot | Auto-login not set, or the Startup .cmd was removed. Run `npm run install-startup` again. |

Agent logs are also on the room machine at `~/show/shared/logs/agent.log`.

## Updating the agent itself

The agent is small and rarely changes. To update it, copy the new `agent/`
folder over the old one on each machine and restart the agent (on macOS:
`launchctl kickstart -k gui/$(id -u)/com.show.deploy-agent`, or just reboot).

## Optional agent settings

See `agent/config.example.json`. Useful ones: `roomServerPort` (default
8080; never use 5000, AirPlay owns it on macOS), `display` (`"chrome"` for
kiosk mode), `roomServerEntry` (default: from `scripts.start` in the release's
package.json, else `server.js`), `roomServerEnv` (extra env vars),
`healthGraceMs` (how long to wait for HTTP after start, default 30s).

`keepRunning` starts extra programs with the agent and reopens them if they
close, e.g. an HTML-to-NDI sender on one machine:

```json
"keepRunning": [
  { "cmd": "Tractus.HtmlToNdi.exe",
    "args": ["--ndiname=dimcyc", "--w=5000", "--h=1080", "--url=http://localhost:8080/index.html"] }
]
```

A relative `cmd` is looked for in the agent folder (put the exe there, or give
a full path like `C:\Tools\Tractus.HtmlToNdi.exe` (in JSON: `"C:\\Tools\\Tractus.HtmlToNdi.exe"`)). Write each argument
as its own string without the shell quotes.
