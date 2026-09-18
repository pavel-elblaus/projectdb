// ---------------------------------------------------------
// Проверки установщиков Debian и Ubuntu
// ---------------------------------------------------------

// Запуск: npm test. Каждый test описывает отдельную проверку; циклы повторяют её для разных ОС и входных данных.
// Функции берутся из текущих .sh и выполняются через Bash. Пакетные команды обычно подменены, файлы создаются временно.
// Проверки сигналов запускают настоящие тестовые процессы; Linux-проверки групп пропускаются в Windows.
// assert сравнивает полученный результат с ожидаемым: несовпадение означает провал теста.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const bash = process.env.BASH_EXE || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const repo = path.resolve(__dirname, '..');
// Выполнение сценария и сбор результата для проверок ниже.
function run(script, cwd) {
  script=script.replaceAll('data_dir="$HOME/.projectdb"','data_dir="$PWD/.projectdb-test"');
  // В обычных сценариях IPv6 включён; проверки состояния ядра задают отдельные фикстуры.
  script=script.replace('load_or_create_plan() {', 'ipv6_enabled() { return 0; }\nload_or_create_plan() {');
  return spawnSync(bash, ['-s'], {cwd, input: script, encoding: 'utf8'});
}

// ---------------------------------------------------------
// Синтаксис, swap и подсчёт шагов
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  const swapStart = source.indexOf('configure_swap() {');
  const swapEnd = source.indexOf('\n}\n', swapStart) + 3;
  const swap = source.slice(swapStart, swapEnd) + '\nstart_step "Configuring swap memory"\nconfigure_swap\n';
  // Проверка синтаксиса .sh: Bash должен разобрать файл без выполнения установки.
  test(`${os}: Bash syntax`, () => {
    const result = spawnSync(bash, ['-n', `dist/pdb-install-${os}.sh`], {cwd: repo, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  });
  for (const scenario of ['percent25', 'percent100', 'new', 'grow', 'shrink', 'same', 'inactive', 'other-swap', 'swapoff-failure', 'disk-full', 'swapon-failure', 'invalid-memory']) {
    // Создание, увеличение, уменьшение и повторное подключение swap; ошибки диска и команд не должны приводить к ложному успеху.
    test(`${os}: swap ${scenario}`, () => {
      const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
      try {
        const root = dir.replaceAll('\\', '/');
        const swapPath = root + '/swapfile';
        const percent = scenario === 'percent25' ? 25 : scenario === 'percent100' ? 100 : 50;
        const expectedSize = 16 * 1024 * percent / 100;
        const existing = !['percent25', 'percent100', 'new', 'other-swap', 'invalid-memory'].includes(scenario);
        const size = scenario === 'shrink' ? 32768 : ['same', 'inactive'].includes(scenario) ? 8192 : 4096;
        if (existing) fs.writeFileSync(path.join(dir, 'swapfile'), Buffer.alloc(size, 42));
        fs.writeFileSync(path.join(dir, 'meminfo'), `MemTotal: ${scenario === 'invalid-memory' ? 'invalid' : '16'} kB\n`);
        fs.writeFileSync(path.join(dir, 'fstab'), `# preserved\n/dev/other none swap sw 0 0\n${swapPath} none swap sw 0 0\n${swapPath} none swap sw 0 0\n`);
        fs.writeFileSync(path.join(dir, 'active'), existing && scenario !== 'inactive' ? swapPath + '\n' : '/dev/other\n');
        const mocks = `
swap_percent=${percent}
findmnt(){ return 0; }
chattr() { :; }
mkswap() { echo "mkswap $*" >> calls; }
swapon() {
  if [ "$1" = --show=NAME ]; then cat active; return; fi
  echo "swapon $*" >> calls
  ${scenario === 'swapon-failure' ? 'return 7' : 'printf "%s\\n" "$1" > active'}
}
swapoff() {
  echo "swapoff $*" >> calls
  ${scenario === 'swapoff-failure' ? 'return 9' : ': > active'}
}
${scenario === 'disk-full' ? 'dd() { echo technical-disk-error; return 8; }' : ''}
exec > technical.log 2>&1
`;
        const body = swap.replaceAll('/proc/meminfo', root + '/meminfo').replaceAll('/etc/fstab', root + '/fstab').replaceAll('/swapfile', root + '/swapfile');
        let result = run(helpers + '\n' + mocks + '\n' + body + '\nprogress "$total_steps" "Finished"\n', dir);
        const failing = ['swapoff-failure', 'disk-full', 'swapon-failure', 'invalid-memory'].includes(scenario);
        assert.equal(result.status === 0, !failing, result.stdout + result.stderr + fs.readFileSync(path.join(dir, 'technical.log'), 'utf8'));
        assert.equal(result.stdout.includes('technical-disk-error'), false);
        const calls = fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8') : '';
        if (failing) {
          assert.match(result.stdout, /ERROR/);
          assert.doesNotMatch(result.stdout, /100%/);
          if (['swapoff-failure', 'disk-full'].includes(scenario)) {
            assert.equal(fs.statSync(path.join(dir, 'swapfile')).size, size);
            assert.equal(fs.readFileSync(path.join(dir, 'swapfile'))[0], 42);
            assert.equal(fs.readFileSync(path.join(dir, 'active'), 'utf8').trim(), swapPath);
          }
        } else {
          assert.equal(fs.statSync(path.join(dir, 'swapfile')).size, expectedSize);
          assert.equal(fs.readFileSync(path.join(dir, 'active'), 'utf8').trim(), swapPath);
          const fstab = fs.readFileSync(path.join(dir, 'fstab'), 'utf8');
          assert.equal(fstab.split('\n').filter(line => line.startsWith(swapPath + ' ')).length, 1);
          assert.match(fstab, /\/dev\/other none swap/);
          assert.match(result.stdout, /100%/);
          if (scenario === 'same') assert.equal(calls, '');
          else assert.equal(calls.split('\n').filter(line => line.startsWith('mkswap ')).length, 1);
          // Re-running with an already correct active file must not disable or format it.
          fs.writeFileSync(path.join(dir, 'calls'), '');
          result = run(helpers + '\n' + mocks + '\n' + body, dir);
          assert.equal(result.status, 0, result.stdout + result.stderr);
          assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8'), '');
        }
        assert.equal(fs.readdirSync(dir).some(name => name.includes('.projectdb.')), false);
      } finally {
        fs.rmSync(dir, {recursive: true, force: true});
      }
    });
  }
  // Ошибка внутри конвейера должна остановить этап; технические подробности остаются вне строки прогресса.
  test(`${os}: pipeline errors stop installation and stay out of progress`, () => {
    const result = run(helpers + '\nexec >/dev/null 2>&1\nstart_step "Test stage"\nfalse | cat\nprintf "UNREACHABLE" >&3\n', repo);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /ERROR.*Test stage/);
    assert.doesNotMatch(result.stdout, /UNREACHABLE|100%/);
  });
  // Для четырёх сочетаний Nginx/PostgreSQL число шагов и единственная отметка 100% должны быть правильными.
  test(`${os}: progress for every component selection`, () => {
    for (const nginx of [0, 1]) for (const pg of [0, 1]) {
      const total = 8 + nginx + pg;
      const result = run(helpers + `\ntotal_steps=${total}\nexec >/dev/null 2>&1\nfor ((i=0; i<total_steps; i++)); do start_step "Stage"; done\nprogress "$total_steps" "Finished"\n`, repo);
      assert.equal(result.status, 0, result.stderr);
      assert.equal((result.stdout.match(/Step /g) || []).length, total);
      assert.equal((result.stdout.match(/100%/g) || []).length, 1);
    }
  });
}

// ---------------------------------------------------------
// Передача результата общим загрузчиком
// ---------------------------------------------------------

// Общий загрузчик должен вернуть код дочернего установщика: как успех, так и ошибку.
test('launcher: preserves installer exit status', () => {
  const source = fs.readFileSync(path.join(repo, 'dist/pdb-install.sh'), 'utf8');
  const start = source.indexOf('    install_status=0');
  assert.ok(start >= 0);
  const body = source.slice(start, source.indexOf('  else', start));
  for (const status of [0, 23]) {
    const result = run(`set -Eeuo pipefail\ntype=debian\ninstaller_file=unused\nbash() { return ${status}; }\nrm() { :; }\n` + body, repo);
    assert.equal(result.status, status, result.stderr);
  }
});

// ---------------------------------------------------------
// Ответы на вопросы установщика
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  // Неверный ответ вызывает повтор вопроса; ответы Y и N принимаются так же, как строчные.
  test(`${os}: prompts retry invalid input and accept uppercase answers`, () => {
    const result = run(helpers + '\nask_yes_no "Install?" nginx <<< $\'invalid\\nY\'\nprintf "selected=%s" "$nginx"\n', repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Please enter y or n/);
    assert.match(result.stdout, /selected=yes/);
  });
  // Закрытый ввод должен завершить опрос английской ошибкой, а не запустить установку без ответа.
  test(`${os}: missing input reports an English error`, () => {
    const result = run(helpers + '\nask_yes_no "Install?" nginx </dev/null\n', repo);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /ERROR.*No answer received/);
  });
}

// ---------------------------------------------------------
// Матрица поддерживаемых ОС
// ---------------------------------------------------------

