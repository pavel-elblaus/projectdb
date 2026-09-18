#!/bin/bash
# Установщик LIMS-USB для Raspberry Pi OS Lite Bookworm (64-bit)
# Технические команды пишутся в журнал, в терминале остаются этапы и таймер

#----------------------------------------------------------#
# Начальные параметры установки                            #
#----------------------------------------------------------#

# Остановка при ошибках команд, необъявленных переменных и сбоях в конвейере
set -Eeuo pipefail
# Группы фоновых команд создаются через setsid, без управления заданиями оболочки
set +m

# Начало отсчёта времени текущего запуска установщика
installation_started=$SECONDS

# Пути устройства и начальные ответы до чтения сохранённого плана
PATH_USB=/opt/piusb.bin
PATH_USB_MOUNT=/mnt/usb
PATH_CLONE_TO=/opt
PATH_PDB=/opt/pdb
SERVER_LIMS=""
DEVICE_NAME=LIMS-USB
PASSWORD=""

# Восемь этапов подготовки устройства; выполненные шаги учитываются и при продолжении
step=0
total_steps=8
stage="Preparation"
error_message="Check your network connection and package availability."

#----------------------------------------------------------#
# Вывод сообщений и анимация                               #
#----------------------------------------------------------#

# Сохранение вывода на экран до перенаправления команд в журнал
exec 3>&1

# Обновление строки прогресса только при выводе в обычный терминал
progress_interactive=no
progress_visible=no
progress_text=""
animation_pid=""
command_pid=""
wait_interrupted=no
step_active=no
step_started=0
animation_frame=0
if [ -t 3 ] && [ "${TERM:-dumb}" != dumb ]; then
  progress_interactive=yes
  shopt -s checkwinsize
fi

# Очистка текущей строки перед выводом сообщения или нового состояния
clear_progress() {
  if [ "$progress_interactive" = yes ] && [ "$progress_visible" = yes ]; then
    printf '\r\033[2K' >&3
  fi
}

