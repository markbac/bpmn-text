#!/usr/bin/env bash
# Brings a bpmn-text install up to date and checks that it works: the code,
# the npm packages, Chromium, the build, the bpmn-text command and,
# optionally, the Docker images, the tests and a running web editor.
#
# Run it after every pull, or when something misbehaves after a change.
# Each step says what it does, and the script stops at the first step that
# fails, with what to do about it.
#
#   1. Code       git pull --ff-only; when the pull changes this script,
#                 the new version runs instead, with the same options
#   2. Node       Node.js 20.19+ or 22.12+, and npm
#   3. Packages   npm ci, when package-lock.json changed since the last one
#   4. Chromium   for SVG and PNG output (Playwright's copy)
#   5. Build      every package and the web editor
#   6. Command    bpmn-text on the PATH is this checkout (npm link)
#   7. Docker     with --docker: the editor and CLI images, tagged with the
#                 version and latest; images of earlier versions removed
#   8. Doctor     bpmn-text turns an example into .bpmn and .png
#   9. Tests      with --test: lint, typecheck and the test suite
#  10. Serve      with --serve: the web editor on http://localhost:PORT, in
#                 Docker with --docker (left running), else in the foreground
#
# Usage: scripts/update.sh [options]
#   --no-pull          use the code as it is
#   --test             also run lint, typecheck and the tests
#   --docker           also build the Docker images
#   --serve            start the web editor afterwards
#   --port N           port for --serve (default 8080)
#   --no-link          do not put bpmn-text on the PATH
#   --no-browser       skip Chromium (no SVG or PNG output)
#   --keep-old-images  keep the Docker images of earlier versions
#   --ca-file PATH     a proxy's CA certificate, for npm and Docker builds
#   -h, --help         this text
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/update.sh"
args=("$@")
pull=1 test=0 docker=0 serve=0 port=8080 link=1 browser=1 keep=0 ca=''
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull) pull=0 ;;
    --test) test=1 ;;
    --docker) docker=1 ;;
    --serve) serve=1 ;;
    --port) port="${2:?--port needs a number}"; shift ;;
    --no-link) link=0 ;;
    --no-browser) browser=0 ;;
    --keep-old-images) keep=1 ;;
    --ca-file) ca="${2:?--ca-file needs a path}"; shift ;;
    -h | --help) sed -n '2,/^set -uo/p' "$script" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

if [ -t 1 ]; then
  cyan=$'\e[36m' green=$'\e[32m' yellow=$'\e[33m' red=$'\e[31m' plain=$'\e[0m'
else
  cyan='' green='' yellow='' red='' plain=''
fi
n=0
step() { n=$((n + 1)); printf '\n%s[%d] %s%s\n' "$cyan" "$n" "$1" "$plain"; }
ok() { printf '    %sok%s    %s\n' "$green" "$plain" "$1"; }
note() { printf '    %snote%s  %s\n' "$yellow" "$plain" "$1"; }
fail() {
  printf '    %sFAIL%s  %s\n' "$red" "$plain" "$1"
  [ -n "${2:-}" ] && printf '          %s\n' "$2"
  exit 1
}
# Runs a command, showing its output, and stops when it fails.
run() {
  local what="$1" advice="$2"
  shift 2
  "$@" || fail "$what failed (exit status $?)" "$advice"
}
# The same, but shows the output only when the command fails.
quiet() {
  local what="$1" advice="$2" log status
  shift 2
  log="$(mktemp)"
  "$@" >"$log" 2>&1
  status=$?
  [ "$status" = 0 ] || { tail -n 40 "$log"; rm -f "$log"; fail "$what failed (exit status $status)" "$advice"; }
  rm -f "$log"
}

cd "$root" || exit 1
echo "bpmn-text update in $root"
if [ -n "$ca" ]; then
  [ -f "$ca" ] || fail "--ca-file $ca does not exist"
  export NODE_EXTRA_CA_CERTS="$ca" npm_config_cafile="$ca"
fi

# 1. Code
step "Code"
if [ "$pull" = 0 ]; then
  note "not pulled (--no-pull)"
elif ! command -v git >/dev/null || [ ! -d .git ]; then
  note "not a Git checkout, so nothing to pull"
else
  before="$(cksum <"$script")"
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" = main ] || note "on branch $branch, not main"
  [ -z "$(git status --porcelain --untracked-files=no)" ] ||
    note "local changes to tracked files are kept; a pull that would touch them stops here"
  run "git pull" "Pull or merge by hand (the pull only fast-forwards), or run with --no-pull" \
    git pull --ff-only
  ok "$branch at $(git log -1 --format='%h %s')"
  if [ "$(cksum <"$script")" != "$before" ]; then
    note "the pull changed this script, so the new version runs now, with the same options"
    exec bash "$script" --no-pull "${args[@]}"
  fi
fi

# 2. Node
step "Node"
command -v node >/dev/null ||
  fail "node is not installed" "Install Node.js 22 LTS from https://nodejs.org (or your package manager)"
version="$(node -p 'process.versions.node')"
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22 ? 0 : 1);
' || fail "Node.js $version is too old" "bpmn-text needs Node.js 20.19+ or 22.12+; install 22 LTS"
command -v npm >/dev/null || fail "npm is not installed" "It comes with Node.js; reinstall Node.js"
ok "Node.js $version, npm $(npm --version)"