// Поддерживаемые ОС принимаются, остальные отклоняются до вопросов и действий установщика.
test('installers: supported OS matrix and early rejection', () => {
  const cases = [
    ['debian', '10', 'buster', null],
    ['debian', '11', 'bullseye', null],
    ['debian', '12', 'bookworm', 'debian'],
    ['debian', '13', 'trixie', 'debian'],
    ['debian', '13', 'bookworm', null],
    ['debian', '12', 'trixie', null],
    ['debian', '14', 'forky', null],
    ['ubuntu', '20.04', 'focal', null],
    ['ubuntu', '22.04', 'jammy', 'ubuntu'],
    ['ubuntu', '24.04', 'noble', 'ubuntu'],
    ['ubuntu', '24.04', 'jammy', null],
    ['ubuntu', '22.04', 'noble', null],
    ['ubuntu', '26.04', 'resolute', null],
    ['linuxmint', '22.04', 'jammy', null],
    ['debian', '10', 'bookworm', null],
    ['', '', '', null],
  ];
  for (const installer of ['launcher', 'debian', 'ubuntu']) {
    const filename = installer === 'launcher' ? 'pdb-install.sh' : `pdb-install-${installer}.sh`;
    const source = fs.readFileSync(path.join(repo, 'dist', filename), 'utf8');
    const syntax = spawnSync(bash, ['-n', `dist/${filename}`], {cwd: repo, encoding: 'utf8'});
    assert.equal(syntax.status, 0, syntax.stderr);
    const validation = installer === 'launcher'
      ? source.slice(source.indexOf('case "${ID:-}'), source.indexOf('# Проверка завершения установки'))
      : source.slice(source.indexOf('# Проверка поддерживаемой ОС'), source.indexOf('# Запрос параметров установки'));
    for (const [id, version, codename, accepted] of cases) {
      const script = `ID='${id}'\nVERSION_ID='${version}'\nVERSION_CODENAME='${codename}'\ncodename="$VERSION_CODENAME"\nfail() { exit "$1"; }\n` + validation + '\necho ACCEPTED\n';
      const result = run(script, repo);
      const expected = accepted !== null && (installer === 'launcher' || accepted === installer);
      assert.equal(result.status === 0, expected, `${installer}: ${id} ${version} ${codename}: ${result.stdout} ${result.stderr}`);
      assert.equal(result.stdout.includes('ACCEPTED'), expected);
    }
  }
});

// Minimal terminal model for the carriage return and erase-line commands we emit.
// Модель строк терминала: учитывает перерисовку, чтобы сравнить то, что увидел бы пользователь.
function terminalLines(output) {
  const rows = [''];
  let column = 0;
  for (let i = 0; i < output.length; i++) {
    if (output.startsWith('\x1b[2K', i)) {
      rows[rows.length - 1] = '';
      i += 3;
    } else if (output[i] === '\r') {
      column = 0;
    } else if (output[i] === '\n') {
      rows.push('');
      column = 0;
    } else {
      const row = rows.length - 1;
      rows[row] = rows[row].padEnd(column, ' ').slice(0, column) + output[i] + rows[row].slice(column + 1);
      column++;
    }
  }
  return rows.filter(row => row !== '');
}

// ---------------------------------------------------------
// Вывод прогресса и обработка завершения
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  const screen = helpers + '\nprogress_interactive=yes\nCOLUMNS=120\nexec >/dev/null 2>&1\n';
  // Сообщения выводятся над полосой прогресса, чтобы этап не смешивался с обычным текстом.
  test(`${os}: interactive progress stays below messages`, () => {
    const result = run(screen + 'start_step "First"\nui_message "Message one\\nMessage two\\n"\nstart_step "Second"\nui_message "Ready\\n"\nprogress "$total_steps" "Finished"\nfinish_progress\n', repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\x1b\[2K/);
    const rows = terminalLines(result.stdout);
    assert.deepEqual(rows.slice(0, -1), ['Message one', 'Message two', 'Ready']);
    assert.match(rows.at(-1), /^\[#{20}\]\s+100% Finished$/);
    assert.equal(rows.filter(row => row.startsWith('[')).length, 1);
    assert.ok(result.stdout.endsWith('\n'));
  });
  // Длинная строка ограничивается шириной окна и перерисовывается после изменения размера.
  test(`${os}: progress clips to terminal width and redraws on resize`, () => {
    const result = run(screen + 'COLUMNS=40\nprogress 1 "A very long installation stage that cannot fit on the screen"\nCOLUMNS=30\nkill -WINCH "$$"\nfinish_progress\n', repo);
    assert.equal(result.status, 0, result.stderr);
    const rows = terminalLines(result.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].length, 29);
  });
  for (const [event, expected] of [['false', 1], ['kill -INT "$$"', 130], ['kill -TERM "$$"', 143], ['kill -HUP "$$"', 129]]) {
    // При ошибке, Ctrl+C, TERM и HUP строка очищается, а код завершения соответствует причине остановки.
    test(`${os}: interactive progress clears on ${event}`, () => {
      const result = run(screen + 'start_step "Working"\n' + event + '\nprintf "UNREACHABLE" >&3\n', repo);
      assert.equal(result.status, expected, result.stderr);
      const rows = terminalLines(result.stdout);
      assert.equal(rows.length, event === 'false' ? 1 : 2);
      if (event !== 'false') assert.equal(rows[0], 'Stopping installation. Please wait...');
      assert.match(rows.at(-1), /^\[ERROR\] Working/);
      assert.doesNotMatch(result.stdout, /100%|UNREACHABLE/);
      assert.ok(result.stdout.endsWith('\n'));
    });
  }
  // При записи вывода в файл не должны появляться управляющие последовательности терминала.
  test(`${os}: redirected output stays readable without terminal escapes`, () => {
    const result = run(helpers + '\nexec >/dev/null 2>&1\nstart_step "First"\nui_message "Message\\n"\nprogress "$total_steps" "Finished"\nfinish_progress\n', repo);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\x1b|\r/);
    assert.equal(result.stdout.trim().split('\n').length, 3);
    assert.match(result.stdout, /100% Finished\n$/);
  });
}

// Извлечение нужной функции из .sh; проверяется актуальный код установщика, а не отдельная копия.
function installerFunctions(source, name) {
  const start = source.indexOf(name + '() {');
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
}

// ---------------------------------------------------------
// Состояние установки и повторный запуск
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  function fixture(action) {
    const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
    try {
      const root = dir.replaceAll('\\', '/');
      // Git Bash has no flock; lock refusal is checked independently below.
      const prelude = helpers + `\nstate_dir='${root}/state'\nID=${os}\nVERSION_ID=${os === 'debian' ? '12' : '22.04'}\nflock() { return 0; }\ninstall() { if [ "$1" = -d ]; then shift 3; mkdir -p "$@"; else command install "$@"; fi; }\n`;
      // Наличие ProjectDB на машине не должно менять сценарий чистой установки.
      // Отдельный тест существующей установки объявляет функцию projectdb явно.
      const isolatedPrelude = prelude + `
command() {
  if [ "$#" -eq 2 ] && [ "$1" = -v ] && [ "$2" = projectdb ]; then
    declare -F projectdb >/dev/null
  else
    builtin command "$@"
  fi
}
`;
      action(dir, isolatedPrelude, root);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }
  // Ломаем действие в середине этапа и продолжаем: завершённые действия не повторяются, незавершённое выполняется снова.
  test(`${os}: failed installation resumes at the unfinished action`, () => fixture((dir, prelude) => {
    const workflow = `
init_state
load_or_create_plan <<< $'y\\nn\\n22\\n50\\ny'
exec > technical.log 2>&1
first() { echo first >> calls; }
part() { echo part >> calls; }
fragile() { echo fragile >> calls; [ -f allow ]; }
last() { echo last >> calls; }
second() { run_once part part; run_once fragile fragile; }
run_stage first First first
run_stage second Second second
run_stage last Last last
save_state complete complete
`;
    let result = run(prelude + workflow, dir);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(dir, 'state/done/stage-first')), true);
    assert.equal(fs.existsSync(path.join(dir, 'state/done/stage-second')), false);
    assert.equal(fs.existsSync(path.join(dir, 'state/complete')), false);
    fs.writeFileSync(path.join(dir, 'allow'), '');
    result = run(prelude + workflow.replace("load_or_create_plan <<< $'y\\nn\\n22\\n50\\ny'", 'load_or_create_plan </dev/null'), dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Resuming|Previously completed/);
    assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8'), 'first\npart\nfragile\nfragile\nlast\n');
    assert.equal(fs.existsSync(path.join(dir, 'state/complete')), true);
    result = run(prelude + workflow, dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /already completed successfully/);
    assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8'), 'first\npart\nfragile\nfragile\nlast\n');
  }));
  // Продолжение показывает Skipped для старых этапов и Done только для выполненного сейчас.
  test(`${os}: resumed progress names skipped stages without false Done messages`, () => fixture((dir, prelude) => {
    fs.mkdirSync(path.join(dir, 'state/done'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'state/done/stage-first'), 'complete');
    fs.writeFileSync(path.join(dir, 'state/done/stage-second'), 'complete');
    const result = run(prelude + '\nprogress_interactive=yes\nCOLUMNS=120\nexec >/dev/null 2>&1\nrun_stage first First false\nrun_stage second Second false\nrun_stage third Third true\nprogress 3 "Next stage"\nfinish_progress\n', dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const rows = terminalLines(result.stdout);
    assert.deepEqual(rows.slice(0,-1), ['  Skipped: First', '  Skipped: Second', '  Done: Third']);
    assert.match(rows.at(-1), /37% Next stage/);
    assert.doesNotMatch(result.stdout, /Done: First|Done: Second|Previously completed/);
  }));
  // Продолжение читает сохранённые ответы без опроса; настройки другой версии ОС отклоняются.
  test(`${os}: saved choices are restored without asking again`, () => fixture((dir, prelude) => {
    let result = run(prelude + "init_state\nload_or_create_plan <<< $'y\\nn\\n22\\n50\\ny'\n", dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    result = run(prelude + 'init_state\nload_or_create_plan </dev/null\nprintf "choices=%s/%s" "$nginx" "$postgresql"\n', dir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /choices=yes\/no/);
    assert.doesNotMatch(result.stdout, /\[y\/n\]/);
    result = run(prelude + 'VERSION_ID=99\ninit_state\nload_or_create_plan </dev/null\n', dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /do not match/);
  }));
  // Имитируем занятую блокировку: второй установщик должен остановиться до вопросов и создания плана.
  test(`${os}: concurrent installer is refused before asking questions`, () => fixture((dir, prelude) => {
    const result = run(prelude + 'flock() { return 1; }\ninit_state\necho UNREACHABLE\n', dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /already running/);
    assert.doesNotMatch(result.stdout, /UNREACHABLE/);
    assert.equal(fs.existsSync(path.join(dir, 'state/plan')), false);
  }));
  // Наличие ProjectDB без плана восстановления запрещает автоматическую повторную установку.
  test(`${os}: existing installation without saved state is protected`, () => fixture((dir, prelude) => {
    const result = run(prelude + 'projectdb() { :; }\ninit_state\necho UNREACHABLE\n', dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /no resumable installation state/);
    assert.doesNotMatch(result.stdout, /UNREACHABLE/);
    assert.equal(fs.existsSync(path.join(dir, 'state/plan')), false);
  }));
  // В запрос APT входят только отсутствующие и недоустановленные пакеты; готовые не запрашиваются повторно.
  test(`${os}: fully installed packages are excluded from apt requests`, () => fixture((dir, prelude) => {
    const result = run(prelude + `
dpkg-query() {
  case "$3" in
    ready) printf 'install ok installed' ;;
    partial) printf 'install ok unpacked' ;;
    missing) return 1 ;;
  esac
}
apt-get() { printf '%s\\n' "$*" >> calls; }
install_missing ready partial missing
install_missing ready
`, dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8'), '-y --no-upgrade install partial missing\n');
  }));
  // Ошибка после настройки базы не должна менять пароль или повторять уже завершённые действия при продолжении.
  test(`${os}: database password and completed configuration survive a later failure`, () => fixture((dir, prelude) => {
    const functions = ['gen_pass', 'create_database', 'configure_postgresql'].map(name => installerFunctions(source, name)).join('\n');
    const workflow = `
init_state
pg_port=5780
start_postgresql() { echo start >> calls; }
prepare_postgresql_config() { echo config >> calls; }
pg_ctlcluster() { echo restart >> calls; }
sudo() {
  if [[ "$*" == *"db_name="* ]]; then
    cat > database-sql
    echo database >> calls
  elif [ "$3" = psql ]; then
    printf '%s' "$pg_pass" > applied-password
    echo password >> calls
  else
    echo ready >> calls
    [ -f allow ]
  fi
}
exec > technical.log 2>&1
run_stage pg Database configure_postgresql
`;
    let result = run(prelude + functions + workflow, dir);
    assert.notEqual(result.status, 0);
    const password = fs.readFileSync(path.join(dir, 'state/pg-password'), 'utf8').trim();
    assert.match(password, /^[A-Za-z0-9]{20}$/);
    assert.equal(fs.readFileSync(path.join(dir, 'applied-password'), 'utf8'), password);
    fs.writeFileSync(path.join(dir, 'allow'), '');
    result = run(prelude + functions + workflow, dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'state/pg-password'), 'utf8').trim(), password);
    assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8'), 'start\npassword\nconfig\nrestart\nready\nready\ndatabase\n');
  }));
}