# Отрисовка строки с таймером текущего этапа; место для таймера сохраняется при обрезке
draw_progress() {
  local width="${COLUMNS:-80}" elapsed suffix="" text_width frames='|/-\'
  if [ "$progress_interactive" = yes ] && [ "$progress_visible" = yes ]; then
    if ! [[ "$width" =~ ^[0-9]+$ ]] || [ "$width" -lt 2 ]; then
      width=80
    fi
    if [ "$step_active" = yes ]; then
      elapsed=$((SECONDS - step_started))
      printf -v suffix ' %s %02d:%02d' "${frames:animation_frame%4:1}" "$((elapsed / 60))" "$((elapsed % 60))"
    fi
    text_width=$((width - 1 - ${#suffix}))
    if [ "$text_width" -lt 0 ]; then
      printf '\r\033[2K%s' "${suffix:0:width-1}" >&3
    else
      printf '\r\033[2K%s%s' "${progress_text:0:text_width}" "$suffix" >&3
    fi
  fi
}

# Перед сообщениями ждём остановки отрисовки, чтобы она не смешивалась с текстом
stop_animation() {
  local pid="$animation_pid"
  animation_pid=""
  if [ -n "$pid" ]; then
    # Отрисовщик не меняет систему: завершаем его сразу, без ожидания stty или sleep
    kill -KILL "$pid" 2>/dev/null || true
    # В обработчике сигнала нельзя входить в ещё один wait до остановки рабочей команды
    if [ "${1:-wait}" != nowait ]; then
      wait "$pid" 2>/dev/null || true
    fi
  fi
}

# Отдельный процесс обновляет экран, пока основной процесс ждёт apt, npm или другую команду
start_animation() {
  if [ "$progress_interactive" != yes ] || [ "$step_active" != yes ] || [ -n "$animation_pid" ]; then
    return 0
  fi
  local installer_pid=$BASHPID
  (
    # Отрисовщик не должен удалять файлы установщика или удерживать его блокировку
    trap - EXIT ERR WINCH
    trap 'exit 0' TERM HUP INT
    exec 9>&-
    while kill -0 "$installer_pid" 2>/dev/null; do
      sleep 0.2
      # Размер окна проверяется и во время ожидания команды основным процессом
      terminal_size=$(stty size <&3 2>/dev/null) || terminal_size=""
      if [ -n "$terminal_size" ]; then
        COLUMNS="${terminal_size##* }"
      fi
      animation_frame=$((animation_frame + 1))
      draw_progress
    done
  ) &
  animation_pid=$!
}

# Сообщения выводятся над полосой, затем прогресс возвращается на последнюю строку
ui_message() {
  stop_animation
  clear_progress
  printf "$@" >&3
  draw_progress
  start_animation
}

# Завершение строки перед возвратом управления консоли
finish_progress() {
  stop_animation
  step_active=no
  if [ "$progress_interactive" = yes ] && [ "$progress_visible" = yes ]; then
    printf '\n' >&3
  fi
  progress_visible=no
}

# Перерисовка после изменения размера окна терминала
trap 'wait_interrupted=yes; stop_animation; draw_progress; start_animation' WINCH

#----------------------------------------------------------#
# Ошибки, прерывание и временные файлы                     #
#----------------------------------------------------------#

# События управления процессами сохраняются только в техническом журнале
log_process_event() {
  if [ -n "${log_file:-}" ]; then
    printf '[%(%Y-%m-%dT%H:%M:%S%z)T] %s\n' -1 "$*" >&2
  fi
}

# Длительная команда запускается отдельно, чтобы wait сразу реагировал на сигнал
run_command() {
  local status=0
  /usr/bin/setsid --wait "$@" </dev/null &
  command_pid=$!
  log_process_event "Command started: $1; PID=$command_pid"
  # WINCH прерывает wait, но не означает завершение запущенной команды
  while true; do
    status=0
    wait_interrupted=no
    wait "$command_pid" || status=$?
    if [ "$wait_interrupted" = yes ] && [ "$status" -gt 128 ]; then
      continue
    fi
    break
  done
  log_process_event "Command finished: $1; PID=$command_pid; exit=$status"
  command_pid=""
  if [ "$status" -ne 0 ]; then
    printf 'Command failed with exit code %s: %s\n' "$status" "$1" >&2
  fi
  return "$status"
}

# Остановка ограничена группой текущей команды, без затрагивания других операций ОС
stop_command() {
  local attempt
  if [ -z "$command_pid" ]; then
    return 0
  fi
  log_process_event "Stopping command group: $command_pid; signal=TERM"
  kill -TERM -- "-$command_pid" 2>/dev/null || kill -TERM "$command_pid" 2>/dev/null || true
  for ((attempt=0; attempt<50; attempt++)); do
    if ! kill -0 -- "-$command_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  # Зависшие дочерние процессы не должны удерживать терминал и блокировки пакетов
  if kill -0 -- "-$command_pid" 2>/dev/null; then
    log_process_event "Stopping command group: $command_pid; signal=KILL"
    kill -KILL -- "-$command_pid" 2>/dev/null || true
  fi
  wait "$command_pid" 2>/dev/null || true
  log_process_event "Command leader reaped: PID=$command_pid"
  if kill -0 -- "-$command_pid" 2>/dev/null; then
    log_process_event "Command group still present after cancellation: $command_pid"
  else
    log_process_event "Command group no longer exists: $command_pid"
  fi
  command_pid=""
}

# Повторный сигнал не запускает вложенную очистку во время остановки
interrupt_installation() {
  local code="$1"
  error_message="$2"
  trap '' INT TERM HUP
  trap - ERR WINCH
  log_process_event "Cancellation requested: stage=$stage; PID=${command_pid:-none}; exit=$code"
  # Только сигнал отрисовщику: вложенный wait задерживал отправку TERM рабочей команде
  stop_animation nowait
  clear_progress
  progress_visible=no
  step_active=no
  printf '\nStopping installation. Please wait...\n' >&3
  stop_command
  fail "$code"
}

# Обёртки сохраняют обычные аргументы apt и dpkg, но делают ожидание прерываемым
apt-get() {
  # Внутренний PTY APT создаёт для dpkg новую сессию, выходящую из управляемой группы
  run_command /usr/bin/apt-get -o Dpkg::Use-Pty=0 "$@"
}

dpkg() {
  run_command /usr/bin/dpkg "$@"
}

# Обработка ошибки: вывод текущего этапа и пояснения
fail() {
  local code="$1"
  # Отключение повторного вызова обработчика при выводе ошибки
  trap - ERR
  stop_animation
  step_active=no
  clear_progress
  progress_visible=no
  printf '\n[ERROR] %s. %s\n' "$stage" "$error_message" >&3
  exit "$code"
}

# Перехват ошибок команд и сигналов остановки установки
trap 'fail $?' ERR
trap 'interrupt_installation 130 "Installation cancelled by the user."' INT
trap 'interrupt_installation 143 "Installation stopped."' TERM
trap 'interrupt_installation 129 "Terminal connection closed. Run the installer again to resume."' HUP

# Удаление незавершённого временного файла; готовый USB-образ и настройки сохраняются
cleanup() {
  stop_command
  finish_progress
  [ -z "${state_temp:-}" ] || rm -f -- "$state_temp"
  # Успешное завершение очистки, в том числе когда временные файлы не создавались
  return 0
}

trap cleanup EXIT

#----------------------------------------------------------#
# Учёт этапов и общий прогресс                             #
#----------------------------------------------------------#

# Вывод полосы прогресса по завершённым этапам, а не по времени установки
progress() {
  local completed="$1" label="$2" filled empty bar rest
  stop_animation
  if [ "$completed" -eq "$total_steps" ]; then
    step_active=no
  fi
  # Расчёт заполненной и свободной частей полосы длиной 20 символов
  filled=$((completed * 20 / total_steps))
  empty=$((20 - filled))
  printf -v bar '%*s' "$filled" ''
  printf -v rest '%*s' "$empty" ''
  printf -v progress_text '[%s%s] %3d%% %s' "${bar// /#}" "${rest// /-}" "$((completed * 100 / total_steps))" "$label"
  progress_visible=yes

  # В терминале обновляется одна строка, в файле остаётся обычный журнал этапов
  if [ "$progress_interactive" = yes ]; then
    draw_progress
  else
    printf '%s\n' "$progress_text" >&3
  fi
}

# Переход к этапу, который требуется выполнить
start_step() {
  stop_animation
  step_started=$SECONDS
  step_active=yes
  animation_frame=0
  # Сохранение названия этапа для журнала и возможного сообщения об ошибке
  stage="$1"
  error_message="This step could not be completed. See the installation log for details."
  progress "$step" "Step $((step + 1))/$total_steps: $stage"
  step=$((step + 1))
  printf '\n--- %s ---\n' "$stage"
  start_animation
}

#----------------------------------------------------------#
# Запрос параметров у пользователя                         #
#----------------------------------------------------------#

# Запрос выбора компонента с повтором при неверном ответе
ask_yes_no() {
  local prompt="$1" variable="$2" answer
  while true; do
    printf '%s [Y/n]: ' "$prompt" >&3
    # Отсутствие ввода завершает установку с понятным сообщением
    if ! read -r answer; then
      error_message="No answer received. Run the installer interactively and answer y or n."
      fail 1
    fi

    # Enter означает согласие; y/n принимаются в любом регистре
    case "$answer" in
      ''|y|Y) printf -v "$variable" '%s' yes; return ;;
      n|N) printf -v "$variable" '%s' no; return ;;
      *) printf 'Please enter y or n.\n' >&3 ;;
    esac
  done
}

