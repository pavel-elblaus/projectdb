#!/bin/bash
# Установщик ProjectDB для Ubuntu

#----------------------------------------------------------#
# Начальные параметры установки                            #
#----------------------------------------------------------#

# Остановка при ошибках команд, обращении к необъявленным переменным и сбоях в конвейере
# Обработчик ERR также действует внутри функций и подстановок команд
set -Eeuo pipefail
# Группы фоновых команд создаются через setsid, без управления заданиями оболочки
set +m

# Начало отсчёта времени текущего запуска установщика
installation_started=$SECONDS

# Начальные значения до чтения сохранённого плана или ответов пользователя
nginx=no
postgresql=no
pg_version=17
pg_database=projectdb
pg_remote=lan
disable_ipv6=yes
ssh_port=22
swap_percent=50

# Восемь обязательных этапов; настройка Nginx и PostgreSQL учитывается отдельно
step=0
total_steps=8
stage="Preparation"
error_message="Check your network connection and package availability."

# Пути временных файлов для удаления при завершении установки
swap_temp=""
fstab_temp=""

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

# Удаление только временных файлов; установленный swap и настройки сохраняются
cleanup() {
  stop_command
  finish_progress
  [ -z "${state_temp:-}" ] || rm -f -- "$state_temp"
  [ -z "$swap_temp" ] || rm -f -- "$swap_temp"
  [ -z "$fstab_temp" ] || rm -f -- "$fstab_temp"
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
  printf -v progress_text '[%s%s] %3d%% %s' "${bar// /#}" "${rest// /-}" \
    "$((completed * 100 / total_steps))" "$label"
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
  local prompt="$1" variable="$2" answer default="${3:-yes}"
  while true; do
    if [ "$default" = yes ]; then printf '%s [Y/n]: ' "$prompt" >&3; else printf '%s [y/N]: ' "$prompt" >&3; fi
    # Отсутствие ввода завершает установку с понятным сообщением
    if ! read -r answer; then
      error_message="No answer received. Run the installer interactively and answer y or n."
      fail 1
    fi

    # Enter выбирает значение по умолчанию; y/n принимаются в любом регистре
    case "$answer" in
      '') printf -v "$variable" '%s' "$default"; return ;;
      y|Y) printf -v "$variable" '%s' yes; return ;;
      n|N) printf -v "$variable" '%s' no; return ;;
      *) printf 'Please enter y or n.\n' >&3 ;;
    esac
  done
}

# Выбор области доступа одновременно задаёт правило PostgreSQL и ограничение UFW.
ask_postgresql_access() {
  local answer
  ui_message 'PostgreSQL access:\n  1) This server only (127.0.0.1)\n  2) Local network (192.168.0.0/16)\n  3) Any IPv4 address (0.0.0.0/0)\n'
  while true; do
    printf 'Choose PostgreSQL access [2]: ' >&3
    if ! read -r answer; then
      error_message="No answer received. Choose PostgreSQL access interactively."
      fail 1
    fi
    case "$answer" in
      1) pg_remote=no; return ;;
      ''|2) pg_remote=lan; return ;;
      3) pg_remote=yes; return ;;
      *) ui_message 'Please enter 1, 2 or 3.\n' ;;
    esac
  done
}