// ---------------------------------------------------------
// Продолжение настройки Nginx и пакетов
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  // После сбоя сохраняется первая резервная копия Nginx, а выполненные действия конфигурации пропускаются.
  test(`${os}: Nginx resume keeps original backup and skips completed configuration`, () => {
    const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
    try {
      const root = dir.replaceAll('\\', '/');
      fs.mkdirSync(path.join(dir, 'state/done'), {recursive: true});
      fs.mkdirSync(path.join(dir, 'nginx/conf.d'), {recursive: true});
      fs.writeFileSync(path.join(dir, 'nginx/nginx.conf'), 'original');
      fs.writeFileSync(path.join(dir, 'projectdb.conf'), 'projectdb');
      const functions = ['prepare_nginx_config', 'prepare_nginx_tls', 'configure_nginx'].map(name => installerFunctions(source, name)).join('\n')
        .replaceAll('/etc/nginx', root + '/nginx')
        .replaceAll('/usr/lib/node_modules/projectdb/dist/nginx.conf', root + '/projectdb.conf');
      const workflow = helpers + `\nstate_dir='${root}/state'\n` + functions + `
run_command() { "$@"; }
openssl() {
  if [ "$2" = -out ]; then
    echo generate >> calls
    echo dhparam > "$3"
    [ -f allow ]
  fi
}
install() { shift 2; cp "$@"; }
systemctl() { echo "$*" >> calls; }
nginx() { echo check >> calls; }
exec > technical.log 2>&1
run_stage nginx Nginx configure_nginx
`;
      let result = run(workflow, dir);
      assert.notEqual(result.status, 0);
      assert.equal(fs.readFileSync(path.join(dir, '.projectdb-test/backup/nginx.conf.original'), 'utf8'), 'original');
      assert.equal(fs.existsSync(path.join(dir, 'state/done/nginx-config')), true);
      assert.equal(fs.existsSync(path.join(dir, 'state/done/nginx-tls')), false);
      // A completed configuration must not be overwritten by the resumed stage.
      fs.writeFileSync(path.join(dir, 'nginx/nginx.conf'), 'kept');
      fs.writeFileSync(path.join(dir, 'allow'), '');
      result = run(workflow, dir);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(fs.readFileSync(path.join(dir, 'nginx/nginx.conf'), 'utf8'), 'kept');
      assert.equal(fs.readFileSync(path.join(dir, '.projectdb-test/backup/nginx.conf.original'), 'utf8'), 'original');
      assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8'), 'generate\ngenerate\nenable nginx.service\ncheck\nrestart nginx.service\n');
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });
  // Восстановление настраивает незавершённые пакеты; исправное состояние не требует повторной настройки.
  test(`${os}: package recovery configures only unfinished packages`, () => {
    const result = run(helpers + `
dpkg-query() { :; }
dpkg() {
  case "$1" in
    --audit) if [ "$test_pending" = yes ]; then echo interrupted; fi ;;
    --configure) echo configure >&3; test_pending=no ;;
  esac
}
apt-get() { return 0; }
test_pending=no
recover_packages
printf 'SEPARATOR\\n' >&3
test_pending=yes
recover_packages
`, repo);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('SEPARATOR\n'));
    assert.equal((result.stdout.match(/configure/g) || []).length, 1);
  });
}

for (const installer of ['launcher', 'debian', 'ubuntu']) {
  const filename = installer === 'launcher' ? 'pdb-install.sh' : `pdb-install-${installer}.sh`;
  const source = fs.readFileSync(path.join(repo, 'dist', filename), 'utf8');
  const cleanup = installerFunctions(source, 'cleanup_completed_state');
  // После успеха удаляются данные восстановления, но остаются complete и lock; ссылки не должны затронуть посторонние файлы.
  test(`${installer}: successful cleanup removes recovery data and preserves restart protection`, () => {
    const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
    try {
      const root = dir.replaceAll('\\', '/');
      const state = path.join(dir, 'state');
      fs.mkdirSync(path.join(state, 'done'), {recursive: true});
      for (const name of ['lock', 'pg-password', 'plan', 'nginx.conf.original', 'dhparam.pem.pending', '.state.abcd', '.nginx-backup.abcd']) {
        fs.writeFileSync(path.join(state, name), 'saved');
      }
      fs.writeFileSync(path.join(state, 'done/stage-nginx'), 'complete');
      fs.writeFileSync(path.join(dir, 'unrelated'), 'keep');
      const script = `set -eu\nstate_dir='${root}/state'\n` + cleanup + '\ncleanup_completed_state\n';
      // An incomplete installation must retain everything needed for recovery.
      let result = run(script, dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(state, 'pg-password'), 'utf8'), 'saved');
      assert.equal(fs.existsSync(path.join(state, 'done/stage-nginx')), true);
      fs.writeFileSync(path.join(state, 'complete'), 'complete');
      // Simulate a cleanup interruption; the success marker must survive.
      result = run(script.replace('cleanup_completed_state\n', 'find() { return 7; }\ncleanup_completed_state\n'), dir);
      assert.equal(result.status, 7);
      assert.equal(fs.existsSync(path.join(state, 'complete')), true);
      result = run(script, dir);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readdirSync(state).sort(), ['complete', 'lock']);
      assert.equal(fs.readFileSync(path.join(dir, 'unrelated'), 'utf8'), 'keep');
      // Retrying cleanup after success is harmless and does not recreate checkpoints.
      result = run(script, dir);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readdirSync(state).sort(), ['complete', 'lock']);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });
}