# Проверка имени, используемого в каталогах и имени службы
valid_device_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] && [ "${#1}" -le 100 ]
}

valid_server() {
  # Допускаем адрес с HTTP/HTTPS или без схемы; путь и данные входа здесь не нужны
  local address="$1" port
  [[ "$address" =~ ^(https?://)?[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?/?$ ]] || return 1
  address="${address#http://}"
  address="${address#https://}"
  address="${address%/}"
  [[ "$address" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$ ]] || return 1
  if [[ "$address" == *:* ]]; then
    port="${address##*:}"
    [ "$((10#$port))" -ge 1 ] && [ "$((10#$port))" -le 65535 ] || return 1
  fi
}

#----------------------------------------------------------#
# Сохранение состояния и повторный запуск                  #
#----------------------------------------------------------#

data_dir="$HOME/.projectdb"
state_dir="$data_dir/install/raspberrypi"
resuming=no
state_temp=""

# Запись состояния через временный файл, чтобы сбой не оставил неполную отметку
save_state() {
  local name="$1"
  shift
  state_temp=$(mktemp "$state_dir/.state.XXXXXX")
  chmod 600 "$state_temp"
  printf '%s\n' "$@" > "$state_temp"
  # Сброс данных и отметки на диск перед переходом к следующему действию
  sync -f "$state_temp"
  mv -f -- "$state_temp" "$state_dir/$name"
  sync -f "$state_dir"
  state_temp=""
}

# Отметка создаётся только после успешного выполнения действия
mark_done() {
  save_state "done/$1" complete
}

# Успешные действия внутри незавершённого этапа повторно не выполняются
run_once() {
  local name="$1"
  shift
  if [ -f "$state_dir/done/$name" ]; then
    printf 'Already completed: %s\n' "$name"
    return 0
  fi
  "$@"
  mark_done "$name"
}

# Каждый этап занимает своё место в прогрессе, в том числе при продолжении
run_stage() {
  local name="$1" label="$2"
  shift 2

  # Пропущенный этап учитывается в прогрессе, но не показывается как выполненный заново
  # Финальная проверка выполняется заново при каждом продолжении установки
  if [ "$name" != verification ] && [ -f "$state_dir/done/stage-$name" ]; then
    step=$((step + 1))
    ui_message '  Skipped: %s\n' "$label"
    return 0
  fi

  start_step "$label"
  "$@"
  mark_done "stage-$name"
  stop_animation
  step_active=no
  ui_message '  Done: %s\n' "$label"
}

# Удаление данных восстановления только после отметки полного успеха
cleanup_completed_state() {
  if [ ! -f "$state_dir/complete" ]; then
    return 0
  fi

  # Сохраняются только отметка завершения и постоянный файл блокировки
  # Поиск ограничен каталогом установщика и не переходит по символическим ссылкам
  find "$state_dir" -mindepth 1 -maxdepth 1 ! -name complete ! -name lock \( -type f -o -type l \) -delete || return $?

  # Отметки отдельных действий после полного успеха больше не нужны
  if [ -L "$state_dir/done" ]; then
    rm -f -- "$state_dir/done" || return $?
  elif [ -d "$state_dir/done" ]; then
    find "$state_dir/done" -mindepth 1 -maxdepth 1 \( -type f -o -type l \) -delete || return $?
    rmdir -- "$state_dir/done" || return $?
  fi
  return 0
}

# Копирование через файл рядом с целью не оставляет частично записанную конфигурацию
write_atomic() {
  local target="$1" mode="$2"
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
    error_message="A configuration path is a symbolic link or a special file."
    fail 1
  fi
  state_temp=$(mktemp "$(dirname "$target")/.projectdb-pi.XXXXXX")
  chmod "$mode" "$state_temp"
  cat > "$state_temp"
  sync -f "$state_temp"
  mv -f -- "$state_temp" "$target"
  sync -f "$(dirname "$target")"
  state_temp=""
}

# Создание закрытых каталогов служебных данных ProjectDB.
prepare_storage() {
  error_message="Could not prepare the ProjectDB data directory."
  [ ! -L "$data_dir" ] || fail 1
  install -d -m 700 "$data_dir" "$data_dir/log" "$data_dir/tmp" "$data_dir/install"
}

# Блокировка освобождается ОС при выходе; файл блокировки удалять не нужно
init_state() {
  error_message="Could not open the installation state directory."
  install -d -m 700 "$state_dir"
  exec 9> "$state_dir/lock"
  if ! flock -n 9; then
    error_message="Another ProjectDB installation is already running."
    fail 1
  fi

  # Завершённая установка защищена от повторного изменения системы
  if [ -f "$state_dir/complete" ]; then
    cleanup_completed_state
    ui_message 'ProjectDB installation has already completed successfully. Nothing to do.\n'
    exit 0
  fi
  install -d -m 700 "$state_dir/done"

  # Старые установки не содержат отметок этапов: автоматически переделывать их нельзя
  if [ ! -f "$state_dir/plan" ] && command -v projectdb >/dev/null 2>&1; then
    error_message="ProjectDB is already installed, but no resumable installation state was found. Automatic installation will not modify it."
    fail 1
  fi
}

# Чтение сохранённых ответов или опрос перед первым запуском
load_or_create_plan() {
  local answer confirm
  local -a plan
  if [ -f "$state_dir/plan" ]; then
    mapfile -t plan < "$state_dir/plan"
    error_message="Saved device settings do not match this system or are incomplete."
    [ "${#plan[@]}" -eq 7 ] || fail 1
    [ "${plan[0]}" = 1 ] && [ "${plan[1]}" = "$ID" ] && [ "${plan[2]}" = "$VERSION_ID" ] && [ "${plan[3]}" = "$architecture" ] || fail 1
    SERVER_LIMS="${plan[4]}"
    DEVICE_NAME="${plan[5]}"
    PASSWORD="${plan[6]}"
    valid_server "$SERVER_LIMS" && valid_device_name "$DEVICE_NAME" && [ -n "$PASSWORD" ] || fail 1
    resuming=yes
    ui_message 'Resuming the previous installation. Completed steps will be skipped.\n'
    return 0
  fi

  error_message="No answer received. Run the installer in an interactive terminal."
  while true; do
    printf 'LIMS server address [%s]: ' "$SERVER_LIMS" >&3
    read -r answer || fail 1
    answer="${answer:-$SERVER_LIMS}"
    if valid_server "$answer"; then
      case "$answer" in
        http://*|https://*) SERVER_LIMS="$answer" ;;
        *) SERVER_LIMS="https://$answer" ;;
      esac
      break
    fi
    printf 'Enter a server address, with optional http:// or https:// and port.\n' >&3
  done
  while true; do
    printf 'Device name [%s]: ' "$DEVICE_NAME" >&3
    read -r answer || fail 1
    answer="${answer:-$DEVICE_NAME}"
    if valid_device_name "$answer"; then
      DEVICE_NAME="$answer"
      break
    fi
    printf 'Use up to 100 letters, numbers, dots, underscores or hyphens, starting with a letter or number.\n' >&3
  done
  while true; do
    printf 'Device access password: ' >&3
    read -r PASSWORD || { printf '\n' >&3; fail 1; }
    printf '\n' >&3
    if [ -n "$PASSWORD" ] && [[ "$PASSWORD" != *$'\r'* ]]; then
      break
    fi
    printf 'Enter a non-empty password without line breaks.\n' >&3
  done
  printf '\nLIMS server: %s\nDevice: %s\n' "$SERVER_LIMS" "$DEVICE_NAME" >&3
  ask_yes_no 'Start installation?' confirm
  if [ "$confirm" != yes ]; then
    error_message="Installation cancelled by the user."
    fail 1
  fi
  # Один атомарный файл исключает несовпадение плана и пароля после внезапной остановки
  save_state plan 1 "$ID" "$VERSION_ID" "$architecture" "$SERVER_LIMS" "$DEVICE_NAME" "$PASSWORD"
}

#----------------------------------------------------------#
# Работа с пакетным менеджером                             #
#----------------------------------------------------------#

# Восстановление пакетов после прерывания apt или dpkg на предыдущем запуске
recover_packages() {
  local pending repair=no package_states package status
  local -a reinstall_packages=()
  # Проверка и восстановление имеют свой таймер, но не занимают место обычного этапа
  stage="Checking package state"
  error_message="Could not restore the package state. See the installation log for details."
  step_started=$SECONDS
  step_active=yes
  animation_frame=0
  progress "$step" "$stage"
  start_animation

  # Прерванная распаковка требует переустановки до запуска зависимых настроек
  # Статус R сообщает сам dpkg; текст диагностических сообщений не разбирается
  package_states=$(dpkg-query -W -f='${binary:Package} ${db:Status-Abbrev}\n')
  while read -r package status; do
    if [[ "$status" == ??R ]]; then
      reinstall_packages+=("$package")
    fi
  done <<< "$package_states"
  if [ "${#reinstall_packages[@]}" -gt 0 ]; then
    stage="Recovering packages"
    progress "$step" "$stage"
    start_animation
    # Явный список позволяет APT восстановить файлы до настройки остальных пакетов
    if ! apt-get -y --no-remove -f --reinstall install "${reinstall_packages[@]}"; then
      # Некоторые версии APT требуют сначала обработать прерванную операцию dpkg
      # Отложенные обработчики запускаются после восстановления файлов пакетов
      dpkg --configure -a --no-triggers || true
      apt-get -y --no-remove -f --reinstall install "${reinstall_packages[@]}"
    fi
  fi

  pending=$(dpkg --audit)
  if [ -n "$pending" ]; then
    stage="Recovering packages"
    progress "$step" "$stage"
    start_animation
    if ! dpkg --configure -a; then
      repair=yes
    fi
  fi

  # Даже полностью настроенные пакеты могут иметь несовместимые версии зависимостей
  if ! apt-get check; then
    repair=yes
  fi
  if [ "$repair" = yes ]; then
    stage="Recovering packages"
    progress "$step" "$stage"
    start_animation
    # Обновления зависимостей разрешены; автоматическое удаление пакетов запрещено
    apt-get -y --no-remove -f install
    dpkg --configure -a
  fi

  # Завершение восстановления подтверждается обеими проверками
  apt-get check
  pending=$(dpkg --audit)
  if [ -n "$pending" ]; then
    printf '%s\n' "$pending"
    fail 1
  fi
  stop_animation
  clear_progress
  progress_visible=no
  step_active=no
  ui_message '  Done: %s\n' "$stage"
}

# Полностью установленные пакеты не переустанавливаются и не обновляются повторно
install_missing() {
  local package status
  local -a missing=()
  for package in "$@"; do
    status=$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null) || status=""
    if [ "$status" != "install ok installed" ]; then
      missing+=("$package")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    apt-get -y --no-upgrade install "${missing[@]}"
  fi
}

#----------------------------------------------------------#
# Подготовка пакетов и установка приложения                #
#----------------------------------------------------------#

# Обновление списка пакетов и подготовка средств загрузки
prepare_system() {
  run_once system-index apt-get update
  run_once system-tools install_missing ca-certificates curl gnupg
}

#----------------------------------------------------------#
# Источники пакетов и необходимое ПО                       #
#----------------------------------------------------------#

# Добавление ключа и источника Node.js
add_node_repository() {
  # Ключ ограничен этим источником; ошибки загрузки и обработки останавливают этап
  local arch
  arch=$(dpkg --print-architecture)
  case "$arch" in
    amd64|arm64) ;;
    *) error_message="Unsupported Node.js architecture. Use amd64 or arm64."; fail 1 ;;
  esac
  install -d -m 755 /usr/share/keyrings
  state_temp=$(mktemp "$state_dir/.node-key.XXXXXX")
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --batch --yes --dearmor > "$state_temp"
  install -m 644 "$state_temp" /usr/share/keyrings/nodesource.gpg
  rm -f -- "$state_temp"
  state_temp=""
  # Замена старого формата исключает одновременное подключение одного источника дважды
  rm -f -- "/etc/apt/sources.list.d/nodesource.sources"
  printf 'deb [arch=%s signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_18.x nodistro main\n' "$arch" > "/etc/apt/sources.list.d/nodesource.list"
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodejs
}

