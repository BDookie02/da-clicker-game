import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const start = readFileSync(new URL('../scripts/start-physical-pvp-qa.ps1', import.meta.url), 'utf8');
const stop = readFileSync(new URL('../scripts/stop-physical-pvp-qa.ps1', import.meta.url), 'utf8');
const startPath = fileURLToPath(new URL('../scripts/start-physical-pvp-qa.ps1', import.meta.url));
const psLiteral = (value) => `'${value.replaceAll("'", "''")}'`;

test('physical PvP QA uses one freshly verified APK and one shared local backend', () => {
  assert.match(start, /build-test-apk\.ps1/);
  assert.doesNotMatch(start, /SkipBuild/);
  assert.match(start, /EXACT TEST APK READY/);
  assert.match(start, /\$savedErrorActionPreference = \$ErrorActionPreference/);
  assert.match(start, /\$ErrorActionPreference = 'Continue'/);
  assert.match(start, /\$buildExitCode = \$LASTEXITCODE/);
  assert.match(start, /if \(\$buildExitCode -ne 0\)/);
  assert.match(start, /d1 migrations apply discipline-db[\s\S]*--local[\s\S]*--persist-to \$persistDir/);
  assert.match(start, /wrangler@4\.125\.0', 'dev'[\s\S]*'--persist-to', \$persistDir/);
  assert.match(start, /REFERRAL_EVIDENCE_HMAC_KEYRING_JSON=/);
  assert.match(start, /REFERRAL_EVIDENCE_REPLAY_PEPPER=/);
  assert.match(start, /'--env-file', \$qaVarsFile/);
  assert.match(start, /--mode', 'test'/);
  assert.match(start, /\$expectedTestApiUrl = "http:\/\/127\.0\.0\.1:\$workerPort"/);
  assert.match(start, /\$env:VITE_API_URL = \$expectedTestApiUrl/);
  assert.match(start, /\$priorViteApiUrlExists/);
  assert.match(start, /Remove-Item Env:VITE_API_URL/);
  assert.match(start, /v1\/pvp\/readiness/);
  assert.match(start, /v1\/auth\/register/);
  assert.match(start, /registration\.ok -ne \$true -or -not \$registration\.token/);
  assert.match(start, /tcp:\$workerPort" "tcp:\$workerPort/);
  assert.match(start, /reverse --list/);
  assert.match(start, /function Remove-AdbReverseIfPresent/);
  assert.match(start, /\$ErrorActionPreference = 'SilentlyContinue'/);
  assert.match(start, /install -r \$ApkPath/);
  assert.doesNotMatch(start, /emulator|avd|emulator-555/iu);
});

test('physical PvP QA preserves full adb mDNS serials that contain spaces', () => {
  assert.match(start, /function Get-AdbSerialFromDeviceRow/);
  assert.match(start, /\$serials \| Where-Object \{ \$_ -ceq \$RequestedSerial \}/);
  assert.match(start, /return \$serials\[0\]/);
  assert.doesNotMatch(start, /\$rows\[0\] -split/);

  if (process.platform !== 'win32') return;
  const command = [
    '$tokens=$null',
    '$errors=$null',
    `$ast=[System.Management.Automation.Language.Parser]::ParseFile(${psLiteral(startPath)},[ref]$tokens,[ref]$errors)`,
    "if($errors.Count){throw ($errors | Out-String)}",
    "$fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-AdbSerialFromDeviceRow'},$true)",
    "if($null -eq $fn){throw 'serial parser function not found'}",
    'Invoke-Expression $fn.Extent.Text',
    "Get-AdbSerialFromDeviceRow -Row 'adb-2120016025078605-RZ4SZ9 (2)._adb-tls-connect._tcp device product:foo model:B1660V transport_id:2'",
  ].join('; ');
  const parsed = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
  ], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(parsed, 'adb-2120016025078605-RZ4SZ9 (2)._adb-tls-connect._tcp');
});

test('physical PvP QA rejects stale listeners and dead helper processes', () => {
  assert.match(start, /Get-NetTCPConnection -State Listen -LocalPort \$port/);
  assert.match(start, /TCP port \$port is already occupied/);
  assert.match(start, /\$process\.HasExited/);
  assert.match(start, /refusing a stale-listener false positive/);
  assert.match(start, /startedAtUtc/);
  assert.match(stop, /actualStart[\s\S]*startedAtUtc/);
  assert.match(stop, /Refusing to stop reused PID/);
  assert.match(stop, /taskkill\.exe \/PID \$process\.Id \/T \/F/);
});

test('physical PvP QA can hold and monitor helper lifetime for agent-driven testing', () => {
  assert.match(start, /\$holdOpenFile = Join-Path \$runtimeDir 'hold-open'/);
  assert.match(start,
    /while \(Test-Path -LiteralPath \$holdOpenFile\)[\s\S]*?\$process\.Refresh\(\)[\s\S]*?\$process\.HasExited/);
  assert.match(start, /QA helper process .* exited while physical QA was active/);
});

test('failure cleanup removes an installed reverse mapping and spawned helpers', () => {
  const catchBlock = start.slice(start.lastIndexOf('catch {'));
  assert.match(catchBlock, /Remove-AdbReverseIfPresent -DeviceSerial \$Serial -Port \$workerPort/);
  assert.match(catchBlock, /taskkill\.exe \/PID \$process\.Id \/T \/F/);
});