// ---------------------------------------------------------
// Запись состояния, firewall и итоговые проверки
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  // Ошибка сброса состояния на диск не должна оставлять отметку завершённого действия.
  test(`${os}: failed state flush cannot mark an action complete`, () => {
    const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
    try {
      const script = helpers + '\nstate_dir="$PWD"\nmkdir done\nsync() { return 7; }\nmark_done test\nprintf UNREACHABLE >&3\n';
      const result = run(script, dir);
      assert.equal(result.status, 7, result.stderr);
      assert.equal(fs.existsSync(path.join(dir, 'done/test')), false);
      assert.doesNotMatch(result.stdout, /UNREACHABLE/);
      assert.equal(fs.readdirSync(dir).some(name => name.startsWith('.state.')), false);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });
  for (const ssh of ['203.0.113.1 45678 203.0.113.2 22', '']) {
    // Разрешение SSH должно выполняться до запрета входящих соединений, включая запуск из локальной консоли.
    test(`${os}: firewall preserves SSH before deny (${ssh || 'local'})`, () => {
      const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
      try {
        const script = helpers + '\n' + installerFunctions(source, 'configure_firewall').replaceAll('/usr/sbin/sshd', 'sshd') + `
SSH_CONNECTION='${ssh}'
sshd() { return 0; }
ss() { echo LISTEN; }
backup_config() { :; }
run_once() { shift; "$@"; }
ufw() { printf '%s\n' "$*" >> calls; }
configure_firewall
`;
        const result = run(script, dir);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8');
        assert.ok(calls.indexOf('allow 22') >= 0);
        assert.ok(calls.indexOf('allow 22') < calls.indexOf('default deny incoming'));
        assert.match(calls, /--force enable\n$/);
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    });
  }
  for (const failed of ['', 'node', 'projectdb', 'php7.2', 'nginx', 'systemctl', 'sudo']) {
    // Поочерёдно ломаем проверки компонентов: любой отказ должен помешать успешному завершению установки.
    test(`${os}: final verification ${failed ? 'rejects ' + failed + ' failure' : 'accepts healthy components'}`, () => {
      const script = helpers + '\n' + installerFunctions(source, 'verify_installation') + `
nginx=yes
postgresql=yes
pg_port=5780
` + ['node', 'projectdb', 'php7.2', 'nginx', 'systemctl', 'sudo'].map(name => `${name}() { return ${name === failed ? 8 : 0}; }`).join('\n') + '\nverify_installation\nprintf VERIFIED >&3\n';
      const result = run(script, repo);
      assert.equal(result.status, failed ? 8 : 0, result.stderr);
      if (failed) {
        assert.match(result.stdout, /ERROR.*Verifying installation/);
        assert.doesNotMatch(result.stdout, /VERIFIED/);
      } else assert.match(result.stdout, /VERIFIED/);
    });
  }
  // В исходнике итоговые проверки должны предшествовать показу пароля, отметке успеха и очистке.
  test(`${os}: final checks precede credentials, completion and cleanup`, () => {
    const body = source.slice(source.indexOf('# Последовательное выполнение этапов'));
    assert.ok(body.indexOf('\nrun_stage verification ') < body.indexOf("ui_message '\\nPostgreSQL"));
    assert.ok(body.indexOf('\nrun_stage verification ') < body.indexOf('save_state complete'));
    assert.ok(body.indexOf('save_state complete') < body.indexOf('\ncleanup_completed_state'));
  });
}

// ---------------------------------------------------------
// Совпадение общей логики Debian и Ubuntu
// ---------------------------------------------------------

// Сравниваем общие функции двух .sh, чтобы исправление одной ОС не потерялось во второй.
test('installers: shared functions stay identical between operating systems', () => {
  const debian = fs.readFileSync(path.join(repo, 'dist/pdb-install-debian.sh'), 'utf8');
  const ubuntu = fs.readFileSync(path.join(repo, 'dist/pdb-install-ubuntu.sh'), 'utf8');
  for (const [, name] of debian.matchAll(/^(\w+)\(\) \{/gm)) {
    if (['add_php_repository', 'add_nginx_repository', 'add_pg_repository'].includes(name)) continue;
    assert.equal(installerFunctions(debian, name), installerFunctions(ubuntu, name), name);
  }
});

// ---------------------------------------------------------
// Подключение NodeSource
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  for (const failed of [false, true]) {
    // Проверяем Node.js 18, ограничение доверия ключу репозитория и остановку при ошибке его загрузки.
    test(`${os}: NodeSource key download ${failed ? 'failure stops stage' : 'keeps Node 18 and scopes trust'}`, () => {
      const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
      try {
        const root = dir.replaceAll('\\', '/');
        const fn = installerFunctions(source, 'add_node_repository').replaceAll('/usr/share/keyrings', root + '/keys').replaceAll('/etc/apt/preferences.d', root + '/preferences');
        const script = helpers + '\n' + fn + `
state_dir="$PWD"
apt="$PWD/sources"
mkdir sources preferences
printf old > sources/nodesource.sources
dpkg() { echo amd64; }
install() { if [ "$1" = -d ]; then shift 3; mkdir -p "$@"; else shift 2; cp "$@"; fi; }
curl() { ${failed ? 'return 22' : 'printf KEY'}; }
gpg() { cat; }
add_node_repository
`;
        const result = run(script, dir);
        assert.equal(result.status, failed ? 22 : 0, result.stdout + result.stderr);
        assert.equal(fs.existsSync(path.join(dir, 'sources/nodesource.sources')), failed);
        if (failed) assert.equal(fs.existsSync(path.join(dir, 'sources/nodesource.list')), false);
        else {
          const repoSource = fs.readFileSync(path.join(dir, 'sources/nodesource.list'), 'utf8');
          assert.match(repoSource, /node_18\.x nodistro main/);
          assert.match(repoSource, /signed-by=/);
        }
        assert.equal(fs.readdirSync(dir).some(name => name.startsWith('.node-key.')), false);
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    });
  }
}

// ---------------------------------------------------------
// Защита текущего SSH по IPv6
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  // При текущем SSH по IPv6 сеть нельзя менять: установщик должен сначала отказать с пояснением.
  test(`${os}: IPv6 SSH is rejected before changing network settings`, () => {
    const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
    const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
    const script = helpers + '\n' + installerFunctions(source, 'configure_network') + '\nSSH_CONNECTION="2001:db8::1 50000 2001:db8::2 22"\ntee() { printf NETWORK_CHANGED >&3; }\nsysctl() { printf NETWORK_CHANGED >&3; }\nconfigure_network\n';
    const result = run(script, repo);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Reconnect over IPv4/);
    assert.doesNotMatch(result.stdout, /NETWORK_CHANGED/);
  });
}

// ---------------------------------------------------------
// Значения по умолчанию и выбор SSH-порта
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  // Пустой ответ на вопрос о компоненте означает согласие на установку.
  test(`${os}: Enter defaults component prompts to yes`, () => {
    const result = run(helpers + '\nask_yes_no Install nginx <<< ""\nprintf "choice=%s" "$nginx" >&3\n', repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[Y\/n\]/);
    assert.match(result.stdout, /choice=yes/);
  });
  for (const [input, expected] of [['', '22'], ['2222', '2222'], ['00022', '22'], ['65535', '65535'], ['0\n65536\n-1\nabc\n22/tcp\n2222', '2222']]) {
    // Проверяем порт по умолчанию, границы диапазона и ведущие нули; неверный ввод запрашивается повторно.
    test(`${os}: SSH prompt validates ${JSON.stringify(input)}`, () => {
      const result = run(helpers + `\nask_ssh_port <<'INPUT'\n${input}\nINPUT\nprintf 'port=%s' "$ssh_port" >&3\n`, repo);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp('port=' + expected + '$'));
      assert.match(result.stdout, /will be allowed in the firewall/);
      if (input.includes('\n')) assert.equal((result.stdout.match(/Please enter a port/g) || []).length, 5);
    });
  }
  // Закрытый ввод не равен нажатию Enter: порт 22 нельзя выбирать без полученного ответа.
  test(`${os}: SSH prompt does not default on closed input`, () => {
    const result = run(helpers + '\nask_ssh_port </dev/null\n', repo);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /No answer received/);
  });
  for (const scenario of ['new', 'legacy', 'invalid']) {
    // Новый план сохраняет выбранный порт, старый получает 22, повреждённое значение отклоняется.
    test(`${os}: SSH port saved plan ${scenario}`, () => {
      const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
      try {
        const version = os === 'debian' ? '12' : '22.04';
        if (scenario !== 'new') fs.writeFileSync(path.join(dir, 'plan'), `${scenario === 'legacy' ? '1' : '2'}\n${os}\n${version}\n17\nyes\nno\n${scenario === 'invalid' ? '70000\n' : ''}`);
        const prelude = helpers + `\nstate_dir="$PWD"\nID=${os}\nVERSION_ID=${version}\n`;
        let result = run(prelude + (scenario === 'new' ? "load_or_create_plan <<< $'\\n\\n\\n\\n2222\\n50\\ny\\ny'\n" : 'load_or_create_plan </dev/null\n') + 'printf "port=%s" "$ssh_port" >&3\n', dir);
        assert.equal(result.status, scenario === 'invalid' ? 1 : 0, result.stdout + result.stderr);
        if (scenario === 'invalid') { assert.match(result.stdout, /saved SSH port is invalid/); return; }
        const expected = scenario === 'legacy' ? '22' : '2222';
        assert.equal(fs.readFileSync(path.join(dir, 'plan'), 'utf8').split('\n')[6], expected);
        result = run(prelude + 'load_or_create_plan </dev/null\nprintf "port=%s" "$ssh_port" >&3\n', dir);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp('port=' + expected));
        assert.doesNotMatch(result.stdout, /Which SSH port|Install the/);
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    });
  }
  // В firewall должен попасть выбранный пользователем порт 2222, а не фиксированный 22.
  test(`${os}: selected SSH port is the firewall rule`, () => {
    const script = helpers + '\n' + installerFunctions(source, 'configure_firewall').replaceAll('/usr/sbin/sshd','sshd') + '\nsshd(){ return 0; }\nss(){ echo listener; }\nbackup_config(){ :; }\nssh_port=2222\nrun_once() { shift; "$@"; }\nufw() { printf "rule:%s\\n" "$*" >&3; }\nconfigure_firewall\n';
    const result = run(script, repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /rule:allow 2222\/tcp/);
    assert.doesNotMatch(result.stdout, /rule:allow 22(?:\/tcp)?\n/);
  });
}

// ---------------------------------------------------------
// Анимация и таймер текущего этапа
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  const screen = helpers + '\nprogress_interactive=yes\nCOLUMNS=100\nexec >/dev/null 2>&1\n';
  // Во время молчащей команды индикатор продолжает обновляться и останавливается перед итоговым выводом.
  test(`${os}: animation updates during a silent command and stops before final output`, () => {
    const result = run(screen + `
start_step First
worker="$animation_pid"
sleep 1.3
ui_message 'Still working\n'
start_step Second
progress "$total_steps" Finished
finish_progress
sleep 0.3
if kill -0 "$worker" 2>/dev/null; then exit 9; fi
printf FINAL >&3
`, repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /First [|/\\-] 00:01/);
    assert.match(result.stdout, /Second [|/\\-] 00:00/);
    assert.ok(new Set([...result.stdout.matchAll(/First ([|/\\-]) /g)].map(match => match[1])).size > 1);
    const rows = terminalLines(result.stdout);
    assert.deepEqual(rows, ['Still working', '[####################] 100% Finished', 'FINAL']);
  });
  // При длинном названии этапа обрезается текст, но остаётся видимый таймер.
  test(`${os}: timer remains visible when a long step label is clipped`, () => {
    const result = run(screen + `
COLUMNS=40
start_step 'A very long stage label that does not fit'
stop_animation
step_started=$((SECONDS - 65))
draw_progress
finish_progress
`, repo);
    assert.equal(result.status, 0, result.stderr);
    const rows = terminalLines(result.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].length, 39);
    assert.match(rows[0], /01:05$/);
  });
  // Возврат из завершённого этапа не должен оставлять работающий процесс анимации.
  test(`${os}: stage completion stops animation before returning`, () => {
    const result = run(screen + `
state_dir=/nonexistent-projectdb-test
mark_done() { :; }
work() { worker="$animation_pid"; sleep 0.3; }
run_stage test Test work
if kill -0 "$worker" 2>/dev/null; then exit 9; fi
[ -z "$animation_pid" ]
[ "$step_active" = no ]
progress "$total_steps" Finished
finish_progress
`, repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Done: Test/);
  });
}

