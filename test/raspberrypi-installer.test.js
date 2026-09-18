// ---------------------------------------------------------
// Проверки установщика устройства LIMS-USB
// ---------------------------------------------------------
// Функции берутся из текущего .sh, файлы создаются во временных каталогах.
// APT, systemd, cron и GPIO подменяются; реальная установка и перезагрузка не выполняются.
// Проверяются продолжение, сохранность настроек, USB-образ, служба и отмена через Ctrl+C.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{spawnSync}=require('child_process');
const test=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../dist/pdb-install-raspberrypi.sh'),'utf8');
const helpers=source.slice(source.indexOf('set -Eeuo'),source.indexOf('\nif [ "$EUID"'));
const bash=process.env.BASH_EXE || (process.platform==='win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
function run(input,cwd){return spawnSync(bash,['-s'],{cwd,input,encoding:'utf8',timeout:10000});}
function fixture(name,fn){test(name,()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pdb-pi-test-')).replaceAll('\\','/');try{fs.mkdirSync(dir+"/state/done",{recursive:true});const pre=helpers+`
state_dir="$PWD/state"
data_dir="$PWD/data"
PATH_PDB="$PWD/pdb"
PATH_USB="$PWD/piusb.bin"
PATH_CLONE_TO="$PWD"
ID=debian
VERSION_ID=12
architecture=arm64
flock() { return 0; }
install(){ if [ "$1" = -d ]; then shift 3; mkdir -p "$@"; else builtin command install "$@"; fi; }
command() { if [ "$#" -eq 2 ] && [ "$1" = -v ] && [ "$2" = projectdb ]; then return 1; fi; builtin command "$@"; }
mkdir -p "$state_dir/done" "$PATH_PDB"
`;fn(dir,pre);}finally{fs.rmSync(dir,{recursive:true,force:true});}});}
function ok(r){assert.equal(r.status,0,r.stdout+r.stderr);}
function bad(r){assert.notEqual(r.status,0);assert.match(r.stdout,/ERROR/);}
test('Raspberry Pi: Bash syntax',()=>{const syntax=spawnSync(bash,['-n'],{input:source,encoding:'utf8'});ok(syntax);});
fixture('answers saved; password absent from output; resume without questions',(dir,p)=>{let r=run(p+`load_or_create_plan <<'ANS'
lims.example.org
DEVICE-01
secret"with\\characters
Y
ANS
`,dir);ok(r);assert.ok(!r.stdout.includes('secret'));let plan=fs.readFileSync(dir+'/state/plan','utf8');assert.ok(plan.includes('secret'));r=run(p+'load_or_create_plan </dev/null\n[ "$DEVICE_NAME" = DEVICE-01 ]\n[ "$resuming" = yes ]\n',dir);ok(r);assert.ok(!r.stdout.includes('secret'));});
fixture('reject invalid plan and cross-OS resume',(dir,p)=>{for(const plan of ['1\ndebian\n12\narm64\nx\n../bad\nsecret\n','1\ndebian\n13\narm64\nx\nDEVICE\nsecret\n','1\ndebian\n12\narm64\nx\nDEVICE\n\n']){fs.writeFileSync(dir+'/state/plan',plan);bad(run(p+'load_or_create_plan </dev/null\n',dir));}});
fixture('closed input stops before saved plan',(dir,p)=>{bad(run(p+'load_or_create_plan </dev/null\n',dir));assert.equal(fs.existsSync(dir+'/state/plan'),false);});
fixture('refused confirmation leaves no plan',(dir,p)=>{bad(run(p+"load_or_create_plan <<< $'host\\nDEVICE\\nsecret\\nn'\n",dir));assert.equal(fs.existsSync(dir+'/state/plan'),false);});
fixture('failed action resumes without repeating successful action',(dir,p)=>{const flow=`first(){ echo first >> calls; }
fragile(){ echo fragile >> calls; test -f allow; }
workflow(){ run_once first first; run_once fragile fragile; }
run_stage device Device workflow
`;bad(run(p+flow,dir));assert.equal(fs.existsSync(dir+'/state/done/stage-device'),false);fs.writeFileSync(dir+'/allow','');ok(run(p+flow,dir));ok(run(p+flow,dir));assert.equal(fs.readFileSync(dir+'/calls','utf8'),'first\nfragile\nfragile\n');});
fixture('concurrent run blocked',(dir,p)=>{bad(run(p+'flock(){ return 1; }\ninit_state\n',dir));});
fixture('completed installation cleanup and repeat protection',(dir,p)=>{ok(run(p+'save_state plan secret\nsave_state complete complete\ninit_state\nprintf UNREACHABLE\n',dir));assert.equal(fs.existsSync(dir+'/state/plan'),false);assert.deepEqual(fs.readdirSync(dir+'/state').sort(),['complete','lock']);});
fixture('failed state flush leaves no completed marker',(dir,p)=>{bad(run(p+'sync(){ return 7; }\nmark_done action\n',dir));assert.equal(fs.existsSync(dir+'/state/done/action'),false);});
fixture('JSON quotes and password protection',(dir,p)=>{const r=run(p+`SERVER_LIMS=lims.example.org
PASSWORD='secret"quote\\slash'
DEVICE_NAME=DEVICE
configure_connection
configure_connection
`,dir);ok(r);const c=JSON.parse(fs.readFileSync(dir+'/pdb/tmp/server/DEVICE/cli.json'));assert.equal(c.password,'secret"quote\\slash');assert.ok(!r.stdout.includes('secret'));});
fixture('USB image interrupted before rename, then resumed',(dir,p)=>{const mock=`run_command(){ "$@"; }
dd(){ for a in "$@"; do case "$a" in of=*) printf image > "$(echo "$a" | cut -c4-)";; esac; done; }
mkdosfs(){ test -f allow; }
`;bad(run(p+mock+'prepare_usb_image\n',dir));assert.equal(fs.existsSync(dir+'/piusb.bin'),false);assert.equal(fs.existsSync(dir+'/piusb.bin.pending'),false);fs.writeFileSync(dir+'/allow','');ok(run(p+mock+'prepare_usb_image\n',dir));assert.equal(fs.readFileSync(dir+'/piusb.bin','utf8'),'image');});
fixture('already renamed USB image reused after interruption',(dir,p)=>{fs.writeFileSync(dir+'/piusb.bin','image');ok(run(p+'save_state usb-image-owned yes\nstat(){ echo 2147483648; }\nfsck.fat(){ return 0; }\nrun_command(){ echo SHOULD_NOT_RUN; return 99; }\nprepare_usb_image\n',dir));});
fixture('unowned USB image and pending file preserved',(dir,p)=>{for(const name of ['piusb.bin','piusb.bin.pending']){fs.writeFileSync(dir+'/'+name,'existing');bad(run(p+'prepare_usb_image\n',dir));assert.equal(fs.readFileSync(dir+'/'+name,'utf8'),'existing');fs.unlinkSync(dir+'/'+name);}});
fixture('USB runtime script is replaced, syntax valid, intentional clearing retained',(dir,p)=>{ok(run(p+'write_usb_script\nwrite_usb_script\n',dir));const s=fs.readFileSync(dir+'/virtual-usb.sh','utf8');assert.equal((s.match(/#!\/bin\/bash/g)||[]).length,1);assert.match(s,/mkdosfs.*PATH_USB/);assert.ok(s.includes('rm -rf -- "$PATH_CLONE_TO/$( basename "$PATH_USB_MOUNT" )"'));});
fixture('cron keeps unrelated entries and removes duplicate USB jobs',(dir,p)=>{let text=p;fs.writeFileSync(dir+'/cron','0 0 * * * echo keep\n@reboot sudo /opt/virtual-usb.sh > /dev/null 2>&1\n');ok(run(text+`crontab(){ if [ "$1" = -l ]; then cat cron; else cp "$1" cron; fi; }
systemctl(){ return 0; }
configure_usb_cron
configure_usb_cron
`,dir));const c=fs.readFileSync(dir+'/cron','utf8');assert.match(c,/echo keep/);assert.equal((c.match(/@reboot/g)||[]).length,1);});
fixture('cron read errors cannot erase existing jobs',(dir,p)=>{bad(run(p+'crontab(){ if [ "$1" = -l ]; then echo denied >&2; return 1; fi; echo OVERWRITE >&3; }\nconfigure_usb_cron\n',dir));});
for(const failure of ['none','gpio','verify','reload','enable'])fixture('service generation '+failure,(dir,p)=>{let input=p.replace('/etc/systemd/system/$service_name','$PWD/$service_name');input+=`
DEVICE_NAME=DEVICE
PATH_PDB=/tmp
command(){ if [ "$2" = raspi-gpio ] && [ '${failure}' = gpio ]; then return 1; fi; echo /usr/bin/bash; }
readlink(){ echo /usr/bin/bash; }
systemd-analyze(){ echo VERIFY; [ '${failure}' != verify ]; }
systemctl(){ echo "SYSTEMCTL:$*"; case "$1" in daemon-reload) [ '${failure}' != reload ];; enable) [ '${failure}' != enable ];; esac; }
configure_projectdb_service
`;const r=run(input,dir);if(failure==='none'){ok(r);assert.equal(fs.readFileSync(dir+'/data/raspberrypi-device','utf8'),'DEVICE\n');const s=fs.readFileSync(dir+'/pdb.DEVICE.service','utf8');assert.match(s,/Environment=PDB_METRIC=raspberrypi/);assert.match(s,/Type=exec/);assert.match(s,/^ExecStop=\/bin\/sh -c '.*kill -INT "\$\$1".*while kill -0.*' -- \$MAINPID$/m);assert.match(s,/^TimeoutStopSec=30s$/m);assert.doesNotMatch(s,/SuccessExitStatus|KillMode=none/);assert.match(s,/ExecStart="\/usr\/bin\/bash" "\/usr\/bin\/bash" start "DEVICE"/);}else bad(r);if(['gpio','verify','reload'].includes(failure))assert.ok(!r.stdout.includes('SYSTEMCTL:enable'));});
fixture('Ctrl+C stops waiting without completed stage',(dir,p)=>{let input=p.replace('/usr/bin/setsid --wait','command')+`
stop_command(){ if [ -n "$command_pid" ]; then kill -TERM "$command_pid" 2>/dev/null || true; wait "$command_pid" 2>/dev/null || true; command_pid=""; fi; }
(sleep 0.2; kill -INT "$$") &
run_stage long Long run_command /usr/bin/sleep 20
`;const r=run(input,dir);assert.equal(r.status,130,r.stdout+r.stderr);assert.equal(fs.existsSync(dir+'/state/done/stage-long'),false);});
test('Raspberry Pi: verification before completion and reboot; no UPS',()=>{
assert.ok(source.indexOf('save_state complete complete')>source.lastIndexOf('run_stage verification'));
assert.ok(source.lastIndexOf('systemctl reboot')>source.indexOf('cleanup_completed_state\nunset PASSWORD'));
assert.ok(!/UPS_INSTALL|i2cset|power-control/.test(source));
});
// Адреса принимаются с HTTP/HTTPS; домен без схемы сохраняется с HTTPS.
for(const address of ["lims.example.org", "https://lims.example.org", "http://192.168.1.10:8080"]) {
 fixture('server address '+address,(dir,p)=>{
  const r=run(p+"load_or_create_plan <<'ANS'\n"+address+"\nDEVICE\nsecret\ny\nANS\n",dir);ok(r);
  const saved=fs.readFileSync(dir+'/state/plan','utf8').split('\n')[4];
  assert.equal(saved,address.includes('://')?address:'https://'+address);
 });
}
fixture('server address rejects credentials, paths and invalid ports',(dir,p)=>{
 for(const value of ['https://user:pass@host','https://host/path','host:0','host:65536','ftp://host','http://https://host','host with space']) {
  ok(run(p+"if valid_server '"+value+"'; then exit 8; fi\n",dir));
 }
});
test('device password is entered visibly',()=>{
 assert.match(source,/read -r PASSWORD/);
 assert.doesNotMatch(source,/read -rs PASSWORD|password \(hidden\)/);
});

// ---------------------------------------------------------
// Синхронизация USB: выполняем текущий скрипт с подменой устройств
// ---------------------------------------------------------
// Образ, монтирование, GPIO и системные команды заменены фикстурами.
// Содержимое virtual-usb.sh в установщике не изменяется.
const usbSource = source.match(/<<'PDB_USB'\n([\s\S]*?)\nPDB_USB/)[1];
for (const scenario of ['unchanged', 'normal', 'burst', 'reload-error', 'stat-error', 'watch-error', 'flush-error', 'mount-error', 'copy-error', 'unmount-error', 'write-during-copy']) {
  fixture('USB synchronization: ' + scenario, (dir) => {
    const script = usbSource
      .replace('PATH_USB=/opt/piusb.bin', 'PATH_USB="$PWD/image"')
      .replace('PATH_USB_MOUNT=/mnt/usb', 'PATH_USB_MOUNT="$PWD/mount/usb"')
      .replace('PATH_CLONE_TO=/opt', 'PATH_CLONE_TO="$PWD/clone"');
    fs.writeFileSync(dir + '/version', 'v1\n');
    const mocks = [
      'HOME="$PWD/home"',
      'scenario=' + scenario,
      'flock(){ return 0; }',
      'mkdosfs(){ echo FORMAT >> calls; }',
      'modprobe(){ echo CONNECT >> calls; }',
      'sleep(){ :; }',
      'systemctl(){ [ "$scenario" != reload-error ]; }',
      // stat вызывается в подстановке команд: счётчики хранятся в файлах, а не в переменных оболочки.
      'stat(){ if [ "$scenario" = stat-error ] && [ ! -f stat-failed ]; then touch stat-failed; return 1; fi; cat version; }',
      'inotifywait(){',
      '  echo WATCH >> calls',
      '  if [ "$(wc -l < calls)" -gt 100 ]; then exit 90; fi',
      '  if [ "$scenario" = unchanged ]; then printf "FINAL:%s\\n" "$last_synced"; exit 0; fi',
      '  if [ ! -f changed ]; then echo v2 > version; touch changed; return 0; fi',
      '  if [ "$scenario" = burst ] && [ ! -f burst ]; then echo v3 > version; touch burst; return 0; fi',
      '  if [ "$scenario" = watch-error ] && [ ! -f watch-failed ]; then touch watch-failed; return 1; fi',
      '  if [ -f copied ] && [ ! -f mounted ] && [ "$last_synced" = "$(cat version)" ]; then printf "FINAL:%s\\n" "$last_synced"; exit 0; fi',
      '  return 2',
      '}',
      'sync(){ echo FLUSH >> calls; if [ "$scenario" = flush-error ] && [ ! -f flush-failed ]; then touch flush-failed; return 1; fi; }',
      'mountpoint(){ test -f mounted; }',
      'mount(){ echo "MOUNT:$*" >> calls; if [ "$scenario" = mount-error ] && [ ! -f mount-failed ]; then touch mount-failed; return 1; fi; touch mounted; }',
      'umount(){ echo UNMOUNT >> calls; if [ "$scenario" = unmount-error ] && [ ! -f unmount-failed ]; then touch unmount-failed; return 1; fi; command rm -f mounted; }',
      'rsync(){',
      '  echo "COPY:$*" >> calls',
      '  if [ "$scenario" = copy-error ] && [ ! -f copy-failed ]; then touch copy-failed; return 1; fi',
      '  if [ "$scenario" = write-during-copy ] && [ ! -f new-write ]; then echo v3 > version; touch new-write; fi',
      '  touch copied',
      '}',
      ''
    ].join('\n');
    const result = run(mocks + script, dir);
    ok(result);
    const calls = fs.readFileSync(dir + '/calls', 'utf8').split('\n');
    const copies = calls.filter(line => line.startsWith('COPY:'));
    assert.equal(calls.filter(line => line === 'FORMAT').length, 1);
    assert.ok(calls.indexOf('FORMAT') < calls.indexOf('CONNECT'));
    assert.equal(fs.existsSync(dir + '/mounted'), false);
    if (scenario === 'unchanged') {
      assert.equal(copies.length, 0);
      assert.match(result.stdout, /FINAL:v1/);
    } else {
      assert.equal(copies.length, ['copy-error', 'unmount-error', 'write-during-copy'].includes(scenario) ? 2 : 1);
      assert.ok(result.stdout.includes(['burst', 'write-during-copy'].includes(scenario) ? 'FINAL:v3' : 'FINAL:v2'));
      assert.ok(copies.every(line => line.startsWith('COPY:-a --delete ')));
      assert.ok(calls.filter(line => line.startsWith('MOUNT:')).every(line => line.startsWith('MOUNT:-o ro ')));
    }
    if (scenario.endsWith('-error')) assert.match(result.stderr, /failed/);
  });
}

// Ошибка сериализации или записи не должна заменить рабочую конфигурацию пустым файлом.
for (const failure of ['serialize', 'flush']) fixture('connection preserves existing file on ' + failure + ' failure', (dir, pre) => {
  const folder = dir + '/pdb/tmp/server/LIMS-USB';
  fs.mkdirSync(folder, {recursive: true});
  const original = '{"host":"https://old.example.org","password":"keep"}\n';
  fs.writeFileSync(folder + '/cli.json', original);
  const mock = failure === 'serialize' ? 'node(){ return 9; }' : 'sync(){ return 9; }';
  bad(run(pre + '\n' + mock + '\nconfigure_connection\n', dir));
  assert.equal(fs.readFileSync(folder + '/cli.json', 'utf8'), original);
  assert.deepEqual(fs.readdirSync(folder), ['cli.json']);
});
