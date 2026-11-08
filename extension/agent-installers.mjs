const BOOTSTRAP_URL = 'https://sweep.agentclub.dev/agent/bootstrap.mjs';
export const macInstallerDefaultExtensionId = 'bbccfejdhhcjmpfagjckiikgllpojhgm';
export const macInstallerArchive = 'History-Sweep-Agent-Installer-macOS.zip';
const macInstallerTag = 'agent-installer-macos-build-5';
export const macInstallerUrl = `https://github.com/agent-club/history-sweep/releases/download/${macInstallerTag}/${macInstallerArchive}`;
const NODE_VERSION = '24.22.2';
const NODE_SHA = Object.freeze({
  'darwin-arm64': 'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
  'darwin-x64': 'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52',
  'linux-arm64': '95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2',
  'linux-x64': '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9',
  'win-arm64': 'e2d6e75a0bfe4c176316d7c732eb8def9d94570c759eaeab335473a015abb7ea',
  'win-x64': '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9',
});

function validate({ platform, extensionId, client, bootstrapSha256 }) {
  if (!['macos', 'linux', 'windows'].includes(platform)) throw new Error('Unsupported platform');
  if (!/^[a-p]{32}$/.test(extensionId || '')) throw new Error('Invalid extension ID');
  if (!['codex', 'claude-code'].includes(client)) throw new Error('Invalid client');
  if (!/^[a-f0-9]{64}$/.test(bootstrapSha256 || '')) throw new Error('Invalid bootstrap SHA-256');
}

function posixRuntime(target) {
  return `#!/bin/sh
set -eu
tmp_root="${'${TMPDIR:-/tmp}'}"
tmp="$(mktemp -d "${'${tmp_root%/}'}/history-sweep.XXXXXXXX")"
stage=""
lock=""
cleanup() {
  rm -rf "$tmp"
  [ -z "$stage" ] || rm -rf "$stage"
  [ -z "$lock" ] || rmdir "$lock" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
os=${target}
arch="$(uname -m)"
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac
node_cmd=""
sha256_file() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
  node_cmd="$(command -v node)"
else
  runtime_dir="${'${HOME}'}/.history-sweep/runtime"
  runtime="$runtime_dir/node-v${NODE_VERSION}-$os-$arch"
  mkdir -p "$runtime_dir"
  case "$os-$arch" in
    darwin-arm64) expected_archive=${NODE_SHA['darwin-arm64']} ;;
    darwin-x64) expected_archive=${NODE_SHA['darwin-x64']} ;;
    linux-arm64) expected_archive=${NODE_SHA['linux-arm64']} ;;
    linux-x64) expected_archive=${NODE_SHA['linux-x64']} ;;
    *) echo 'No verified Node runtime for this architecture.' >&2; exit 1 ;;
  esac
  lock="$runtime_dir/.node-v${NODE_VERSION}-$os-$arch.lock"
  if ! mkdir "$lock" 2>/dev/null; then echo 'Runtime setup is already active; retry later.' >&2; lock=""; exit 1; fi
  if [ -e "$runtime" ]; then
    [ -d "$runtime" ] && [ -x "$runtime/node" ] && [ -f "$runtime/verified" ] || { echo 'Existing runtime is unrecognized; preserving it.' >&2; exit 1; }
    IFS=' ' read -r archive_pin binary_pin < "$runtime/verified"
    [ "$archive_pin" = "$expected_archive" ] && printf '%s' "$binary_pin" | grep -Eq '^[a-f0-9]{64}$' || { echo 'Existing runtime verification record is invalid; preserving it.' >&2; exit 1; }
    actual="$(sha256_file "$runtime/node")"
    [ "$actual" = "$binary_pin" ] || { echo 'Existing runtime binary differs; preserving it.' >&2; exit 1; }
  else
    archive="$tmp/node.tar.gz"
    url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-$os-$arch.tar.gz"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$url" -o "$archive"
    actual="$(sha256_file "$archive")"
    [ "$actual" = "$expected_archive" ] || { echo 'Node archive SHA-256 mismatch.' >&2; exit 1; }
    archive_node="node-v${NODE_VERSION}-$os-$arch/bin/node"
    tar -xOzf "$archive" "$archive_node" > "$tmp/node"
    chmod 700 "$tmp/node"
    stage="$(mktemp -d "$runtime_dir/.node-v${NODE_VERSION}-$os-$arch.XXXXXXXX")"
    cp "$tmp/node" "$stage/node"
    chmod 700 "$stage/node"
    binary_pin="$(sha256_file "$stage/node")"
    printf '%s %s\n' "$expected_archive" "$binary_pin" > "$stage/verified"
    chmod 600 "$stage/verified"
    mv -n "$stage" "$runtime"
    [ ! -e "$stage" ] || { echo 'Runtime appeared during download; preserving it.' >&2; exit 1; }
    stage=""
    actual="$(sha256_file "$runtime/node")"
    [ "$actual" = "$binary_pin" ] || { echo 'Installed runtime verification failed.' >&2; exit 1; }
  fi
  node_cmd="$runtime/node"
  rmdir "$lock"
  lock=""
fi
`;
}

export function createMacAppLauncher() {
  return `${posixRuntime('darwin')}"$node_cmd" "$1" --extension-id "$2" --client "$3" --install\n`;
}