// ---------------------------------------------------------
// Выбор swap, продолжение и вывод ошибок
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  // Enter даёт 50%; дроби, текст и значения вне диапазона отклоняются, целый процент принимается.
  test(`${os}: swap percentage prompt defaults and retries invalid values`, () => {
    for (const [input, expected] of [['', 50], ['-1\n101\nabc\n25.5\n025', 25], ['100', 100]]) {
      const result = run(helpers + `\nask_swap_percent <<'INPUT'\n${input}\nINPUT\nprintf 'percent=%s' "$swap_percent" >&3\n`, repo);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp('percent=' + expected + '$'));
      if (input.includes('\n')) assert.equal((result.stdout.match(/Please enter a whole number/g) || []).length, 4);
    }
    const result = run(helpers + '\nask_swap_percent </dev/null\n', repo);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /No answer received/);
  });
  for (const scenario of ['new', 'legacy', 'invalid']) {
    // Проверяем сохранение процента swap, совместимость старого плана и отказ при повреждённом значении.
    test(`${os}: swap percentage plan ${scenario}`, () => {
      const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
      try {
        const version = os === 'debian' ? '12' : '22.04';
        if (scenario !== 'new') fs.writeFileSync(path.join(dir, 'plan'), `${scenario === 'legacy' ? 2 : 3}\n${os}\n${version}\n17\nyes\nyes\n2222\n${scenario === 'invalid' ? '101\n' : ''}`);
        const prelude = helpers + `\nstate_dir="$PWD"\nID=${os}\nVERSION_ID=${version}\n`;
        let result = run(prelude + (scenario === 'new' ? "load_or_create_plan <<< $'\\n\\n\\n\\n2222\\n25\\ny'\n" : 'load_or_create_plan </dev/null\n'), dir);
        assert.equal(result.status, scenario === 'invalid' ? 1 : 0, result.stdout + result.stderr);
        if (scenario === 'invalid') { assert.match(result.stdout, /saved swap size \(% of RAM\) is invalid/); return; }
        const expected = scenario === 'legacy' ? 50 : 25;
        assert.equal(fs.readFileSync(path.join(dir, 'plan'), 'utf8').split('\n')[7], String(expected));
        result = run(prelude + 'load_or_create_plan </dev/null\nprintf "percent=%s" "$swap_percent" >&3\n', dir);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp('percent=' + expected));
        assert.doesNotMatch(result.stdout, /Swap file size/);
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    });
  }
  // Даже с отметкой завершённой проверки продолжение обязано проверить результат заново.
  test(`${os}: final verification is never skipped on resume`, () => {
    const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'done'));
      fs.writeFileSync(path.join(dir, 'done/stage-verification'), 'complete');
      const result = run(helpers + '\nstate_dir="$PWD"\nrun_stage verification "Verifying installation" false\n', dir);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /ERROR.*Verifying installation/);
      assert.doesNotMatch(result.stdout, /Skipped|100%/);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });
  // Сообщение об ошибке не должно повторять путь журнала, уже показанный в начале.
  test(`${os}: error output does not repeat the log path`, () => {
    const result = run(helpers + '\nlog_file=/var/log/example.log\nui_message "Installation log: %s\\n" "$log_file"\nfail 130\n', repo);
    assert.equal(result.status, 130);
    assert.equal((result.stdout.match(/\/var\/log\/example.log/g) || []).length, 1);
    assert.doesNotMatch(source, /\(already completed\)|\(this run\)|ui_message '  (?:Swap file configured|Checking installed)/);
  });
}

// ---------------------------------------------------------
// Восстановление пакетного менеджера
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  for (const scenario of ['broken-dependencies', 'configure-failure', 'repair-failure', 'still-pending']) {
    // Моделируем сломанные зависимости, ошибку настройки, неудачное исправление и оставшиеся проблемы после восстановления.
    test(`${os}: recovery handles ${scenario}`, () => {
      const script = helpers + `
exec >/dev/null 2>&1
broken=yes
mock_pending=${scenario === 'configure-failure' || scenario === 'still-pending' ? 'yes' : 'no'}
dpkg-query() { :; }
dpkg() {
  case "$1" in
    --audit) if [ "$mock_pending" = yes ]; then echo unfinished; fi ;;
    --configure)
      if [ "$broken" = yes ] && [ '${scenario}' = configure-failure ]; then return 7; fi
      if [ '${scenario}' != still-pending ]; then mock_pending=no; fi
      ;;
  esac
}
apt-get() {
  if [ "$1" = check ]; then [ "$broken" = no ]; return; fi
  printf 'REPAIR:%s\\n' "$*" >&3
  ${scenario === 'repair-failure' ? 'return 9' : 'broken=no'}
}
recover_packages
printf 'READY:%s' "$step" >&3
`;
      const result = run(script, repo);
      const failed = ['repair-failure', 'still-pending'].includes(scenario);
      assert.equal(result.status === 0, !failed, result.stdout + result.stderr);
      assert.match(result.stdout, /REPAIR:-y --no-remove -f install/);
      assert.doesNotMatch(result.stdout, /--no-upgrade/);
      if (failed) {
        assert.match(result.stdout, /ERROR.*Recovering packages/);
        assert.doesNotMatch(result.stdout, /READY|Done:/);
      } else {
        assert.match(result.stdout, /Done: Recovering packages/);
        assert.match(result.stdout, /READY:0$/);
      }
    });
  }
  // Пока настройка пакетов ничего не выводит, этап восстановления должен показывать работающий таймер.
  test(`${os}: recovery animates while package configuration is silent`, () => {
    const result = run(helpers + `
progress_interactive=yes
COLUMNS=100
exec >/dev/null 2>&1
mock_pending=yes
dpkg-query() { :; }
dpkg() {
  case "$1" in
    --audit) if [ "$mock_pending" = yes ]; then echo unfinished; fi ;;
    --configure) sleep 1.2; mock_pending=no ;;
  esac
}
apt-get() { return 0; }
recover_packages
[ -z "$animation_pid" ]
[ "$step_active" = no ]
printf FINISHED >&3
`, repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Recovering packages [|/\\-] 00:01/);
    assert.deepEqual(terminalLines(result.stdout), ['  Done: Recovering packages', 'FINISHED']);
  });
}