# 3. Packages
step "Packages"
if [ -f node_modules/.package-lock.json ] && [ ! package-lock.json -nt node_modules/.package-lock.json ]; then
  ok "up to date with package-lock.json"
else
  run "npm ci" "Read npm's message above; behind a proxy, set HTTPS_PROXY or use --ca-file" \
    npm ci --no-audit --no-fund
  ok "installed from package-lock.json"
fi

# 4. Chromium
step "Chromium"
if [ "$browser" = 0 ]; then
  note "skipped (--no-browser): .bpmn output works, SVG and PNG do not"
else
  run "installing Chromium" "Read the message above; behind a proxy, set HTTPS_PROXY or use --ca-file" \
    npx --no-install playwright-core install chromium
  ok "Chromium for SVG and PNG output"
fi

# 5. Build
step "Build"
quiet "npm run build" "The compiler's message is above. Run with --test to see which test fails" \
  npm run build
version="$(node -p 'require("./packages/cli/package.json").version')"
ok "bpmn-text $version, and the web editor in apps/editor/dist"

# 6. Command
step "Command"
cli="$root/packages/cli/dist/cli.js"
if [ "$link" = 0 ]; then
  note "PATH left alone (--no-link); run node $cli"
elif npm link -w packages/cli --no-audit --no-fund --silent 2>/dev/null; then
  ok "bpmn-text is linked to this checkout"
else
  note "npm link could not write to $(npm prefix -g)"
  note "use a prefix of your own: npm config set prefix ~/.local (with ~/.local/bin on the PATH), then run this again"
fi
if [ "$link" = 1 ] && command -v bpmn-text >/dev/null; then
  target="$(readlink -f "$(command -v bpmn-text)")"
  if [ "$target" = "$(readlink -f "$cli")" ]; then
    ok "bpmn-text on the PATH is this checkout ($(command -v bpmn-text))"
  else
    note "bpmn-text on the PATH is another install: $(command -v bpmn-text)"
  fi
fi

# 7. Docker
if [ "$docker" = 1 ]; then
  step "Docker"
  command -v docker >/dev/null || fail "docker is not installed" "Install Docker Engine (or Docker Desktop)"
  docker info >/dev/null 2>&1 || fail "the Docker engine does not answer" "Start it (sudo systemctl start docker), or add yourself to the docker group"
  secret=()
  [ -n "$ca" ] && secret=(--secret "id=ca,src=$ca")
  for target in editor cli; do
    image="bpmn-text$([ "$target" = editor ] && echo -editor)"
    run "building the $target image" "Read the build output above; behind a proxy, use --ca-file" \
      docker build "${secret[@]}" --target "$target" -t "$image:$version" -t "$image:latest" .
    ok "$image:$version"
    if [ "$keep" = 0 ]; then
      for old in $(docker images "$image" --format '{{.Tag}}' | grep -vxF -e latest -e "$version"); do
        docker rmi "$image:$old" >/dev/null && note "removed $image:$old"
      done
    fi
  done
fi

# 8. Doctor
step "Doctor"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
run "bpmn-text build" "The message above says what went wrong" \
  node "$cli" build examples/01-simple.bpmnt -o "$out/01-simple.bpmn"
ok "examples/01-simple.bpmnt → .bpmn"
if [ "$browser" = 1 ]; then
  if node "$cli" build examples/01-simple.bpmnt -f png -o "$out/01-simple.png" 2>"$out/error"; then
    ok "examples/01-simple.bpmnt → .png"
  else
    cat "$out/error"
    fail "PNG output failed" "Chromium may lack system libraries: sudo npx playwright-core install-deps chromium"
  fi
fi
if [ "$docker" = 1 ]; then
  cp examples/01-simple.bpmnt "$out/"
  chmod a+rwx "$out"
  run "the CLI image" "Rebuild it: scripts/update.sh --docker" \
    docker run --rm -v "$out:/work" "bpmn-text:$version" build 01-simple.bpmnt -f png -o docker.png
  ok "the CLI image turns an example into .png"
fi

# 9. Tests
if [ "$test" = 1 ]; then
  step "Tests"
  run "lint" "Run npm run format, or fix what ESLint reports" npm run lint --silent
  run "typecheck" "Fix the type errors above" npm run typecheck --silent
  run "tests" "A test failed: see above" npm test --silent
  ok "lint, typecheck and tests pass"
fi

# 10. Serve
if [ "$serve" = 1 ]; then
  step "Serve"
  if [ "$docker" = 1 ]; then
    run "starting the editor" "Is port $port free? Choose another with --port" \
      env BPMN_TEXT_PORT="$port" docker compose up -d --force-recreate editor
    ok "the web editor runs at http://localhost:$port (docker compose down to stop it)"
  else
    ok "the web editor at http://localhost:$port (Ctrl+C to stop)"
    exec npm run preview -w apps/editor -- --port "$port" --strictPort
  fi
fi

printf '\n%sbpmn-text %s is up to date.%s\n' "$green" "$version" "$plain"
