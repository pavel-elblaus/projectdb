#!/bin/bash
# ProjectDB Ubuntu installer

#----------------------------------------------------------#
#                  Variables/Functions                     #
#----------------------------------------------------------#

memory=$(grep "SwapTotal" /proc/meminfo |tr " " "\n" |grep [0-9])
release="$(lsb_release -s -r)"
codename="$(lsb_release -s -c)"
pg_port=5780
apt=/etc/apt/sources.list.d
gpg=/etc/apt/trusted.gpg.d

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
apt-get -y install software-properties-common
check_result $? "apt-get install php repo failed"
add-apt-repository -y ppa:ondrej/php

# Nginx repository
if [ "$nginx" = "yes" ]; then
  echo "deb https://nginx.org/packages/ubuntu $codename nginx" > $apt/nginx.list
  curl -sS https://nginx.org/keys/nginx_signing.key | gpg --dearmor | tee $gpg/nginx.org.gpg > /dev/null
fi

# PostgreSQL 12 repository
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
software="htop mc nodejs php7.2-cli php7.2-mbstring php7.2-xml php7.2-gd php7.2-zip lame ufw"
# add Nginx
if [ "$nginx" = "yes" ]; then
  software="$software nginx"
fi
# add PostgreSQL 12
if [ "$postgresql" = "yes" ]; then
  software="$software postgresql-12"
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
  pg_hba="/etc/postgresql/12/main/pg_hba.conf"
  echo "# Allow from ProjectDB" >> $pg_hba
  echo "host    all             all             0.0.0.0/0               md5" >> $pg_hba
  # add config
  pg_config="/etc/postgresql/12/main/postgresql.conf"
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