// ---------------------------------------------------------
// Остановка рабочих команд и коды завершения
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  // Реальный Bash получает INT во время ожидания: сообщение об отмене должно появиться без ожидания всей команды.
  test(`${os}: command wait reacts immediately to Ctrl+C`, () => {
    // Git Bash lacks setsid; this check exercises the real wait and signal handler with one child.
    const script = helpers.replace('/usr/bin/setsid --wait', 'command') + `
exec >/dev/null 2>&1
stop_command() {
  if [ -n "$command_pid" ]; then
    kill -TERM "$command_pid" 2>/dev/null || true
    wait "$command_pid" 2>/dev/null || true
    command_pid=""
  fi
}
stage="Updating the system"
(sleep 0.3; kill -INT "$$") &
run_command /usr/bin/sleep 20
printf UNREACHABLE >&3
`;
    const started = Date.now();
    const result = spawnSync(bash, ['-s'], {cwd: repo, input: script, encoding: 'utf8', timeout: 5000});
    assert.equal(result.status, 130, result.stdout + result.stderr);
    assert.ok(Date.now() - started < 5000);
    assert.match(result.stdout, /Stopping installation/);
    assert.match(result.stdout, /ERROR.*Updating the system.*cancelled/);
    assert.doesNotMatch(result.stdout, /UNREACHABLE/);
  });
  // Проверяем последовательность TERM, ограниченного ожидания и KILL только для группы рабочей команды.
  test(`${os}: command termination is bounded and scoped to its process group`, () => {
    const result = run(helpers + `
command_pid=12345
kill() { printf 'KILL:%s\\n' "$*" >&3; }
sleep() { printf 'TICK\\n' >&3; }
wait() { return 0; }
stop_command
[ -z "$command_pid" ]
`, repo);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stdout.match(/TICK/g) || []).length, 50);
    assert.match(result.stdout, /^KILL:-TERM -- -12345/);
    assert.match(result.stdout, /KILL:-KILL -- -12345/);
    assert.doesNotMatch(result.stdout, /KILL:.*(?:apt|dpkg)/);
  });
  // Ненулевой код рабочей команды возвращается вызывающему коду и не заменяется успешным завершением.
  test(`${os}: command exit status is preserved`, () => {
    const result = run(helpers.replace('/usr/bin/setsid --wait', 'command') + `
if run_command /usr/bin/bash -c 'exit 7'; then exit 9; else code=$?; fi
[ "$code" = 7 ]
[ -z "$command_pid" ]
`, repo);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
  // Только Linux: запускаем настоящую группу, игнорирующую TERM, и проверяем завершение отмены в пределах тайм-аута.
  test(`${os}: Linux command group stops even when SIGTERM is ignored`, {skip: process.platform !== 'linux'}, () => {
    const script = helpers + `
exec >/dev/null 2>&1
(sleep 0.5; kill -INT "$$") &
run_command /usr/bin/bash -c 'trap "" TERM INT; while :; do sleep 0.2; done'
`;
    const result = spawnSync(bash, ['-s'], {cwd: repo, input: script, encoding: 'utf8', timeout: 9000});
    assert.equal(result.status, 130, result.stdout + result.stderr);
    assert.match(result.stdout, /Stopping installation/);
  });
}

// ---------------------------------------------------------
// Настройки и продолжение на Ubuntu 24.04
// ---------------------------------------------------------

// Для Ubuntu 24.04 в файлах источников должны использоваться noble и noble-pgdg.
test('ubuntu 24.04: repositories use noble and noble-pgdg', () => {
  const source = fs.readFileSync(path.join(repo, 'dist/pdb-install-ubuntu.sh'), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
  try {
    const script = helpers + '\n' + ['add_nginx_repository', 'add_pg_repository'].map(name => installerFunctions(source, name)).join('\n') + `
codename=noble
apt="$PWD"
gpg="$PWD"
curl() { printf key; }
gpg() { cat; }
add_nginx_repository
add_pg_repository
`;
    const result = run(script, dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'nginx.list'), 'utf8'), 'deb https://nginx.org/packages/ubuntu noble nginx\n');
    assert.equal(fs.readFileSync(path.join(dir, 'pgdg.list'), 'utf8'), 'deb https://apt.postgresql.org/pub/repos/apt noble-pgdg main\n');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// План Ubuntu 24.04 должен восстановить компоненты, SSH и swap без новых вопросов.
test('ubuntu 24.04: installation choices resume on the same OS', () => {
  const source = fs.readFileSync(path.join(repo, 'dist/pdb-install-ubuntu.sh'), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'plan'), '3\nubuntu\n24.04\n17\nyes\nyes\n22\n33\n');
    const script = helpers + '\nstate_dir="$PWD"\nID=ubuntu\nVERSION_ID=24.04\nload_or_create_plan </dev/null\nprintf "choices=%s/%s/%s/%s" "$nginx" "$postgresql" "$ssh_port" "$swap_percent" >&3\n';
    const result = run(script, dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /choices=yes\/yes\/22\/33/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// ---------------------------------------------------------
// Изменение размера терминала во время команды
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"')).replace('/usr/bin/setsid --wait', 'command');
  for (const code of [0, 7]) {
    // Сигнал изменения окна во время ожидания не должен терять команду или её итоговый код 0/7.
    test(`${os}: terminal resize preserves running command and exit ${code}`, () => {
      const script = helpers + `
progress_interactive=yes
COLUMNS=100
start_step Working
(sleep 0.15; kill -WINCH "$$"; sleep 0.15; kill -WINCH "$$") &
if run_command /usr/bin/bash -c 'sleep 0.6; exit ${code}'; then actual=0; else actual=$?; fi
stop_animation
[ -z "$command_pid" ]
[ "$actual" = ${code} ]
progress "$total_steps" Finished
finish_progress
printf COMPLETED >&3
`;
      const started = Date.now();
      const result = spawnSync(bash, ['-s'], {cwd: repo, input: script, encoding: 'utf8', timeout: 5000});
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(Date.now() - started >= 550);
      assert.match(result.stdout, /COMPLETED$/);
      assert.doesNotMatch(result.stdout, /\[ERROR\]/);
      if (code) assert.match(result.stderr, /exit code 7/);
    });
  }
}

// ---------------------------------------------------------
// Обёртка APT и журнал отмены
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  // Обёртка APT отключает внутренний PTY, сохраняет границы аргументов и передаёт код ошибки.
  test(`${os}: apt disables its private terminal and preserves arguments and status`, () => {
    const script = 'set -eu\n' + installerFunctions(source, 'apt-get') + `
run_command() { printf '<%s>\\n' "$@"; return 7; }
if apt-get -y install 'package name'; then exit 9; else [ "$?" = 7 ]; fi
`;
    const result = run(script, repo);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '</usr/bin/apt-get>\n<-o>\n<Dpkg::Use-Pty=0>\n<-y>\n<install>\n<package name>\n');
  });
  // Журнал отмены должен содержать время, текущую группу процессов и результат её остановки.
  test(`${os}: cancellation is logged with timestamp and command group outcome`, () => {
    const script = helpers + `
log_file=enabled
command_pid=23456
stage="Updating the system"
kill() { if [ "$1" = -0 ]; then return 1; fi; }
wait() { return 0; }
interrupt_installation 130 'Installation cancelled by the user.'
`;
    const result = run(script, repo);
    assert.equal(result.status, 130, result.stderr);
    assert.match(result.stdout, /Stopping installation/);
    assert.match(result.stderr, /\[\d{4}-\d{2}-\d{2}T.*\] Cancellation requested: stage=Updating the system; PID=23456; exit=130/);
    assert.ok(result.stderr.indexOf('Cancellation requested') < result.stderr.indexOf('Stopping command group'));
    assert.match(result.stderr, /Command group no longer exists: 23456/);
  });
}

// ---------------------------------------------------------
// Порядок остановки анимации и команды
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  // Воспроизводим причину задержки Ctrl+C: ожидание отрисовщика не должно предшествовать остановке команды.
  test(`${os}: cancellation never waits for animation before stopping the command`, () => {
    const script = helpers + `
log_file=enabled
animation_pid=12344
command_pid=12345
stage="Updating the system"
kill() { printf 'SIGNAL:%s\\n' "$*" >&3; if [ "$1" = -0 ]; then return 1; fi; }
wait() {
  if [ "$1" = 12344 ]; then printf BAD_ANIMATION_WAIT >&3; return 9; fi
  printf 'REAP:%s\\n' "$1" >&3
}
interrupt_installation 130 'Installation cancelled by the user.'
`;
    const result = run(script, repo);
    assert.equal(result.status, 130, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /BAD_ANIMATION_WAIT/);
    assert.match(result.stdout, /SIGNAL:-KILL 12344/);
    assert.match(result.stdout, /SIGNAL:-TERM -- -12345/);
    assert.match(result.stdout, /REAP:12345/);
    assert.ok(result.stdout.indexOf('SIGNAL:-TERM -- -12345') < result.stdout.indexOf('REAP:12345'));
  });
}

// ---------------------------------------------------------
// Отключение swap и итоговое время
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', `pdb-install-${os}.sh`), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  for (const scenario of ['active', 'inactive', 'absent', 'swapoff-failure']) {
    // При 0 отключаем только управляемый swap; отсутствие файла допустимо, ошибка swapoff должна сохранить файл и fstab.
    test(`${os}: zero swap ${scenario}`, () => {
      const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
      try {
        const root = dir.replaceAll('\\', '/');
        const swapfile = root + '/swapfile';
        const active = ['active', 'swapoff-failure'].includes(scenario);
        if (scenario !== 'absent') fs.writeFileSync(path.join(dir, 'swapfile'), 'preserved');
        fs.writeFileSync(path.join(dir, 'fstab'), `# keep\n/dev/other none swap sw 0 0\n${swapfile} none swap sw 0 0\n${swapfile} none swap sw 0 0\n`);
        fs.writeFileSync(path.join(dir, 'active'), '/dev/other\n' + (active ? swapfile + '\n' : ''));
        const fn = installerFunctions(source, 'configure_swap').replaceAll('/proc/meminfo', root + '/missing-meminfo').replaceAll('/etc/fstab', root + '/fstab').replaceAll('/swapfile', swapfile);
        const script = helpers + '\n' + fn + `
swap_percent=0
findmnt(){ return 0; }
swapon() { if [ "$1" = --show=NAME ]; then cat active; else return 91; fi; }
mkswap() { return 92; }
swapoff() { ${scenario === 'swapoff-failure' ? 'return 7' : "printf '/dev/other\\n' > active"}; }
configure_swap
`;
        const result = run(script, dir);
        assert.equal(result.status, scenario === 'swapoff-failure' ? 7 : 0, result.stdout + result.stderr);
        const fstab = fs.readFileSync(path.join(dir, 'fstab'), 'utf8');
        assert.match(fstab, /\/dev\/other none swap/);
        assert.equal(fs.existsSync(path.join(dir, 'swapfile')), scenario === 'swapoff-failure');
        assert.equal(fstab.includes(swapfile), scenario === 'swapoff-failure');
        if (scenario !== 'swapoff-failure') {
          assert.equal(fs.readFileSync(path.join(dir, 'active'), 'utf8'), '/dev/other\n');
          assert.equal(run(script, dir).status, 0);
        } else assert.match(fs.readFileSync(path.join(dir, 'active'), 'utf8'), /swapfile/);
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    });
  }
  // Ответы 0, 0% и 50% распознаются; сохранённый ноль не заменяется значением по умолчанию.
  test(`${os}: swap prompt accepts percent sign and zero is restored from plan`, () => {
    for (const value of ['0', '0%', '50%']) {
      const result = run(helpers + `\nask_swap_percent <<< '${value}'\nprintf 'value=%s' "$swap_percent" >&3\n`, repo);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /\[50\]/);
      assert.ok(result.stdout.endsWith('value=' + parseInt(value)));
    }
    const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
    try {
      const version = os === 'debian' ? '12' : '24.04';
      fs.writeFileSync(path.join(dir, 'plan'), `3\n${os}\n${version}\n17\nyes\nyes\n22\n0\n`);
      const result = run(helpers + `\nstate_dir="$PWD"\nID=${os}\nVERSION_ID=${version}\nload_or_create_plan </dev/null\n[ "$swap_percent" = 0 ]\n`, dir);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });
  // Итоговое время выводится в минутах и секундах, включая продолжительность больше часа.
  test(`${os}: installation time uses total minutes and seconds`, () => {
    const start = source.indexOf("ui_message '\\nInstallation time:");
    assert.ok(start > 0);
    const summary = source.slice(start, source.indexOf('# Итоговый прогресс', start));
    for (const [elapsed, expected] of [[376, '06m 16s'], [3676, '61m 16s']]) {
      const result = run(helpers + `\ninstallation_elapsed=${elapsed}\n` + summary, repo);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '\nInstallation time: ' + expected + '\n');
    }
  });
}

// ---------------------------------------------------------
// Настройки и продолжение на Debian 13
// ---------------------------------------------------------