# Проверяем настройки ядра: отсутствие IPv6 или отключение на всех интерфейсах не требует вопроса.
ipv6_enabled() {
  local flag value
  for flag in /proc/sys/net/ipv6/conf/*/disable_ipv6; do
    [ -r "$flag" ] || continue
    read -r value < "$flag"
    if [ "$value" = 0 ]; then return 0; fi
  done
  return 1
}

# Проверка порта до использования в правиле межсетевого экрана
valid_ssh_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535))
}

# Пустой ответ оставляет стандартный порт; ошибочный ввод запрашивается повторно
ask_ssh_port() {
  local answer
  printf 'The selected SSH port will be allowed in the firewall. This does not change the SSH server port.\n' >&3
  while true; do
    printf 'Which SSH port is used? [22]: ' >&3
    if ! read -r answer; then
      error_message="No answer received. Run the installer interactively and enter the SSH port."
      fail 1
    fi
    answer="${answer:-22}"
    if valid_ssh_port "$answer"; then
      ssh_port=$((10#$answer))
      return 0
    fi
    printf 'Please enter a port number from 1 to 65535.\n' >&3
  done
}

# Проверка целого процента от доступной оперативной памяти
valid_swap_percent() {
  [[ "$1" =~ ^[0-9]{1,3}$ ]] && ((10#$1 >= 0 && 10#$1 <= 100))
}

# Выбор размера swap до изменения системы; Enter оставляет половину RAM
ask_swap_percent() {
  local answer
  while true; do
    printf 'Swap file size, %% of RAM (0 = disabled) [50]: ' >&3
    if ! read -r answer; then
      error_message="No answer received. Run the installer interactively and enter the swap size (% of RAM)."
      fail 1
    fi
    answer="${answer:-50}"
    answer="${answer%\%}"
    if valid_swap_percent "$answer"; then
      swap_percent=$((10#$answer))
      return 0
    fi
    printf 'Please enter a whole number from 0 to 100 (%% of RAM).\n' >&3
  done
}

#----------------------------------------------------------#
# Сохранение состояния и повторный запуск                  #
#----------------------------------------------------------#

data_dir="$HOME/.projectdb"
state_dir="$data_dir/install/server"
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
  find "$state_dir" -mindepth 1 -maxdepth 1 \
    ! -name complete ! -name lock \( -type f -o -type l \) -delete || return $?

  # Отметки отдельных действий после полного успеха больше не нужны
  if [ -L "$state_dir/done" ]; then
    rm -f -- "$state_dir/done" || return $?
  elif [ -d "$state_dir/done" ]; then
    find "$state_dir/done" -mindepth 1 -maxdepth 1 \( -type f -o -type l \) -delete || return $?
    rmdir -- "$state_dir/done" || return $?
  fi
  return 0
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

# Имя базы сохраняется в плане и безопасно передаётся PostgreSQL как отдельное значение
valid_database_name() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] && [[ "$1" != template0 && "$1" != template1 ]]
}

ask_database_name() {
  local answer
  while true; do
    printf 'Database name [%s]: ' "$pg_database" >&3
    read -r answer || fail 1
    if [ -z "$answer" ]; then answer="$pg_database"; fi
    if valid_database_name "$answer"; then pg_database="$answer"; break; fi
    ui_message 'Use 1-63 letters, numbers or underscores, starting with a letter or underscore. Template database names are reserved.\n'
  done
}

# Резервная копия сохраняется один раз и остаётся после завершения установки.
backup_config() {
  local source="$1" name="$2" target
  target="$data_dir/backup/$name"
  (umask 077; mkdir -p "$data_dir/backup")
  if [ ! -e "$target" ]; then
    state_temp=$(mktemp "$data_dir/backup/.config.XXXXXX")
    cp -p -- "$source" "$state_temp"
    sync -f "$state_temp"
    mv -f -- "$state_temp" "$target"
    sync -f "$data_dir/backup"
    state_temp=""
  fi
}

# Проверяем кандидат fstab до замены; записи других файловых систем должны совпадать.
save_swap_fstab() {
  local source="$1" swap_path="$2" enabled="$3"
  error_message="Could not validate the new fstab. The original file has not been replaced."
  [ -f "$source" ] && [ ! -L "$source" ] || fail 1
  backup_config "$source" fstab.original
  fstab_temp=$(mktemp "$(dirname "$source")/fstab.projectdb.XXXXXX")
  if [ "$source" -ef "$fstab_temp" ]; then fstab_temp=""; fail 1; fi
  cp -p -- "$source" "$fstab_temp"
  awk -v swap_path="$swap_path" -v enabled="$enabled" '
    $1 != swap_path { print }
    END { if (enabled == "yes") print swap_path " none swap sw 0 0" }
  ' "$source" > "$fstab_temp"
  cmp -s <(awk -v path="$swap_path" '$1 != path { print }' "$source") \
         <(awk -v path="$swap_path" '$1 != path { print }' "$fstab_temp") || fail 1
  findmnt --verify --tab-file "$fstab_temp"
  sync -f "$fstab_temp"
  mv -f -- "$fstab_temp" "$source"
  sync -f "$(dirname "$source")"
  fstab_temp=""
}

# Проверяем текущий SSH-сеанс до любых ограничений сети.
check_ssh_choices() {
  local client client_port server connected_port
  if [ -n "${SSH_CONNECTION:-}" ]; then
    read -r client client_port server connected_port <<< "$SSH_CONNECTION"
    if [ "$connected_port" != "$ssh_port" ]; then
      error_message="The selected SSH port does not match the current connection. Reconnect using the selected port before continuing."
      fail 1
    fi
    if [ "$disable_ipv6" = yes ] && [[ "$server" == *:* ]]; then
      error_message="Disabling IPv6 would disconnect this SSH session. Reconnect over IPv4 or keep IPv6 enabled."
      fail 1
    fi
  fi
}

# Чтение параметров как данных, без исполнения содержимого файла
load_or_create_plan() {
  local -a plan
  if [ -f "$state_dir/plan" ]; then
    mapfile -t plan < "$state_dir/plan"
    if ! { { [ "${#plan[@]}" -eq 6 ] && [ "${plan[0]}" = 1 ]; } || \
           { [ "${#plan[@]}" -eq 7 ] && [ "${plan[0]}" = 2 ]; } || \
           { [ "${#plan[@]}" -eq 8 ] && [ "${plan[0]}" = 3 ]; } || \
           { [ "${#plan[@]}" -eq 9 ] && [ "${plan[0]}" = 4 ]; } || \
           { [ "${#plan[@]}" -eq 11 ] && [ "${plan[0]}" = 5 ]; }; } || \
       [ "${plan[1]}" != "$ID" ] || [ "${plan[2]}" != "$VERSION_ID" ] || \
       [ "${plan[3]}" != "$pg_version" ] || \
       ! [[ "${plan[4]}" =~ ^(yes|no)$ && "${plan[5]}" =~ ^(yes|no)$ ]]; then
      error_message="Saved installation settings do not match this system or installer. Check the state directory before continuing."
      fail 1
    fi
    # Старый план использовал только порт 22; сохранённые компоненты не меняются
    ssh_port="${plan[6]-22}"
    if ! valid_ssh_port "$ssh_port"; then
      error_message="The saved SSH port is invalid. Check the installation state."
      fail 1
    fi
    ssh_port=$((10#$ssh_port))
    # Старые планы использовали swap размером 50% RAM
    swap_percent="${plan[7]-50}"
    if ! valid_swap_percent "$swap_percent"; then
      error_message="The saved swap size (% of RAM) is invalid. Check the installation state."
      fail 1
    fi
    swap_percent=$((10#$swap_percent))
    # Старые планы не создавали базу приложения: сохраняем подключение к postgres
    pg_database="${plan[8]-postgres}"
    if ! valid_database_name "$pg_database"; then
      error_message="The saved database name is invalid. Check the installation state."
      fail 1
    fi
    pg_remote="${plan[9]-yes}"
    disable_ipv6="${plan[10]-yes}"
    if ! [[ "$pg_remote" =~ ^(yes|no|lan)$ && "$disable_ipv6" =~ ^(yes|no)$ ]]; then
      error_message="Saved network settings are invalid."
      fail 1
    fi
    if [ "${plan[0]}" != 5 ]; then
      save_state plan 5 "$ID" "$VERSION_ID" "$pg_version" "${plan[4]}" "${plan[5]}" "$ssh_port" "$swap_percent" "$pg_database" "$pg_remote" "$disable_ipv6"
    fi
    resuming=yes
    nginx="${plan[4]}"
    postgresql="${plan[5]}"
    ui_message 'Resuming the previous installation. Completed steps will be skipped.\n'
  else
    ask_yes_no "Install the Nginx web server?" nginx
    ask_yes_no "Install PostgreSQL $pg_version?" postgresql
    if [ "$postgresql" = yes ]; then
      ask_database_name
      ask_postgresql_access
    fi
    ask_ssh_port
    ask_swap_percent
    disable_ipv6=no
    if ipv6_enabled; then
      ui_message 'If IPv6 is not configured correctly, keeping it enabled may cause download problems with external sources (dependencies, updates and libraries).\n'
      ask_yes_no "Disable IPv6?" disable_ipv6 yes
    fi
    check_ssh_choices
    save_state plan 5 "$ID" "$VERSION_ID" "$pg_version" "$nginx" "$postgresql" "$ssh_port" "$swap_percent" "$pg_database" "$pg_remote" "$disable_ipv6"
  fi
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
# Проверка системы и подготовка запуска                    #
#----------------------------------------------------------#

# Проверка прав администратора, в том числе при запуске скрипта ОС напрямую
if [ "$EUID" -ne 0 ]; then
  error_message="Run this installer as root."
  fail 1
fi

# Чтение названия, версии и кодового имени системы из стандартного файла ОС
. /etc/os-release
codename="${VERSION_CODENAME:-}"

# Порт базы данных и каталоги источников пакетов и ключей подписи
pg_port=5780
apt=/etc/apt/sources.list.d
gpg=/etc/apt/trusted.gpg.d

# Проверка поддерживаемой ОС — Ubuntu 22.04 и 24.04
case "${ID:-}:${VERSION_ID:-}:$codename" in
  ubuntu:22.04:jammy|ubuntu:24.04:noble) ;;
  *)
    error_message="This operating system release ($codename) is not supported by this installer."
    fail 1
  ;;
esac

# Запрос параметров установки
# Проверка предыдущего запуска выполняется до вопросов и изменения настроек системы
prepare_storage
init_state
load_or_create_plan

# Добавление этапов настройки только для выбранных компонентов
if [ "$nginx" = yes ]; then total_steps=$((total_steps + 1)); fi
if [ "$postgresql" = yes ]; then total_steps=$((total_steps + 1)); fi

# Установка пакетов без диалогов и автоматический перезапуск обновлённых служб
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

# Создание отдельного журнала с доступом только для владельца
umask 077
log_file=$(mktemp "$data_dir/log/projectdb-install.XXXXXX.log")
printf 'Installation log: %s\n' "$log_file" >&3
# Технический вывод сохраняется в закрытом журнале; сообщения пользователю выводятся через дескриптор 3.
exec >> "$log_file" 2>&1
log_process_event "Installer process control: revision 3; OS=$ID $VERSION_ID"
# Восстановление обычных прав для создаваемых далее файлов настроек
umask 022

# При продолжении сначала завершаются прерванные операции пакетного менеджера
if [ "$resuming" = yes ]; then
  recover_packages
fi

#----------------------------------------------------------#
# Генерация пароля базы данных                             #
#----------------------------------------------------------#
gen_pass() {
  # Криптографически случайный пароль; шестнадцатеричная запись безопасна для SQL
  openssl rand -hex 10
}

#----------------------------------------------------------#
# Настройка файла подкачки                                 #
#----------------------------------------------------------#

configure_swap() {
  error_message="Could not configure swap memory. Check available disk space and RAM."
  # Проверка активности именно /swapfile; другие файлы и разделы подкачки не изменяются
  active_swap=$(swapon --show=NAME --noheadings --raw)
  swap_active=no
  local swap_prepared=no
  if grep -Fxq /swapfile <<< "$active_swap"; then
    swap_active=yes
  fi

  # Запрет замены символической ссылки, каталога или устройства вместо обычного файла
  if [ -L /swapfile ] || { [ -e /swapfile ] && [ ! -f /swapfile ]; }; then
    error_message="/swapfile is a symbolic link or a special file."
    fail 1
  fi

  # Нулевой размер отключает только управляемый установщиком файл /swapfile
  if [ "$swap_percent" -eq 0 ]; then
    error_message="Could not disable the swap file. Free some RAM and try again."
    if [ "$swap_active" = yes ]; then
      swapoff /swapfile
    fi
    # При ошибке swapoff файл и запись автоподключения остаются на месте
    error_message="Could not remove the swap file or its boot configuration."
    save_swap_fstab /etc/fstab /swapfile no
    rm -f -- /swapfile
    printf 'Swap file disabled: 0%% of RAM.\n'
    return 0
  fi

  # Получение объёма оперативной памяти, доступного системе
  memory_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
  if ! [[ "$memory_kb" =~ ^[0-9]+$ ]] || [ "$memory_kb" -le 0 ]; then
    fail 1
  fi

  # MemTotal указан в КиБ; размер вычисляется по выбранному проценту, с округлением вниз до байта
  target_bytes=$((memory_kb * 1024 * swap_percent / 100))

  # Определение текущего размера; отсутствие файла учитывается как нулевой размер
  current_bytes=0
  if [ -f /swapfile ]; then
    current_bytes=$(stat -c %s /swapfile)
  fi

  # Пересоздание файла только при отличии от выбранного размера
  if [ "$current_bytes" -ne "$target_bytes" ]; then
    # Готовим новый файл до отключения старого swap. dd создаёт файл без разреженных областей.
    swap_temp=$(mktemp /swapfile.projectdb.XXXXXX)
    chmod 600 "$swap_temp"

    # Попытка отключить копирование при записи для файловых систем с CoW
    # Отсутствие поддержки этого атрибута не останавливает установку
    if command -v chattr >/dev/null; then
      chattr +C "$swap_temp" || true
    fi
    dd if=/dev/zero of="$swap_temp" bs=1M count="$target_bytes" iflag=count_bytes status=none
    # Создание структуры swap в подготовленном файле
    mkswap "$swap_temp"
    swap_prepared=yes
    if [ "$swap_active" = yes ]; then
      error_message="Could not disable the existing swap. Free some RAM and try again."
      # Отключение старого swap перед заменой; при нехватке памяти команда завершится ошибкой
      swapoff /swapfile
    fi

    # При ошибке подготовки или отключения swap старый файл сохраняется.
    mv -f -- "$swap_temp" /swapfile
    # Сброс временного пути после переноса, чтобы очистка не затронула новый файл
    swap_temp=""
    swap_active=no
  fi

  chmod 600 /swapfile
  # Подготовка и включение неактивного файла; уже работающий swap нужного размера сохраняется
  if [ "$swap_active" = no ]; then
    error_message="Could not activate swap memory. Check whether this filesystem supports swap files."
    if [ "$swap_prepared" = no ]; then
      mkswap /swapfile
    fi
    swapon /swapfile
  fi

  error_message="Could not save the swap configuration for the next boot."
  save_swap_fstab /etc/fstab /swapfile yes
  printf 'Swap file configured: %s%% of RAM (%s bytes).\n' "$swap_percent" "$target_bytes"
}

#----------------------------------------------------------#
# Настройка сети                                           #
#----------------------------------------------------------#

configure_network() {
  if [ "$disable_ipv6" = no ]; then return 0; fi
  # Отключение IPv6 не должно обрывать текущий удалённый доступ
  if [[ "${SSH_CONNECTION:-}" == *:* ]]; then
    error_message="This installer disables IPv6. Reconnect over IPv4 or use the server console, then run it again."
    fail 1
  fi
  if [ -f /etc/sysctl.d/99-disable-ipv6.conf ]; then
    backup_config /etc/sysctl.d/99-disable-ipv6.conf ipv6.conf.original
  fi
  # Сохранение отключения IPv6 для существующих и новых сетевых интерфейсов
  state_temp=$(mktemp /etc/sysctl.d/.projectdb-ipv6.XXXXXX)
  cat > "$state_temp" <<EOF
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.ipv6.conf.lo.disable_ipv6 = 1
EOF

  # Применение системных параметров без перезагрузки сервера
  chmod 644 "$state_temp"
  sync -f "$state_temp"
  mv -f -- "$state_temp" /etc/sysctl.d/99-disable-ipv6.conf
  state_temp=""
  sysctl -p /etc/sysctl.d/99-disable-ipv6.conf
}

#----------------------------------------------------------#
# Обновление системы и подготовка инструментов             #
#----------------------------------------------------------#

update_system() {
  run_once system-index apt-get update
  run_once system-upgrade apt-get -y upgrade

  # Установка средств HTTPS, проверки подписей и запуска команд от другого пользователя
  run_once system-tools install_missing ca-certificates curl gnupg openssl sudo
}

#----------------------------------------------------------#
# Подключение репозиториев                                 #
#----------------------------------------------------------#

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
  rm -f -- "$apt/nodesource.sources"
  printf 'deb [arch=%s signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_18.x nodistro main\n' "$arch" > "$apt/nodesource.list"
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodejs
}

add_php_repository() {
  # Репозиторий PHP 7.2
  # Установка инструмента для подключения PPA в Ubuntu
  install_missing software-properties-common
  run_command add-apt-repository -y ppa:ondrej/php
}

add_nginx_repository() {
  echo "deb https://nginx.org/packages/ubuntu $codename nginx" > $apt/nginx.list
  curl -fsS https://nginx.org/keys/nginx_signing.key | gpg --batch --yes --dearmor | tee $gpg/nginx.org.gpg > /dev/null
}

add_pg_repository() {
  pg_repository="https://apt.postgresql.org/pub/repos/apt"
  echo "deb $pg_repository $codename-pgdg main" > $apt/pgdg.list
  # Импорт ключа для проверки подписи пакетов PostgreSQL
  curl -fsS https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --batch --yes --dearmor | tee $gpg/apt.postgresql.org.gpg > /dev/null
}

configure_repositories() {
  run_once repository-node add_node_repository
  run_once repository-php add_php_repository
  if [ "$nginx" = yes ]; then
    run_once repository-nginx add_nginx_repository
  fi
  if [ "$postgresql" = yes ]; then
    run_once repository-pg add_pg_repository
  fi
  run_once repository-index apt-get update
}

#----------------------------------------------------------#
# Установка выбранных пакетов                              #
#----------------------------------------------------------#

install_packages() {
  # Общие утилиты, среда Node.js, PHP с расширениями и средства сборки нативных модулей
  software="htop mc iproute2 nodejs php7.2-cli php7.2-mbstring php7.2-xml php7.2-gd php7.2-zip ufw build-essential"

  # Добавление Nginx
  if [ "$nginx" = "yes" ]; then
    software="$software nginx"
  fi

  # Добавление PostgreSQL 17
  if [ "$postgresql" = "yes" ]; then
    software="$software postgresql-$pg_version"
  fi

  # Установка пакетов через apt
  install_missing $software
}

#----------------------------------------------------------#
# Настройка межсетевого экрана                             #
#----------------------------------------------------------#

configure_firewall() {
  error_message="Firewall checks failed. Check the SSH port and firewall configuration before retrying."
  check_ssh_choices
  /usr/sbin/sshd -t
  [ -n "$(ss -H -ltn "sport = :$ssh_port")" ] || fail 1
  if [ "$disable_ipv6" = no ] && ipv6_enabled; then
    grep -Eq '^[[:space:]]*IPV6=yes[[:space:]]*$' /etc/default/ufw || fail 1
  fi
  backup_config /etc/default/ufw ufw-default.original
  backup_config /etc/ufw/ufw.conf ufw.conf.original
  backup_config /etc/ufw/user.rules ufw-user.rules.original
  backup_config /etc/ufw/user6.rules ufw-user6.rules.original
  # Разрешение подключений по SSH
  ufw allow "$ssh_port/tcp" > /dev/null

  # Разрешение подключений к веб-серверу
  run_once firewall-allow-80 ufw allow 80 > /dev/null
  run_once firewall-allow-443 ufw allow 443 > /dev/null

  # Разрешение подключений к базе данных
  if [ "$postgresql" = yes ] && [ "$pg_remote" = yes ]; then
    run_once firewall-database ufw allow "$pg_port/tcp" > /dev/null
  elif [ "$postgresql" = yes ] && [ "$pg_remote" = lan ]; then
    run_once firewall-database ufw allow from 192.168.0.0/16 to any port "$pg_port" proto tcp > /dev/null
  fi

  # Запрет входящих подключений применяется только после разрешения нужных портов
  run_once firewall-default-deny-incoming ufw default deny incoming > /dev/null
  run_once firewall-default-allow-outgoing ufw default allow outgoing > /dev/null

  # Пробная сборка правил выполняется до включения firewall.
  ufw --dry-run --force enable
  run_once firewall-enable ufw --force enable
}

#----------------------------------------------------------#
# Установка ProjectDB                                      #
#----------------------------------------------------------#

install_projectdb() {
  # Глобальная установка ProjectDB с добавлением команды в систему
  run_once projectdb-package run_command npm install projectdb -g
}

#----------------------------------------------------------#
# Настройка Nginx                                          #
#----------------------------------------------------------#

# Сохранение исходной конфигурации один раз, до замены настроек
prepare_nginx_config() {
  backup_config /etc/nginx/nginx.conf nginx.conf.original
  (umask 077; mkdir -p "$data_dir/backup")
  if [ ! -f "$data_dir/backup/nginx-conf.d.tar" ]; then
    state_temp=$(mktemp "$data_dir/backup/.nginx-conf.d.XXXXXX")
    tar -cpf "$state_temp" -C /etc/nginx/conf.d .
    tar -tf "$state_temp" >/dev/null
    sync -f "$state_temp"
    mv -f -- "$state_temp" "$data_dir/backup/nginx-conf.d.tar"
    sync -f "$data_dir/backup"
    state_temp=""
  fi
  rm -f /etc/nginx/conf.d/*.conf
  cp -f /usr/lib/node_modules/projectdb/dist/nginx.conf /etc/nginx/
}

# Длительная генерация выполняется один раз; незавершённый файл не используется
prepare_nginx_tls() {
  run_command openssl dhparam -out "$state_dir/dhparam.pem.pending" 2048
  openssl dhparam -in "$state_dir/dhparam.pem.pending" -check -noout
  install -m 644 "$state_dir/dhparam.pem.pending" /etc/nginx/dhparam.pem
  rm -f "$state_dir/dhparam.pem.pending"
}

# Настройка Nginx с сохранением результата каждого действия
configure_nginx() {
  run_once nginx-config prepare_nginx_config
  run_once nginx-tls prepare_nginx_tls
  run_once nginx-enable systemctl enable nginx.service
  run_once nginx-check nginx -t
  run_once nginx-restart systemctl restart nginx.service
}

#----------------------------------------------------------#
# Настройка PostgreSQL                                     #
#----------------------------------------------------------#

# Дополнение правил доступа без повторяющихся строк при возобновлении
prepare_postgresql_config() {
  local pg_hba="/etc/postgresql/$pg_version/main/pg_hba.conf"
  local pg_config="/etc/postgresql/$pg_version/main/postgresql.conf"
  local setting pg_address=127.0.0.1/32 pg_listen=127.0.0.1
  if [ "$pg_remote" = yes ]; then
    pg_address=0.0.0.0/0; pg_listen="*"
  elif [ "$pg_remote" = lan ]; then
    pg_address=192.168.0.0/16; pg_listen="*"
  fi
  backup_config "$pg_hba" pg_hba.conf.original
  backup_config "$pg_config" postgresql.conf.original
  for setting in "# Доступ для ProjectDB" "host    all             all             $pg_address               md5"; do
    if ! grep -Fxq -- "$setting" "$pg_hba"; then
      printf '%s\n' "$setting" >> "$pg_hba"
    fi
  done
  for setting in "# Настройки ProjectDB" "listen_addresses = '$pg_listen'" "port = $pg_port"; do
    if ! grep -Fxq -- "$setting" "$pg_config"; then
      printf '%s\n' "$setting" >> "$pg_config"
    fi
  done
}

# Запуск или проверка уже работающего кластера выбранной версии
start_postgresql() {
  pg_ctlcluster "$pg_version" main start || pg_ctlcluster "$pg_version" main status
}

# Повторная попытка не удаляет существующую базу и не меняет её содержимое
create_database() {
  valid_database_name "$pg_database" || fail 1
  sudo -u postgres psql --cluster "$pg_version/main" -p "$pg_port" -d postgres -X -v ON_ERROR_STOP=1 -v db_name="$pg_database" <<'PDB_SQL'
SELECT format('CREATE DATABASE %I', :'db_name')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db_name')
\gexec
PDB_SQL
}

# Сохранение доступа к локальной базе для команд PostgreSQL от имени root
save_pgpass() {
  local pg_home pg_file
  error_message="Could not save the PostgreSQL password file in the root home directory."
  pg_home=$(getent passwd root | cut -d: -f6)
  if [ -z "$pg_home" ] || [ ! -d "$pg_home" ]; then
    fail 1
  fi
  pg_file="$pg_home/.pgpass"
  # Не заменяем ссылки и специальные файлы; чужие записи подключения сохраняются
  if [ -L "$pg_file" ] || { [ -e "$pg_file" ] && [ ! -f "$pg_file" ]; }; then
    fail 1
  fi
  if ! [[ "$pg_pass" =~ ^[A-Za-z0-9]{20}$ ]]; then
    fail 1
  fi

  # Новый файл сразу закрыт от других пользователей и заменяет старый целиком
  state_temp=$(mktemp "$pg_home/.pgpass.XXXXXX")
  chmod 600 "$state_temp"
  # Локальные адреса ограничивают применение пароля этим сервером и портом
  printf 'localhost:%s:%s:postgres:%s\n127.0.0.1:%s:%s:postgres:%s\n' \
    "$pg_port" "$pg_database" "$pg_pass" "$pg_port" "$pg_database" "$pg_pass" > "$state_temp"
  if [ -f "$pg_file" ]; then
    awk -F: -v port="$pg_port" -v database="$pg_database" '
      !(($1 == "localhost" || $1 == "127.0.0.1") && $2 == port &&
        ($3 == database || $3 == "*") && $4 == "postgres") { print }
    ' "$pg_file" >> "$state_temp"
  fi
  sync -f "$state_temp"
  mv -f -- "$state_temp" "$pg_file"
  sync -f "$pg_home"
  state_temp=""
}

# Сохранение пароля до применения, чтобы повторный запуск использовал то же значение
configure_postgresql() {
  if [ ! -f "$state_dir/pg-password" ]; then
    pg_pass=$(gen_pass)
    save_state pg-password "$pg_pass"
  fi
  pg_pass=$(cat "$state_dir/pg-password")
  if ! [[ "$pg_pass" =~ ^[A-Za-z0-9]{20}$ ]]; then
    error_message="The saved database password is invalid. Check the installation state."
    fail 1
  fi

  run_once pg-start start_postgresql
  run_once pg-password sudo -u postgres psql --cluster "$pg_version/main" -v ON_ERROR_STOP=1 -c "ALTER USER postgres WITH PASSWORD '$pg_pass'"
  run_once pg-config prepare_postgresql_config
  run_once pg-restart pg_ctlcluster "$pg_version" main restart
  run_once pg-ready sudo -u postgres pg_isready --cluster "$pg_version/main" -p "$pg_port"
  run_once pg-database create_database
}

#----------------------------------------------------------#
# Проверка установленных компонентов                       #
#----------------------------------------------------------#

# Проверка результата выполняется при каждом продолжении, даже если этапы уже отмечены
verify_installation() {
  stage="Verifying installation"
  error_message="Final verification failed. See the installation log and run the installer again after fixing the problem."
  node --version
  projectdb --help
  php7.2 -r 'foreach (["mbstring", "dom", "gd", "zip"] as $ext) { if (!extension_loaded($ext)) { exit(1); } }'
  if [ "$nginx" = yes ]; then
    nginx -t
    systemctl is-active --quiet nginx.service
  fi
  if [ "$postgresql" = yes ]; then
    sudo -u postgres psql --cluster "$pg_version/main" -p "$pg_port" -d "$pg_database" -X -v ON_ERROR_STOP=1 -Atc 'SELECT 1'
  fi
}

#----------------------------------------------------------#
# Последовательное выполнение этапов                       #
#----------------------------------------------------------#

# Последовательное выполнение этапов с сохранением результата
check_ssh_choices
run_stage swap "Configuring swap memory" configure_swap
run_stage network "Configuring the network" configure_network
run_stage system "Updating the system" update_system
run_stage repositories "Adding software repositories" configure_repositories
run_stage packages "Installing required software" install_packages
run_stage firewall "Configuring the firewall" configure_firewall
run_stage projectdb "Installing ProjectDB" install_projectdb
if [ "$nginx" = yes ]; then
  run_stage nginx "Configuring the web server" configure_nginx
fi
if [ "$postgresql" = yes ]; then
  run_stage postgresql "Configuring the database" configure_postgresql
  pg_pass=$(cat "$state_dir/pg-password")
  # Выполняется и при продолжении с уже завершённым этапом настройки базы
  save_pgpass
fi

run_stage verification "Verifying installation" verify_installation

#----------------------------------------------------------#
# Итог установки и очистка состояния                       #
#----------------------------------------------------------#

if [ "$postgresql" = yes ]; then
  ui_message '\nPostgreSQL %s:\n  Database: %s\n  Port: %s\n  User: postgres\n  Password: %s\n' \
    "$pg_version" "$pg_database" "$pg_port" "$pg_pass"
  if [ "$pg_remote" = yes ]; then
    ui_message '  Access: any IPv4 address (0.0.0.0/0)\n'
  elif [ "$pg_remote" = lan ]; then
    ui_message '  Access: 127.0.0.1 and local network (192.168.0.0/16)\n'
  else
    ui_message '  Access: this server only (127.0.0.1)\n'
  fi
fi

ui_message '\nFor help with ProjectDB, run: projectdb --help\n'

# Запрет повторной установки после успешного завершения всех этапов
save_state complete complete

# После показа итоговых данных удаляются пароль, резервные и временные файлы
error_message="Installation completed, but recovery files could not be removed. Run the installer again to retry cleanup."
cleanup_completed_state
unset pg_pass

# Длительность только текущего запуска; время прошлых попыток не суммируется
installation_elapsed=$((SECONDS - installation_started))
# Итог без паролей сохраняется и в техническом журнале
printf 'Installation completed successfully. Duration: %s seconds.\n' "$installation_elapsed"
ui_message '\nInstallation time: %02dm %02ds\n' \
  "$((installation_elapsed / 60))" \
  "$((installation_elapsed % 60))"
# Итоговый прогресс остаётся последней строкой после всех сообщений
progress "$total_steps" "ProjectDB installation completed"
finish_progress
