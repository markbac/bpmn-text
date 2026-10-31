# Deployment

bpmn-text has two parts to run:

- **The web editor** is a static web site. It compiles diagrams in the
  browser, so the server only hands out files, and no diagram ever leaves
  the user's machine.
- **The command line** (`bpmn-text build`, `check`, `fmt`) runs on Node.js.
  SVG and PNG output also need Chromium.

Both can run on a user's own PC or on a server, from a checkout of this
repository, kept up to date by one script.

```mermaid
flowchart TB
  subgraph pc[User's PC]
    direction LR
    co[Checkout] -->|update script| cmd[bpmn-text on the PATH]
    co -->|--serve| lp[localhost:8080] --> br[Browser: editor]
  end
  subgraph srv[Server with Docker]
    direction LR
    co2[Checkout] -->|update script --docker --serve| ctr[bpmn-text-editor container]
    rp[Reverse proxy, HTTPS] --> ctr
  end
  users([Users' browsers]) --> rp
  img[bpmn-text CLI image] -. docker run .-> files[(.bpmnt → .bpmn, .svg, .png)]
```

## The update script

`scripts/update.sh` (Linux and macOS) and `scripts/update.ps1` (Windows)
bring a checkout up to date and check that it works. Run it after every
pull, or whenever something misbehaves:

```bash
scripts/update.sh                  # Linux, macOS
.\scripts\update.ps1               # Windows (PowerShell)
```

It pulls, installs the npm packages and Chromium, builds everything, puts
`bpmn-text` on the PATH and turns an example into `.bpmn` and `.png`. Each
step prints `ok` or `FAIL` with what to do, and it stops at the first
failure. When a pull changes the script itself, the new version takes
over.

```mermaid
flowchart LR
  c[1 Code<br/>git pull] --> n[2 Node] --> p[3 Packages<br/>npm ci] --> ch[4 Chromium] --> b[5 Build]
  b --> l[6 Command<br/>npm link] --> dk[7 Docker<br/>--docker] --> dr[8 Doctor] --> t[9 Tests<br/>--test] --> sv[10 Serve<br/>--serve]
  c -. script changed .-> c
```

A run looks like this:

```text
[1] Code
    ok    main at 8d1b7c5 Add Docker images, update scripts and a deployment guide
[2] Node
    ok    Node.js 22.23.4, npm 10.9.9
[3] Packages
    ok    up to date with package-lock.json
[4] Chromium
    ok    Chromium for SVG and PNG output
[5] Build
    ok    bpmn-text 0.0.0, and the web editor in apps/editor/dist
[6] Command
    ok    bpmn-text on the PATH is this checkout (/usr/local/bin/bpmn-text)
[7] Doctor
    ok    examples/01-simple.bpmnt → .bpmn
    ok    examples/01-simple.bpmnt → .png

bpmn-text 0.0.0 is up to date.
```

| `update.sh` | `update.ps1` | Effect |
|---|---|---|
| `--no-pull` | `-NoPull` | Use the code as it is |
| `--test` | `-Test` | Also run lint, typecheck and the tests |
| `--docker` | `-Docker` | Also build the Docker images |
| `--serve` | `-Serve` | Start the web editor afterwards |
| `--port N` | `-Port N` | Port for the editor (default 8080) |
| `--no-link` | `-NoLink` | Do not put `bpmn-text` on the PATH |
| `--no-browser` | `-NoBrowser` | Skip Chromium: no SVG or PNG output |
| `--keep-old-images` | `-KeepOldImages` | Keep the Docker images of earlier versions |
| `--ca-file PATH` | `-CaFile PATH` | A proxy's CA certificate, for npm and Docker builds |

It needs Git and Node.js 22 LTS (20.19 or later works too), and Docker
only for `--docker`.

## On a user's PC

```bash
git clone https://github.com/markbac/bpmn-text.git
cd bpmn-text
scripts/update.sh --serve          # or .\scripts\update.ps1 -Serve
```

The editor is then at <http://localhost:8080> until you press Ctrl+C, and
`bpmn-text` works in any new terminal. To update later, run the same
command again.

With Docker but without Node.js, run the editor from the checkout with
Docker alone; `git pull` and the same command update it:

```bash
docker compose up -d --build       # the editor at http://localhost:8080
```

## On a server

On a Linux server with Docker, the editor runs as a container that
restarts with the machine:

```bash
git clone https://github.com/markbac/bpmn-text.git /opt/bpmn-text
cd /opt/bpmn-text
scripts/update.sh --docker --serve --port 8080
```

That builds the images, checks them, and (re)starts the editor container
from `compose.yaml`. To deploy a change, run the same command again: the
container is replaced by one with the new version, and the images of older
versions are removed.

Put your usual reverse proxy in front for HTTPS and a host name. The
container serves plain HTTP on the port you chose; for example, with
nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
}
```

To update on a schedule rather than by hand, run the script from cron or a
systemd timer, for example nightly:

```bash
0 3 * * * cd /opt/bpmn-text && scripts/update.sh --docker --serve >> /var/log/bpmn-text-update.log 2>&1
```

### Without containers

The editor is only files, so any web server can serve it. Build it with
`scripts/update.sh` (or download `bpmn-text-editor-<version>.zip` from a
release) and copy `apps/editor/dist` to the server; `docker/nginx.conf`
shows suitable caching headers.

## The command line in a container

The `bpmn-text` image has the command line and Chromium, so SVG and PNG
output need nothing else installed. It works on the current directory:

```bash
docker run --rm -v "$PWD:/work" -u "$(id -u):$(id -g)" bpmn-text build order.bpmnt -f png -o order.png
docker run --rm -v "$PWD:/work" bpmn-text check "**/*.bpmnt"
```

On Windows (PowerShell), use `-v "${PWD}:/work"` and leave out `-u`.

Build it with `scripts/update.sh --docker`, or without a checkout's tools:

```bash
docker build --target cli -t bpmn-text .
```

## Behind a proxy

Set `HTTPS_PROXY` as usual for npm and Docker. If the proxy inspects TLS,
give the update script its certificate with `--ca-file` (`-CaFile`): it is
passed to npm, to Chromium's download and to the Docker builds as a build
secret, so it never ends up in an image.