// Для Debian 13 источники PHP, Nginx и PostgreSQL должны содержать trixie и trixie-pgdg.
test('debian 13: repositories use trixie and trixie-pgdg', () => {
  const source = fs.readFileSync(path.join(repo, 'dist/pdb-install-debian.sh'), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
  try {
    const script = helpers + '\n' + ['add_php_repository', 'add_nginx_repository', 'add_pg_repository'].map(name => installerFunctions(source, name)).join('\n') + `
codename=trixie
apt="$PWD"
gpg="$PWD"
curl() { printf key; }
gpg() { cat; }
add_php_repository
add_nginx_repository
add_pg_repository
`;
    const result = run(script, dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'php.list'), 'utf8'), 'deb https://packages.sury.org/php/ trixie main\n');
    assert.equal(fs.readFileSync(path.join(dir, 'nginx.list'), 'utf8'), 'deb https://nginx.org/packages/debian trixie nginx\n');
    assert.equal(fs.readFileSync(path.join(dir, 'pgdg.list'), 'utf8'), 'deb https://apt.postgresql.org/pub/repos/apt trixie-pgdg main\n');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// План Debian 13 должен восстановить выбранные параметры без повторного опроса.
test('debian 13: installation choices resume on the same OS', () => {
  const source = fs.readFileSync(path.join(repo, 'dist/pdb-install-debian.sh'), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'plan'), '3\ndebian\n13\n17\nyes\nyes\n22\n33\n');
    const script = helpers + '\nstate_dir="$PWD"\nID=debian\nVERSION_ID=13\nload_or_create_plan </dev/null\nprintf "choices=%s/%s/%s/%s" "$nginx" "$postgresql" "$ssh_port" "$swap_percent" >&3\n';
    const result = run(script, dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /choices=yes\/yes\/22\/33/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

// ---------------------------------------------------------
// Сохранение пароля в .pgpass
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
  const source = fs.readFileSync(path.join(repo, 'dist', 'pdb-install-' + os + '.sh'), 'utf8');
  const helpers = source.slice(source.indexOf('set -Eeuo'), source.indexOf('if [ "$EUID"'));
  for (const mode of ['new', 'existing', 'invalid-path', 'replace-failure']) {
    // Создание и обновление .pgpass сохраняют чужие записи и права 600; ошибка замены сохраняет старый файл, пароль не выводится.
    test(os + ': pgpass ' + mode, () => {
      const dir = fs.mkdtempSync(path.join(repo, '.installer-test-'));
      try {
        const original = '# Other connections\nremote:5432:app:reader:keep\nlocalhost:5780:*:postgres:old\n127.0.0.1:5780:*:postgres:old\n';
        if (mode === 'invalid-path') fs.mkdirSync(path.join(dir, '.pgpass'));
        else if (mode !== 'new') fs.writeFileSync(path.join(dir, '.pgpass'), original);
        const script = helpers + '\n' + installerFunctions(source, 'save_pgpass') + '\n' + [
          'getent() { printf "root:x:0:0:root:%s:/bin/bash\\n" "$PWD"; }',
          'chmod() { printf "%s\\n" "$1" >> permissions; command chmod "$@"; }',
          'pg_port=5780',
          'pg_pass=0123456789abcdef0123',
          mode === 'replace-failure' ? 'mv() { return 9; }' : ':',
          'save_pgpass',
          'save_pgpass',
        ].join('\n');
        const result = run(script, dir);
        const failing = ['invalid-path', 'replace-failure'].includes(mode);
        assert.equal(result.status === 0, !failing, result.stdout + result.stderr);
        assert.doesNotMatch(result.stdout + result.stderr, /0123456789abcdef0123/);
        if (!failing) {
          const saved = fs.readFileSync(path.join(dir, '.pgpass'), 'utf8');
          assert.equal(saved, 'localhost:5780:projectdb:postgres:0123456789abcdef0123\n127.0.0.1:5780:projectdb:postgres:0123456789abcdef0123\n' + (mode === 'existing' ? '# Other connections\nremote:5432:app:reader:keep\n' : ''));
          assert.equal(fs.readFileSync(path.join(dir, 'permissions'), 'utf8'), '600\n600\n');
          if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, '.pgpass')).mode & 0o777, 0o600);
        } else if (mode === 'replace-failure') {
          assert.equal(fs.readFileSync(path.join(dir, '.pgpass'), 'utf8'), original);
        }
        assert.equal(fs.readdirSync(dir).some(name => name.startsWith('.pgpass.')), false);
      } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    });
  }
}

// ---------------------------------------------------------
// Переустановка повреждённых пакетов
// ---------------------------------------------------------

for (const os of ['debian', 'ubuntu']) {
 const source=fs.readFileSync(path.join(repo,'dist','pdb-install-'+os+'.sh'),'utf8');
 const helpers=source.slice(source.indexOf('set -Eeuo'),source.indexOf('if [ "$EUID"'));
 // Повреждённые пакеты переустанавливаются до обычной настройки; отказ переустановки не должен объявлять восстановление успешным.
 // Удалять conf.d можно только после успешного сохранения и проверки архива.
 for(const failure of [false,true]) test(os+': recovery reinstalls damaged packages before configuration '+failure,()=>{
  const script=helpers+'\n'+[
   'exec >/dev/null 2>&1',
   'damaged=yes',
   'dpkg-query() { printf "broken:amd64 iHR\\nready ii \\nother iFR\\n"; }',
   'dpkg() { if [ "$damaged" = yes ]; then if [ "$*" = "--configure -a --no-triggers" ]; then return 8; fi; echo TOO_EARLY >&3; return 8; fi; }',
   'apt-get() {',
   ' if [ "$1" = check ]; then return 0; fi',
   ' printf "REINSTALL:%s\\n" "$*" >&3',
   failure?' return 9':' damaged=no',
   '}',
   'recover_packages',
   'echo FINISHED >&3',
  ].join('\n');
  const r=run(script,repo);
  assert.equal(r.status, failure?9:0,r.stdout+r.stderr);
  assert.match(r.stdout,/REINSTALL:-y --no-remove -f --reinstall install broken:amd64 other/);
  assert.doesNotMatch(r.stdout,/TOO_EARLY/);
  assert.equal(r.stdout.includes('FINISHED'),!failure);
 });
}

// ---------------------------------------------------------
// Восстановление журнала dpkg перед повтором APT
// ---------------------------------------------------------

for(const os of ['debian','ubuntu']) {
 const source=fs.readFileSync(path.join(repo,'dist','pdb-install-'+os+'.sh'),'utf8');
 const helpers=source.slice(source.indexOf('set -Eeuo'),source.indexOf('if [ "$EUID"'));
 // Сценарий Ubuntu 22.04: после отказа APT обрабатываем журнал dpkg и повторяем переустановку повреждённого пакета.
 test(os+': recovery retries reinstall after dpkg journal recovery',()=>{
  const script=helpers+'\n'+[
   'exec >/dev/null 2>&1',
   'journal=yes',
   'damaged=yes',
   'dpkg-query() { echo "broken iFR"; }',
   'apt-get() {',
   ' if [ "$1" = check ]; then [ "$damaged" = no ]; return; fi',
   ' echo REINSTALL >&3',
   ' if [ "$journal" = yes ]; then return 100; fi',
   ' damaged=no',
   '}',
   'dpkg() {',
   ' if [ "$*" = "--configure -a --no-triggers" ]; then echo JOURNAL >&3; journal=no; return 1; fi',
   ' [ "$damaged" = no ]',
   '}',
   'recover_packages',
  ].join('\n');
  const r=run(script,repo);
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/REINSTALL\nJOURNAL\nREINSTALL/);
  assert.match(r.stdout,/Done: Recovering packages/);
 });
}

// ---------------------------------------------------------
// Выбор базы приложения, сохранение имени и безопасное создание
// ---------------------------------------------------------
for(const os of ['debian','ubuntu']) {
 const source=fs.readFileSync(path.join(repo,'dist','pdb-install-'+os+'.sh'),'utf8');
 const helpers=source.slice(source.indexOf('set -Eeuo'),source.indexOf('if [ "$EUID"'));
 for(const name of ['', 'custom_database']) test(os+': database choice '+(name||'default'),()=>{
  const dir=fs.mkdtempSync(path.join(repo,'.installer-test-'));
  try {
   const pre=helpers+'\nstate_dir="$PWD"\nID='+os+'\nVERSION_ID=12\n';
   const result=run(pre+"load_or_create_plan <<'ANS'\nn\ny\n"+name+"\n1\n22\n50\ny\nANS\n",dir);
   assert.equal(result.status,0,result.stdout+result.stderr);
   const saved=fs.readFileSync(path.join(dir,'plan'),'utf8').split('\n');
   assert.equal(saved[0],'5'); assert.equal(saved[8],name||'projectdb');
   const resumed=run(pre+'load_or_create_plan </dev/null\nprintf "DATABASE=%s" "$pg_database" >&3\n',dir);
   assert.equal(resumed.status,0,resumed.stdout+resumed.stderr);
   assert.ok(resumed.stdout.includes('DATABASE='+(name||'projectdb')));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
 });
 test(os+': invalid database names are rejected',()=>{
  const script=helpers+'\n'+["bad name", "x;DROP DATABASE postgres", "template0", "template1", "a".repeat(64)].map(n=>"if valid_database_name '"+n+"'; then exit 9; fi").join('\n');
  const result=run(script,repo);assert.equal(result.status,0,result.stdout+result.stderr);
 });
 test(os+': database creation passes a separate SQL variable and preserves existing databases',()=>{
  const fn=installerFunctions(source,'create_database');
  const r=run(helpers+'\n'+fn+'\npg_port=5780\npg_database=custom_database\nsudo(){ printf "ARG:%s\\n" "$@"; cat; }\ncreate_database\n',repo);
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/ARG:db_name=custom_database/);
  assert.match(r.stdout,/WHERE NOT EXISTS/);
  assert.match(r.stdout,/CREATE DATABASE %I/);
  assert.doesNotMatch(r.stdout,/DROP DATABASE/);
 });
}