function posixContent(platform, extensionId, client, bootstrapSha256) {
  const target = platform === 'macos' ? 'darwin' : 'linux';
  return `${posixRuntime(target)}bootstrap="$tmp/bootstrap.mjs"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 '${BOOTSTRAP_URL}' -o "$bootstrap"
actual="$(sha256_file "$bootstrap")"
[ "$actual" = '${bootstrapSha256}' ] || { echo 'Bootstrap SHA-256 mismatch.' >&2; exit 1; }
"$node_cmd" "$bootstrap" --extension-id '${extensionId}' --client '${client}'
`;
}

function windowsContent(extensionId, client, bootstrapSha256) {
  const script = `$ErrorActionPreference = 'Stop'; $tmp = Join-Path ([IO.Path]::GetTempPath()) ('history-sweep-' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $tmp | Out-Null; try { $arch = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }; $node = $null; $candidate = Get-Command node -ErrorAction SilentlyContinue; if ($candidate) { & $candidate.Source -e 'process.exit(Number(process.versions.node.split(String.fromCharCode(46))[0]) >= 22 ? 0 : 1)' 2>$null; if ($LASTEXITCODE -eq 0) { $node = $candidate.Source } }; if (-not $node) { $sha = if ($arch -eq 'arm64') { '${NODE_SHA['win-arm64']}' } else { '${NODE_SHA['win-x64']}' }; $runtimeDir = Join-Path $HOME '.history-sweep\\runtime'; New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null; $runtime = Join-Path $runtimeDir ('node-v{0}-win-{1}.exe' -f '${NODE_VERSION}', $arch); if (Test-Path -LiteralPath $runtime) { if ((Get-FileHash -Algorithm SHA256 -LiteralPath $runtime).Hash.ToLowerInvariant() -ne $sha) { throw 'Existing runtime differs; preserving it.' } } else { $nodeUrl = 'https://nodejs.org/dist/v${NODE_VERSION}/win-{0}/node.exe' -f $arch; $download = Join-Path $tmp 'node.exe'; Invoke-WebRequest -Uri $nodeUrl -OutFile $download -TimeoutSec 30; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash.ToLowerInvariant() -ne $sha) { throw 'Node runtime SHA-256 mismatch.' }; if (Test-Path -LiteralPath $runtime) { throw 'Runtime appeared during download; preserving it.' }; Move-Item -LiteralPath $download -Destination $runtime }; $node = $runtime }; $bootstrap = Join-Path $tmp 'bootstrap.mjs'; Invoke-WebRequest -Uri '${BOOTSTRAP_URL}' -OutFile $bootstrap -TimeoutSec 30; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $bootstrap).Hash.ToLowerInvariant() -ne '${bootstrapSha256}') { throw 'Bootstrap SHA-256 mismatch.' }; & $node $bootstrap --extension-id '${extensionId}' --client '${client}'; if ($LASTEXITCODE -ne 0) { throw ('Bootstrap failed with exit code {0}' -f $LASTEXITCODE) } } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }`;
  return `@echo off\r\npowershell.exe -NoProfile -Command "& { ${script} }"\r\nexit /b %ERRORLEVEL%\r\n`;
}

export function createInstaller({ platform, extensionId, client, bootstrapSha256 }) {
  validate({ platform, extensionId, client, bootstrapSha256 });
  const windows = platform === 'windows';
  return {
    filename: windows ? 'history-sweep-agent-install.cmd' : platform === 'macos' ? 'history-sweep-agent-install.command' : 'history-sweep-agent-install.sh',
    content: windows ? windowsContent(extensionId, client, bootstrapSha256) : posixContent(platform, extensionId, client, bootstrapSha256),
    mimeType: windows ? 'text/plain' : 'application/x-sh',
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function singleFileZip(filename, content, mode) {
  const name = new TextEncoder().encode(filename);
  const data = new TextEncoder().encode(content);
  const checksum = crc32(data);
  const local = new Uint8Array(30 + name.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(10, 0, true);
  localView.setUint16(12, 0x21, true);
  localView.setUint32(14, checksum, true);
  localView.setUint32(18, data.length, true);
  localView.setUint32(22, data.length, true);
  localView.setUint16(26, name.length, true);
  local.set(name, 30);

  const central = new Uint8Array(46 + name.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, (3 << 8) | 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(12, 0, true);
  centralView.setUint16(14, 0x21, true);
  centralView.setUint32(16, checksum, true);
  centralView.setUint32(20, data.length, true);
  centralView.setUint32(24, data.length, true);
  centralView.setUint16(28, name.length, true);
  centralView.setUint32(38, (mode << 16) >>> 0, true);
  central.set(name, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length + data.length, true);
  const bytes = new Uint8Array(local.length + data.length + central.length + end.length);
  let offset = 0;
  for (const part of [local, data, central, end]) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

export function createInstallerDownload(options) {
  const installer = createInstaller(options);
  const isPosix = options.platform !== 'windows';
  return {
    filename: `${installer.filename}.zip`,
    mimeType: 'application/zip',
    bytes: singleFileZip(installer.filename, installer.content, isPosix ? 0o100755 : 0o100644),
  };
}