# Подключение источников с отдельными отметками завершённых действий
configure_repositories() {
  run_once repository-node add_node_repository
  run_once repository-index apt-get update
}

install_packages() {
  # GPIO, форматирование FAT и cron используются службой устройства и запуском USB
  install_missing htop mc nodejs inotify-tools rsync dosfstools raspi-gpio cron build-essential pigpio
}

#----------------------------------------------------------#
# Установка ProjectDB и поддержка GPIO                     #
#----------------------------------------------------------#

# Проверка совместимости CLI со специальной службой устройства
verify_cli_support() {
  local projectdb_bin
  projectdb_bin=$(readlink -f -- "$(command -v projectdb)")
  error_message="The installed ProjectDB version does not support LIMS-USB service protection. Install a compatible version and run this installer again."
  # Не включаем службу с известной ошибкой самостановки в опубликованном старом CLI
  node - "$projectdb_bin" <<'PDB_CLI_CHECK'
const fs = require('fs'), path = require('path');
const bin = process.argv[2];
const source = fs.readFileSync(path.resolve(path.dirname(bin), '../lib/cli.js'), 'utf8');
const supported = /\[\s*["']service["']\s*,\s*["']raspberrypi["']\s*\]\.includes\(process\.env\.PDB_METRIC\)/.test(source);
if (!supported || !source.includes('raspberrypi-device')) process.exit(1);
PDB_CLI_CHECK
}

# Установка приложения и проверка поддержки службы LIMS-USB
install_projectdb_package() {
  run_command npm install projectdb -g
  verify_cli_support
}

install_projectdb() {
  # Отметка ProjectDB появляется только после проверки совместимости службы
  run_once projectdb-package install_projectdb_package
  run_once pigpio-package run_command npm install pigpio@3.3.1 -g
}

#----------------------------------------------------------#
# Подключение к ЛИМС                                       #
#----------------------------------------------------------#

# JSON формирует Node.js: кавычки и обратные слеши в пароле экранируются автоматически.
# Данные передаются через stdin, поэтому пароль не попадает в аргументы процесса.
connection_json() {
  printf '%s\n%s\n' "$SERVER_LIMS" "$PASSWORD" | node -e 'const [host, password] = require("fs").readFileSync(0, "utf8").split("\n"); console.log(JSON.stringify({host, password}));'
}

# Сначала формируем полный JSON, затем заменяем файл общей функцией безопасной записи.
configure_connection() {
  local pdb_path="$PATH_PDB/tmp/server/$DEVICE_NAME" config
  install -d -m 700 "$pdb_path"
  config=$(connection_json)
  write_atomic "$pdb_path/cli.json" 600 <<< "$config"
}

#----------------------------------------------------------#
# Подготовка виртуального USB                              #
#----------------------------------------------------------#

prepare_usb_image() {
  # Не перезаписываем чужой образ. После сбоя готовый собственный файл проверяется и используется повторно.
  if [ -e "$PATH_USB" ] || [ -L "$PATH_USB" ]; then
    if [ -f "$PATH_USB" ] && [ ! -L "$PATH_USB" ] && [ -f "$state_dir/usb-image-owned" ] && [ "$(stat -c %s "$PATH_USB")" -eq 2147483648 ]; then
      fsck.fat -n "$PATH_USB"
      return 0
    fi
    error_message="The USB image path is already in use. Check it before continuing."
    fail 1
  fi
  # Фиксированный временный путь позволяет повторить прерванную запись без накопления файлов по 2 ГБ
  # Отметка владения записывается раньше создания файла; посторонний временный файл не затирается
  if [ -L "$PATH_USB.pending" ] || { [ -e "$PATH_USB.pending" ] && { [ ! -f "$PATH_USB.pending" ] || [ ! -f "$state_dir/usb-image-owned" ]; }; }; then
    error_message="The temporary USB image path is already in use."
    fail 1
  fi
  save_state usb-image-owned yes
  state_temp="$PATH_USB.pending"
  # Закрываем доступ до записи содержимого, а не после завершения dd
  (umask 077; : > "$state_temp")
  chmod 600 "$state_temp"
  run_command dd if=/dev/zero of="$state_temp" bs=1M count=2048 status=none conv=fsync
  run_command mkdosfs "$state_temp" -F 32 -I
  sync -f "$state_temp"
  mv -f -- "$state_temp" "$PATH_USB"
  sync -f "$(dirname "$PATH_USB")"
  state_temp=""
}

# Подключение USB-модуля при следующей загрузке устройства
configure_usb_boot() {
  local config=/boot/firmware/config.txt
  # Отдельная секция all не даёт настройке случайно попасть в секцию другой модели платы
  if ! grep -Fxq 'dtoverlay=dwc2' "$config"; then
    {
      cat "$config"
      printf '\n[all]\ndtoverlay=dwc2\n'
    } | write_atomic "$config" 644
  fi
  if ! grep -Fxq dwc2 /etc/modules; then
    {
      cat /etc/modules
      printf '\ndwc2\n'
    } | write_atomic /etc/modules 644
  fi
}

write_usb_script() {
  # Очистка при загрузке устройства намеренная; при продолжении установщика скрипт не запускается
  write_atomic "$PATH_CLONE_TO/virtual-usb.sh" 755 <<'PDB_USB'
#!/bin/bash
set -euo pipefail
# Cron использует ограниченный PATH; добавляем системные каталоги
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
# Параметры виртуального USB
PATH_USB=/opt/piusb.bin
PATH_USB_MOUNT=/mnt/usb
PATH_CLONE_TO=/opt
USB_IDLE_SECONDS=3
# Блокировка исключает одновременную очистку и подключение образа двумя экземплярами
mkdir -p "$HOME/.projectdb/tmp"
exec 8>"$HOME/.projectdb/tmp/virtual-usb.lock"
flock -n 8 || exit 0
# Проверка, создание каталогов
mkdir -p "$PATH_USB_MOUNT"
mkdir -p "$PATH_CLONE_TO"
# Обновление конфигурации systemd перед монтированием образа
if ! systemctl daemon-reload; then
  printf 'USB startup: failed to reload systemd configuration; continuing.\n' >&2
fi
# Удаление данных при каждой загрузке предусмотрено режимом работы устройства
mkdosfs "$PATH_USB" -F 32 -I
# Очистка каталога синхронизации
rm -rf -- "$PATH_CLONE_TO/$( basename "$PATH_USB_MOUNT" )"

# Отслеживание изменений образа по времени модификации
usb_image_version() {
  stat -c '%y' "$PATH_USB"
}

# Фиксируем исходное состояние до подключения образа как USB устройства
while ! last_synced=$(usb_image_version); do
  printf 'USB startup: failed to read initial image state; retrying.\n' >&2
  sleep 1
done

# Монтируем диск как USB устройство
modprobe g_mass_storage file="$PATH_USB" removable=1 ro=0 stall=0
# При остановке освобождаем только точку монтирования этого скрипта
trap 'if mountpoint -q "$PATH_USB_MOUNT"; then umount "$PATH_USB_MOUNT"; fi' EXIT

# Синхронизация начинается только после периода без новых записей
wait_usb_idle() {
  local version current status
  while true; do
    if ! version=$(usb_image_version); then
      printf 'USB sync: failed to read image state; retrying.\n' >&2
      sleep 1
      continue
    fi

    status=0
    inotifywait -q -t "$USB_IDLE_SECONDS" -e modify "$PATH_USB" || status=$?
    if [ "$status" -eq 0 ]; then
      continue
    fi
    if [ "$status" -ne 2 ]; then
      printf 'USB sync: failed to watch image changes; retrying.\n' >&2
      sleep 1
      continue
    fi

    if ! current=$(usb_image_version); then
      printf 'USB sync: failed to read image state; retrying.\n' >&2
      sleep 1
      continue
    fi
    if [ "$current" = "$version" ]; then
      return 0
    fi
  done
}

while true; do
  if ! current=$(usb_image_version); then
    printf 'USB sync: failed to read image state; retrying.\n' >&2
    sleep 1
    continue
  fi
  if [ "$current" = "$last_synced" ]; then
    # Таймаут закрывает короткое окно между проверкой версии и установкой inotify watch
    status=0
    inotifywait -q -t 1 -e modify "$PATH_USB" || status=$?
    if [ "$status" -ne 0 ] && [ "$status" -ne 2 ]; then
      printf 'USB sync: failed to watch image changes; retrying.\n' >&2
      sleep 1
    fi
    continue
  fi

  wait_usb_idle
  if ! version_before=$(usb_image_version); then
    printf 'USB sync: failed to read image state; retrying.\n' >&2
    sleep 1
    continue
  fi

  # Ошибка подготовки или монтирования образа не должна останавливать синхронизацию
  if ! sync -f "$PATH_USB"; then
    printf 'USB sync: failed to flush image data; retrying.\n' >&2
    sleep 1
    continue
  fi
  if mountpoint -q "$PATH_USB_MOUNT"; then
    if ! umount "$PATH_USB_MOUNT"; then
      printf 'USB sync: failed to release the previous mount; retrying.\n' >&2
      sleep 1
      continue
    fi
  fi

  # Если запись возобновилась во время подготовки, ждём новый период тишины
  if ! current=$(usb_image_version); then
    printf 'USB sync: failed to read image state; retrying.\n' >&2
    sleep 1
    continue
  fi
  if [ "$current" != "$version_before" ]; then
    continue
  fi

  if ! mount -o ro "$PATH_USB" "$PATH_USB_MOUNT"; then
    printf 'USB sync: failed to mount the image; retrying.\n' >&2
    sleep 1
    continue
  fi

  sync_ok=yes
  if ! rsync -a --delete "$PATH_USB_MOUNT" "$PATH_CLONE_TO"; then
    printf 'USB sync: failed to copy data; retrying.\n' >&2
    sync_ok=no
  fi
  if ! umount "$PATH_USB_MOUNT"; then
    printf 'USB sync: failed to unmount the image; retrying.\n' >&2
    sync_ok=no
  fi
  if ! version_after=$(usb_image_version); then
    printf 'USB sync: failed to read image state; retrying.\n' >&2
    sync_ok=no
  fi

  # Если произошла ошибка или поступили новые данные, синхронизация будет повторена
  if [ "$sync_ok" = yes ] && [ "$version_before" = "$version_after" ]; then
    last_synced="$version_after"
  else
    sleep 1
  fi
done
PDB_USB
  bash -n "$PATH_CLONE_TO/virtual-usb.sh"
}

# Сохранение задания запуска USB с сохранением посторонних заданий
configure_usb_cron() {
  local cron_data
  # Ошибка чтения существующей таблицы не должна превращаться в её замену пустой таблицей
  state_temp=$(mktemp "$state_dir/.cron.XXXXXX")
  if ! crontab -l > "$state_temp" 2> "$state_dir/cron-error"; then
    if ! grep -q '^no crontab for ' "$state_dir/cron-error"; then
      cat "$state_dir/cron-error"
      error_message="Could not read the existing root crontab."
      fail 1
    fi
    : > "$state_temp"
  fi
  cron_data=$(cat "$state_temp")
  # Сохраняем посторонние задания, управляемую строку записываем только один раз
  {
    printf '%s\n' "$cron_data" | awk '$0 !~ /^@reboot[[:space:]]+(sudo[[:space:]]+)?\/opt\/virtual-usb[.]sh([[:space:]]|$)/'
    printf '@reboot /opt/virtual-usb.sh >> %s/log/projectdb-usb.log 2>&1\n' "$data_dir"
  } > "$state_temp"
  install -d -m 700 "$data_dir/log"
  touch "$data_dir/log/projectdb-usb.log"
  chmod 600 "$data_dir/log/projectdb-usb.log"
  crontab "$state_temp"
  rm -f -- "$state_temp" "$state_dir/cron-error"
  state_temp=""
  systemctl enable cron.service
}

# Подготовка USB по действиям, которые можно безопасно продолжить
configure_usb() {
  run_once usb-image prepare_usb_image
  run_once usb-boot configure_usb_boot
  run_once usb-script write_usb_script
  run_once usb-cron configure_usb_cron
}

#----------------------------------------------------------#
# Служба устройства и итоговая проверка                    #
#----------------------------------------------------------#

check_result() {
  if [ "$1" -ne 0 ]; then
    error_message="$2"
    fail "$1"
  fi
}

# Создание и проверка службы; первый запуск выполняется после перезагрузки
configure_projectdb_service() {
  local node_bin projectdb_bin gpio_bin executable service_name service_file
  node_bin=$(command -v node)
  check_result $? "Node.js executable was not found"
  projectdb_bin=$(command -v projectdb)
  check_result $? "ProjectDB executable was not found"
  projectdb_bin=$(readlink -f -- "$projectdb_bin")
  check_result $? "Could not resolve the ProjectDB executable"
  gpio_bin=$(command -v raspi-gpio)
  check_result $? "raspi-gpio was not found. Install the GPIO utility for this Raspberry Pi OS before continuing"

  # Установщик рассчитан на стандартные системные пути без подстановок systemd
  for executable in "$node_bin" "$projectdb_bin" "$gpio_bin"; do
    if ! [[ "$executable" =~ ^/[A-Za-z0-9_./-]+$ ]] || [ ! -x "$executable" ]; then
      echo "[PI][ERROR] A service executable has an unsupported path or is not executable." >&2
      exit 1
    fi
  done
  if ! [[ "$PATH_PDB" =~ ^/[A-Za-z0-9_./-]+$ ]] || [ ! -d "$PATH_PDB" ]; then
    echo "[PI][ERROR] The application working directory is missing or has an unsupported path." >&2
    exit 1
  fi

  install -d -m 700 "$data_dir/log"
  service_name="pdb.$DEVICE_NAME.service"
  service_file="/etc/systemd/system/$service_name"
  # raspberrypi сохраняет режим устройства; CLI должен защищать этот режим от остановки собственной службы
  # Совместимое исправление находится в lib/cli.js ProjectDB и должно входить в устанавливаемый npm-пакет
  # SIGINT даёт приложению завершиться штатно; ExecStop ждёт выхода до сигналов systemd
  # Ожидание ограничено 30 секундами: зависший процесс остановит systemd с отметкой ошибки
  write_atomic "$service_file" 644 <<PDB_SERVICE
[Unit]
Description=ProjectDB LIMS-USB device
Wants=network-online.target
After=network-online.target

[Service]
Type=exec
User=root
Group=root
WorkingDirectory=$PATH_PDB
Environment=PDB_METRIC=raspberrypi
ExecStartPre="$gpio_bin" set 22,27 op dh
ExecStart="$node_bin" "$projectdb_bin" start "$DEVICE_NAME" --work-path "$PATH_PDB"
ExecStop=/bin/sh -c 'if [ -n "\$\$1" ]; then kill -INT "\$\$1" 2>/dev/null || :; while kill -0 "\$\$1" 2>/dev/null; do sleep 0.1; done; fi' -- \$MAINPID
TimeoutStopSec=30s
ExecStopPost="$gpio_bin" set 17,22,27 dl
Restart=always
RestartSec=3
StandardOutput=append:$data_dir/log/pdb.$DEVICE_NAME.log
StandardError=append:$data_dir/log/pdb.$DEVICE_NAME.log
SyslogIdentifier=pdb.$DEVICE_NAME

[Install]
WantedBy=multi-user.target
PDB_SERVICE
  check_result $? "Could not write the ProjectDB service"
  chmod 644 "$service_file"
  check_result $? "Could not set the ProjectDB service permissions"
  systemd-analyze verify "$service_file"
  check_result $? "The ProjectDB service failed systemd validation"
  systemctl daemon-reload
  check_result $? "Could not reload systemd units"
  systemctl enable "$service_name"
  check_result $? "Could not enable the ProjectDB service"
  # Постоянная отметка запрещает обычному CLI заменять специальную службу устройства
  install -d -m 700 "$data_dir"
  write_atomic "$data_dir/raspberrypi-device" 600 <<< "$DEVICE_NAME"
  # Первый запуск произойдёт после перезагрузки, когда будет завершена настройка USB
}

# Проверка приложения, настроек подключения, USB и службы перед завершением
verify_installation() {
  node --version
  verify_cli_support
  node -e 'require(process.argv[1] + "/pigpio/package.json")' "$(npm root -g)"
  # Сравнение сохранённых параметров без вывода пароля в журнал
  local expected_config saved_config
  expected_config=$(connection_json)
  saved_config=$(node -e 'const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(JSON.stringify({host: config.host, password: config.password}));' "$PATH_PDB/tmp/server/$DEVICE_NAME/cli.json")
  [ "$saved_config" = "$expected_config" ]
  test "$(stat -c %a "$PATH_PDB/tmp/server/$DEVICE_NAME/cli.json")" = 600
  systemd-analyze verify "/etc/systemd/system/pdb.$DEVICE_NAME.service"
  systemctl is-enabled "pdb.$DEVICE_NAME.service"
  systemctl is-enabled cron.service
  bash -n "$PATH_CLONE_TO/virtual-usb.sh"
  test "$(stat -c %s "$PATH_USB")" -eq 2147483648
  fsck.fat -n "$PATH_USB"
  crontab -l | grep -Fx "@reboot /opt/virtual-usb.sh >> $data_dir/log/projectdb-usb.log 2>&1"
}

#----------------------------------------------------------#
# Проверка системы и выполнение установки                  #
#----------------------------------------------------------#

if [ "$EUID" -ne 0 ]; then
  error_message="Run this installer as root."
  fail 1
fi
. /etc/os-release
architecture=$(/usr/bin/dpkg --print-architecture)
# Профиль из инструкции: Raspberry Pi OS Lite Bookworm, 64 бита; допускается подготовка карты на стенде
if ! { [[ "${ID:-}" == debian || "${ID:-}" == raspbian ]] && [ "${VERSION_ID:-}" = 12 ] && [ "${VERSION_CODENAME:-}" = bookworm ] && [ "$architecture" = arm64 ]; }; then
  error_message="Use Raspberry Pi OS Lite Bookworm (64-bit)."
  fail 1
fi
if [ ! -r /proc/device-tree/model ] || ! grep -aq 'Raspberry Pi' /proc/device-tree/model || [ ! -f /boot/firmware/config.txt ]; then
  error_message="This installer requires a Raspberry Pi with /boot/firmware/config.txt."
  fail 1
fi
for required in flock setsid sync; do
  if ! command -v "$required" >/dev/null; then
    error_message="A required system tool is missing: $required."
    fail 1
  fi
done
umask 077
prepare_storage
init_state
load_or_create_plan
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a LC_ALL=C
log_file=$(mktemp "$data_dir/log/projectdb-pi-install.XXXXXX.log")
printf 'Installation log: %s\n' "$log_file" >&3
exec >> "$log_file" 2>&1
umask 022
log_process_event "LIMS-USB installer; OS=$ID $VERSION_ID; architecture=$architecture"
# После жёсткого прерывания удаляем только собственные временные копии пароля
connection_dir="$PATH_PDB/tmp/server/$DEVICE_NAME"
if [ -d "$connection_dir" ] && [ ! -L "$connection_dir" ]; then
  find "$connection_dir" -maxdepth 1 -type f \( -name '.connection.*' -o -name '.projectdb-pi.*' \) -delete
fi
if [ "$resuming" = yes ]; then
  recover_packages
fi

#----------------------------------------------------------#
# Выполнение этапов установки                              #
#----------------------------------------------------------#

run_stage system "Preparing system packages" prepare_system
run_stage repositories "Adding software repositories" configure_repositories
run_stage packages "Installing required software" install_packages
run_stage projectdb "Installing ProjectDB and GPIO support" install_projectdb
run_stage connection "Saving device settings" configure_connection
run_stage usb "Preparing the virtual USB drive" configure_usb
run_stage service "Configuring the device service" configure_projectdb_service
run_stage verification "Verifying installation" verify_installation

#----------------------------------------------------------#
# Итог установки и перезагрузка                            #
#----------------------------------------------------------#

save_state complete complete
error_message="Installation completed, but recovery files could not be removed. Run the installer again to retry cleanup."
cleanup_completed_state
unset PASSWORD
installation_elapsed=$((SECONDS - installation_started))
printf 'Installation completed successfully. Duration: %s seconds.\n' "$installation_elapsed"
ui_message '\nDevice: %s\nService: pdb.%s.service\nInstallation time: %02dm %02ds\n' "$DEVICE_NAME" "$DEVICE_NAME" "$((installation_elapsed / 60))" "$((installation_elapsed % 60))"
ui_message 'The device will now reboot to start LIMS-USB.\n'
progress "$total_steps" "LIMS-USB installation completed"
finish_progress

# Как в исходной инструкции, перезагрузка выполняется только после полного успеха
error_message="Installation completed, but automatic reboot failed. Reboot the device manually."
systemctl reboot