test('bootstrap installer: Bash syntax',()=>{
 const result=spawnSync(bash,['-n','dist/pdb-install.sh'],{cwd:repo,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});

// ---------------------------------------------------------
// Сетевые параметры и проверки перед критическими изменениями
// ---------------------------------------------------------
for(const os of ['debian','ubuntu']){
 const source=fs.readFileSync(path.join(repo,'dist','pdb-install-'+os+'.sh'),'utf8');
 const helpers=source.slice(source.indexOf('set -Eeuo'),source.indexOf('if [ "$EUID"'));
 const fixture=(name,fn)=>test(os+': '+name,()=>{
  const dir=fs.mkdtempSync(path.join(repo,'.installer-test-'));
  try{fs.mkdirSync(path.join(dir,'state','done'),{recursive:true});fn(dir,helpers+'\nstate_dir="$PWD/state"\nID='+os+'\nVERSION_ID=12\n');}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
 });
 // Все сочетания ответов сохраняются и восстанавливаются без повторного опроса.
 for(const remote of ['yes','no','lan'])for(const ipv6 of ['yes','no'])fixture('network choices '+remote+'/'+ipv6,(dir,pre)=>{
  const answers=['y','y','projectdb',remote==='yes'?'3':remote==='lan'?'2':'1','22','50',ipv6==='yes'?'y':'n'];
  const r=run(pre+"load_or_create_plan <<'ANS'\n"+answers.join('\n')+"\nANS\n",dir);
  assert.equal(r.status,0,r.stdout+r.stderr);
  const plan=fs.readFileSync(path.join(dir,'state/plan'),'utf8').split('\n');assert.equal(plan[9],remote);assert.equal(plan[10],ipv6);
  const retry=run(pre+'load_or_create_plan </dev/null\nprintf "%s/%s" "$pg_remote" "$disable_ipv6" >&3\n',dir);
  assert.equal(retry.status,0,retry.stdout+retry.stderr);assert.ok(retry.stdout.endsWith(remote+'/'+ipv6));
 });
 // Enter выбирает локальную сеть и разрешает отключение IPv6; выключенный IPv6 не требует ответа.
 for (const enabled of [true, false]) fixture('IPv6 question and access defaults ' + enabled, (dir, pre) => {
  const answers = ['n', 'y', '', '', '22', '50'];
  if (enabled) answers.push('');
  const result = run(pre + '\nipv6_enabled(){ return ' + (enabled ? '0' : '1') + '; }\n' +
    "load_or_create_plan <<'ANS'\n" + answers.join('\n') + "\nANS\n", dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const plan = fs.readFileSync(path.join(dir, 'state/plan'), 'utf8').split('\n');
  assert.equal(plan[9], 'lan');
  assert.equal(plan[10], enabled ? 'yes' : 'no');
  assert.equal(result.stdout.includes('Disable IPv6? [Y/n]'), enabled);
  assert.equal(result.stdout.includes('download problems'), enabled);
 });
 // Проверяем отсутствие IPv6, полное отключение и включение хотя бы одного интерфейса.
 for (const flags of [[], ['1','1'], ['1','0'], ['0','1']]) fixture('IPv6 detection ' + flags.join('/'), (dir, pre) => {
  const root = dir.replaceAll('\\','/') + '/ipv6';
  flags.forEach((value, i) => {
    fs.mkdirSync(root + '/iface' + i, {recursive: true});
    fs.writeFileSync(root + '/iface' + i + '/disable_ipv6', value + '\n');
  });
  const fn = installerFunctions(source, 'ipv6_enabled').replaceAll('/proc/sys/net/ipv6/conf', root);
  const result = run(pre + fn + '\nif ipv6_enabled; then echo ENABLED >&3; else echo DISABLED >&3; fi\n', dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), flags.includes('0') ? 'ENABLED' : 'DISABLED');
 });
 fixture('keeping IPv6 does not change network settings',(dir,pre)=>{
  const r=run(pre+installerFunctions(source,'configure_network')+'\ndisable_ipv6=no\nSSH_CONNECTION="::1 123 ::1 22"\nsysctl(){ echo CHANGED; }\nconfigure_network\n',dir);
  assert.equal(r.status,0,r.stdout+r.stderr);assert.doesNotMatch(r.stdout,/CHANGED/);
 });
 for(const remote of ['yes','no','lan'])fixture('PostgreSQL access '+remote,(dir,pre)=>{
  const root=dir.replaceAll('\\','/');fs.mkdirSync(path.join(dir,'pg','17','main'),{recursive:true});
  for(const file of ['pg_hba.conf','postgresql.conf'])fs.writeFileSync(path.join(dir,'pg','17','main',file),'# original\n');
  const fn=installerFunctions(source,'prepare_postgresql_config').replaceAll('/etc/postgresql',root+'/pg');
  const r=run(pre+fn+'\npg_remote='+remote+'\npg_port=5780\nprepare_postgresql_config\nprepare_postgresql_config\n',dir);
  assert.equal(r.status,0,r.stdout+r.stderr);
  const hba=fs.readFileSync(path.join(dir,'pg/17/main/pg_hba.conf'),'utf8'),config=fs.readFileSync(path.join(dir,'pg/17/main/postgresql.conf'),'utf8');
  assert.ok(hba.includes(remote==='yes'?'0.0.0.0/0':remote==='lan'?'192.168.0.0/16':'127.0.0.1/32'));
  assert.ok(config.includes("listen_addresses = '"+(remote==='no'?'127.0.0.1':'*')+"'"));
  assert.equal((config.match(/listen_addresses/g)||[]).length,1);
  assert.equal(fs.readFileSync(path.join(dir,'.projectdb-test/backup/pg_hba.conf.original'),'utf8'),'# original\n');
 });
 // Ошибка записи или проверки кандидата не должна менять исходный fstab.
 for(const mode of ['valid','invalid','write-failure'])fixture('fstab validation '+mode,(dir,pre)=>{
  const original='# keep\nUUID=root / ext4 defaults 0 1\n/swapfile none swap sw 0 0\n/dev/other none swap sw 0 0\n';fs.writeFileSync(path.join(dir,'fstab'),original);
  const mocks='findmnt(){ test "$1" = --verify; test "$2" = --tab-file; '+(mode==='invalid'?'return 1;':'return 0;')+' }\n'+(mode==='write-failure'?'awk(){ echo partial; return 9; }\n':'');
  const r=run(pre+mocks+'save_swap_fstab "$PWD/fstab" /swapfile no\n',dir);
  assert.equal(r.status===0,mode==='valid',r.stdout+r.stderr);
  assert.equal(fs.readFileSync(path.join(dir,'fstab'),'utf8'),mode==='valid'?original.replace('/swapfile none swap sw 0 0\n',''):original);
  assert.equal(fs.readFileSync(path.join(dir,'.projectdb-test/backup/fstab.original'),'utf8'),original);
  assert.ok(!fs.readdirSync(dir).some(n=>n.startsWith('fstab.projectdb.')));
 });
 for(const mode of ['local','remote','lan','no-listener','invalid-sshd','wrong-port','dry-run-failure'])fixture('firewall checks '+mode,(dir,pre)=>{
  const fn=installerFunctions(source,'configure_firewall').replaceAll('/usr/sbin/sshd','sshd');
  const setup='postgresql=yes\npg_remote='+(mode==='remote'?'yes':mode==='lan'?'lan':'no')+'\npg_port=5780\nssh_port=2222\n'+
   'SSH_CONNECTION="192.0.2.1 50000 192.0.2.2 '+(mode==='wrong-port'?'22':'2222')+'"\n'+
   'backup_config(){ :; }\nrun_once(){ shift; "$@"; }\nsshd(){ '+(mode==='invalid-sshd'?'return 1;':'return 0;')+' }\n'+
   'ss(){ '+(mode==='no-listener'?':;':'echo LISTEN;')+' }\n'+
   'ufw(){ echo "$*" >> calls; '+(mode==='dry-run-failure'?'if [ "$1" = --dry-run ]; then return 1; fi;':'')+' }\n';
  const r=run(pre+fn+'\n'+setup+'configure_firewall\n',dir),success=['local','remote','lan'].includes(mode);
  assert.equal(r.status===0,success,r.stdout+r.stderr);
  const calls=fs.existsSync(path.join(dir,'calls'))?fs.readFileSync(path.join(dir,'calls'),'utf8'):'';
  assert.equal(calls.split('\n').includes('--force enable'),success);
  assert.equal(calls.includes('allow 5780/tcp'),mode==='remote');
  assert.equal(calls.includes('allow from 192.168.0.0/16 to any port 5780 proto tcp'),mode==='lan');
  if(success){assert.ok(calls.indexOf('allow 2222/tcp')<calls.indexOf('default deny incoming'));assert.ok(calls.indexOf('--dry-run --force enable')<calls.lastIndexOf('--force enable'));}
 });
 // При сохранении IPv6 проверяем, что UFW защищает и IPv6-подключения.
 for (const enabled of [true, false]) fixture('firewall IPv6 support ' + enabled, (dir, pre) => {
  const config = dir.replaceAll('\\', '/') + '/ufw-default';
  fs.writeFileSync(config, 'IPV6=' + (enabled ? 'yes' : 'no') + '\n');
  const fn = installerFunctions(source, 'configure_firewall')
    .replaceAll('/usr/sbin/sshd', 'sshd').replaceAll('/etc/default/ufw', config);
  const result = run(pre + fn + '\n' + [
    'disable_ipv6=no', 'ssh_port=22', 'SSH_CONNECTION="::1 123 ::1 22"',
    'sshd(){ :; }', 'ss(){ echo LISTEN; }', 'backup_config(){ :; }',
    'run_once(){ shift; "$@"; }', 'ufw(){ echo "$*" >> calls; }',
    'configure_firewall', ''
  ].join('\n'), dir);
  assert.equal(result.status === 0, enabled, result.stdout + result.stderr);
  if (!enabled) assert.equal(fs.existsSync(path.join(dir, 'calls')), false);
 });
 for(const failure of [false,true])fixture('Nginx conf.d backup '+failure,(dir,pre)=>{
  const root=dir.replaceAll('\\','/');fs.mkdirSync(path.join(dir,'nginx/conf.d'),{recursive:true});
  fs.writeFileSync(path.join(dir,'nginx/nginx.conf'),'original');fs.writeFileSync(path.join(dir,'nginx/conf.d/site.conf'),'server original');fs.writeFileSync(path.join(dir,'template'),'new');
  const fn=installerFunctions(source,'prepare_nginx_config').replaceAll('/etc/nginx',root+'/nginx').replaceAll('/usr/lib/node_modules/projectdb/dist/nginx.conf',root+'/template');
  const r=run(pre+fn+'\n'+(failure?'tar(){ return 1; }\n':'')+'prepare_nginx_config\n',dir);
  assert.equal(r.status===0,!failure,r.stdout+r.stderr);
  if(failure){assert.equal(fs.readFileSync(path.join(dir,'nginx/conf.d/site.conf'),'utf8'),'server original');assert.equal(fs.readFileSync(path.join(dir,'nginx/nginx.conf'),'utf8'),'original');}
  else{const saved=run('tar -xOf .projectdb-test/backup/nginx-conf.d.tar ./site.conf',dir);assert.equal(saved.stdout,'server original');assert.equal(fs.existsSync(path.join(dir,'nginx/conf.d/site.conf')),false);}
 });
}
