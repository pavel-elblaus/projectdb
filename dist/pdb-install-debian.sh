#!/bin/bash
# ProjectDB Debian installer

#----------------------------------------------------------#
#                  Variables/Functions                     #
#----------------------------------------------------------#

memory=$(grep "SwapTotal" /proc/meminfo |tr " " "\n" |grep [0-9])
release=$(cat /etc/debian_version|grep -o [0-9]|head -n1)
codename="$(cat /etc/os-release |grep VERSION= |cut -f 2 -d \(|cut -f 1 -d \))"
pg_port=5780
apt=/etc/apt/sources.list.d
gpg=/etc/apt/trusted.gpg.d

# Check support OS - Debian 10, 11, 12
if [ ! "$codename" = "buster" ] && [ ! "$codename" = "bullseye" ] && [ ! "$codename" = "bookworm" ]; then
  echo "[PDB][ERROR] sorry, but this ($codename) version of the operating system is not supported for automatic installation."
  exit 1
fi

# Request information for installation
read -p "Would you like install \"Nginx Web Server\" [y/n]: " answer
if [ "$answer" = "y" ] || [ "$answer" = "Y"  ]; then
  nginx="yes"
fi
read -p "Would you like install \"PostgreSQL Database Server\" [y/n]: " answer
if [ "$answer" = "y" ] || [ "$answer" = "Y"  ]; then
  postgresql="yes"
fi

# Function password generation
gen_pass() {
  chars="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  length=20
  while [ ${n:=1} -le $length ]; do
    pass="$pass${chars:$(($RANDOM%${#chars})):1}"
    let n+=1
  done
  echo "$pass"
}

# Function return code check
check_result() {
  if [ $1 -ne 0 ]; then
    echo "[PDB][ERROR] $2"
    exit $1
  fi
}

#----------------------------------------------------------#
#                      Checking swap                       #
#----------------------------------------------------------#

if [ -z "$(swapon -s)" ] && [ $memory -lt 3000000 ]; then
  fallocate -l 3G /swapfile > /dev/null
  chmod 600 /swapfile > /dev/null
  mkswap /swapfile > /dev/null
  swapon /swapfile > /dev/null
  echo "/swapfile   none    swap    sw    0   0" >> /etc/fstab
fi

#----------------------------------------------------------#
#                   Install repository                     #
#----------------------------------------------------------#

# Updating system
apt-get -y upgrade
check_result $? "apt-get upgrade failed"

# Node.js repository
curl -sL https://deb.nodesource.com/setup_18.x | bash - > /dev/null

# PHP 7.2 repository
echo "deb https://packages.sury.org/php/ $codename main" > $apt/php.list
curl -sS https://packages.sury.org/php/apt.gpg | gpg --dearmor | tee $gpg/packages.sury.org.gpg > /dev/null

# Nginx repository
if [ "$nginx" = "yes" ]; then
  echo "deb https://nginx.org/packages/debian $codename nginx" > $apt/nginx.list
  curl -sS https://nginx.org/keys/nginx_signing.key | gpg --dearmor | tee $gpg/nginx.org.gpg > /dev/null
fi

# PostgreSQL 16 repository
if [ "$postgresql" = "yes" ]; then
  echo "deb https://apt.postgresql.org/pub/repos/apt $codename-pgdg main" > $apt/pgdg.list
  curl -sS https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor | tee $gpg/apt.postgresql.org.gpg > /dev/null
fi

# Update system packages
apt-get update

#----------------------------------------------------------#
#                     Install packages                     #
#----------------------------------------------------------#

# Software package
software="sudo htop mc nodejs php7.2-cli php7.2-mbstring php7.2-xml php7.2-gd php7.2-zip lame ufw"
# add Nginx
if [ "$nginx" = "yes" ]; then
  software="$software nginx"
fi
# add PostgreSQL 16
if [ "$postgresql" = "yes" ]; then
  software="$software postgresql-16"
fi

# Installing apt packages
apt-get -y install $software
check_result $? "apt-get install failed"

#----------------------------------------------------------#
#                     Configure system                     #
#----------------------------------------------------------#

# Enable firewall
ufw default deny incoming > /dev/null
ufw default allow outgoing > /dev/null
# from ssh
ufw allow 22 > /dev/null
# from webserver
ufw allow 80 > /dev/null
ufw allow 443 > /dev/null
# from database
if [ "$postgresql" = "yes" ]; then
  ufw allow $pg_port > /dev/null
fi
# start
ufw --force enable

#----------------------------------------------------------#
#                  Installing ProjectDB                    #
#----------------------------------------------------------#

npm install projectdb -g
check_result $? "npm install projectdb failed"

#----------------------------------------------------------#
#                     Configure Nginx                      #
#----------------------------------------------------------#

if [ "$nginx" = "yes" ]; then
  # set config
  rm -f /etc/nginx/conf.d/*.conf
  mv -f /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak
  cp -f /usr/lib/node_modules/projectdb/dist/nginx.conf /etc/nginx/
  # generation ssl
  openssl dhparam -out /etc/nginx/dhparam.pem 2048
  # enable autostart
  systemctl enable nginx.service
  # start
  systemctl start nginx.service
  check_result $? "nginx start failed"
fi

#----------------------------------------------------------#
#                   Configure PostgreSQL                   #
#----------------------------------------------------------#

if [ "$postgresql" = "yes" ]; then
  pg_pass=$(gen_pass)
  # set password
  sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD '$pg_pass'"
  # add access
  pg_hba="/etc/postgresql/16/main/pg_hba.conf"
  echo "# Allow from ProjectDB" >> $pg_hba
  echo "host    all             all             0.0.0.0/0               md5" >> $pg_hba
  # add config
  pg_config="/etc/postgresql/16/main/postgresql.conf"
  echo "# Configuration from ProjectDB" >> $pg_config
  echo "listen_addresses = '*'" >> $pg_config
  echo "port = $pg_port" >> $pg_config
  # restart
  systemctl restart postgresql
  check_result $? "postgresql start failed"
fi

#----------------------------------------------------------#
#                   Configure ProjectDB                    #
#----------------------------------------------------------#

/usr/lib/node_modules/projectdb/node_modules/pm2/bin/pm2 startup > /dev/null

#----------------------------------------------------------#
#                     Congratulations                      #
#----------------------------------------------------------#

echo "
--------------------------------------------------------------------------------------------------

                 Congratulations, you have just successfully installed ProjectDB

--------------------------------------------------------------------------------------------------

"
projectdb --help
if [ "$postgresql" = "yes" ]; then
  echo "
PostgreSQL configuration:
  port $pg_port
  user postgres
  password $pg_pass"
fi
echo "
We hope you enjoy ProjectDB. Please feel free to contact us at any time if you have any questions.
Thank you.

--
Sincerely yours
projectdb team

"