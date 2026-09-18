#!/bin/bash
# Установщик ProjectDB
# https://projectdb.pro
set -Eeuo pipefail

#----------------------------------------------------------#
# Поддерживаемые операционные системы                      #
#----------------------------------------------------------#
# Debian 12, 13                                            #
# Ubuntu 22.04, 24.04                                      #
#----------------------------------------------------------#

#----------------------------------------------------------#
# Проверка прав и выбор установщика ОС                     #
#----------------------------------------------------------#

# Проверка прав администратора
if [ "x$(id -u)" != "x0" ]; then
  echo "[PDB][ERROR] this script can only be executed by the root user."
  exit 1
fi

# Определение и проверка ОС до загрузки файлов и внесения изменений.
if [ ! -r /etc/os-release ]; then
  echo "[PDB][ERROR] Cannot identify this operating system. Supported systems: Debian 12, 13 and Ubuntu 22.04, 24.04."
  exit 1
fi

# Чтение сведений о системе для выбора установщика Debian или Ubuntu
. /etc/os-release

# Проверка сочетания названия, версии и кодового имени ОС
# Неподдерживаемые системы отклоняются до загрузки установщика
case "${ID:-}:${VERSION_ID:-}:${VERSION_CODENAME:-}" in
  debian:12:bookworm|debian:13:trixie) type="debian" ;;
  ubuntu:22.04:jammy|ubuntu:24.04:noble) type="ubuntu" ;;
  *)
    echo "[PDB][ERROR] Unsupported operating system. Supported systems: Debian 12, 13 and Ubuntu 22.04, 24.04."
    exit 1
  ;;
esac

#----------------------------------------------------------#
# Проверка завершения установки                            #
#----------------------------------------------------------#

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

data_dir="$HOME/.projectdb"
state_dir="$data_dir/install/server"
prepare_storage() {
  error_message="Could not prepare the ProjectDB data directory."
  [ ! -L "$data_dir" ] || fail 1
  install -d -m 700 "$data_dir" "$data_dir/log" "$data_dir/tmp" "$data_dir/install"
}

fail() { echo "[PDB][ERROR] $error_message"; exit "$1"; }
trap 'fail $?' ERR
prepare_storage

# Успешная установка блокируется ещё до повторной загрузки скрипта
if [ -f "$state_dir/complete" ]; then
  # Повторный запуск завершает очистку, если она была прервана
  exec 9> "$state_dir/lock" || exit 1
  if ! flock -n 9; then
    echo "[PDB][ERROR] Another ProjectDB installation is already running."
    exit 1
  fi
  if ! cleanup_completed_state; then
    echo "[PDB][ERROR] Installation completed, but recovery files could not be removed. Run the installer again to retry cleanup."
    exit 1
  fi
  echo "ProjectDB installation has already completed successfully. Nothing to do."
  exit 0
fi

#----------------------------------------------------------#
# Загрузка и запуск установщика ОС                         #
#----------------------------------------------------------#

# Проверка наличия curl
if [ -e "/usr/bin/curl" ]; then
  # Отдельный временный файл исключает конфликт параллельных загрузок
  install -d -m 700 "$data_dir" "$data_dir/tmp" || exit 1
  installer_file=$(mktemp "$data_dir/tmp/projectdb-installer.XXXXXX.sh") || exit 1
  trap 'rm -f -- "$installer_file"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  # Запуск только после успешной загрузки полного файла
  if curl -fsSL -o "$installer_file" "https://raw.githubusercontent.com/pavel-elblaus/projectdb/master/dist/pdb-install-$type.sh"; then
    install_status=0
    bash "$installer_file" "$@" || install_status=$?
    exit "$install_status"
  else
    echo "[PDB][ERROR] Could not download the ProjectDB installer."
    exit 1
  fi
fi

echo "[PDB][ERROR] Please install curl and try again."
exit 1
