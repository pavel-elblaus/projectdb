#!/bin/bash
# ProjectDB Installer
# https://projectdb.pro

#----------------------------------------------------------#
#          Currently supported operating systems           #
#----------------------------------------------------------#
#   Debian 10, 11, 12                                      #
#   Ubuntu 20.04, 22.04                                    #
#----------------------------------------------------------#

# Check root
if [ "x$(id -u)" != "x0" ]; then
  echo "[PDB][ERROR] this script can only be executed by the root user."
  exit 1
fi

# Detect OS
case $(head -n1 /etc/issue | cut -f 1 -d " ") in
  Debian)     type="debian" ;;
  Ubuntu)     type="ubuntu" ;;
  *)
    echo "[PDB][ERROR] sorry, but this operating system is not supported for automatic installation."
    exit 1
  ;;
esac

# Check curl
if [ -e "/usr/bin/curl" ]; then
  curl -O https://raw.githubusercontent.com/pavel-elblaus/projectdb/master/dist/pdb-install-$type.sh
  if [ "$?" -eq "0" ]; then
    # Start script
    bash pdb-install-$type.sh $*
    # Delete download script
    rm pdb-install-$type.sh
    exit
  else
    echo "[PDB][ERROR] pdb-install-$type.sh download failed."
    exit 1
  fi
fi

echo "[PDB][ERROR] please install curl and try again."
exit 1