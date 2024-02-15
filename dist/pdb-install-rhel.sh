#!/bin/bash
# ProjectDB RHEL/CentOS installer

#----------------------------------------------------------#
#                  Variables/Functions                     #
#----------------------------------------------------------#

memory=$(grep "SwapTotal" /proc/meminfo |tr " " "\n" |grep [0-9])
release=$(grep -o "[0-9]" /etc/redhat-release |head -n1)
pg_port=5780

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
yum -y update
check_result $? "yum update failed"
# add repo
repo="*base,*updates,epel"

# Node.js repository
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash - > /dev/null
# add repo
repo="$repo,nodesource"

# PHP 7.2 repository
rrepo="/etc/yum.repos.d/remi-php72.repo"
echo "[remi-php72]" > $rrepo
echo "name=Remi's PHP 7.2 repo" >> $rrepo
echo "baseurl=http://rpms.remirepo.net/enterprise/$release/php72/\$basearch/" >> $rrepo
echo "gpgcheck=0" >> $rrepo
echo "enabled=1" >> $rrepo
rrepo="/etc/yum.repos.d/remi-safe.repo"
echo "[remi-safe]" > $rrepo
echo "name=Safe Remi's repo" >> $rrepo
echo "baseurl=http://rpms.remirepo.net/enterprise/$release/safe/\$basearch/" >> $rrepo
echo "gpgcheck=0" >> $rrepo
echo "enabled=1" >> $rrepo
# add repo
repo="$repo,remi-php72,remi-safe"

# Nginx repository
if [ "$nginx" = "yes" ]; then
  nrepo="/etc/yum.repos.d/nginx.repo"
  echo "[nginx]" > $nrepo
  echo "name=Nginx repo" >> $nrepo
  echo "baseurl=http://nginx.org/packages/centos/$release/\$basearch/" >> $nrepo
  echo "gpgcheck=0" >> $nrepo
  echo "enabled=1" >> $nrepo
  # add repo
  repo="$repo,nginx"
fi

# PostgreSQL 12 repository
if [ "$postgresql" = "yes" ]; then
  prepo="/etc/yum.repos.d/pgdg12.repo"
  echo "[pgdg12]" > $prepo
  echo "name=PostgreSQL 12 repo" >> $prepo
  echo "baseurl=https://download.postgresql.org/pub/repos/yum/12/redhat/rhel-$release-\$basearch" >> $prepo
  echo "gpgcheck=0" >> $prepo
  echo "enabled=1" >> $prepo
  # add repo
  repo="$repo,pgdg12"
fi

#----------------------------------------------------------#
#                     Install packages                     #
#----------------------------------------------------------#

# Software package
software="htop mc nodejs php-cli php-mbstring php-dom php-gd php-zip lame"
# add Nginx
if [ "$nginx" = "yes" ]; then
  software="$software nginx"
fi
# add PostgreSQL 12
if [ "$postgresql" = "yes" ]; then
  software="$software postgresql12-server postgresql12-contrib"
fi

# Installing rpm packages
yum -y --disablerepo=* --enablerepo=$repo install $software
check_result $? "yum install failed"

#----------------------------------------------------------#
#                     Configure system                     #
#----------------------------------------------------------#

# Disabling SELinux
if [ -e "/etc/sysconfig/selinux" ]; then
  sed -i "s/SELINUX=enforcing/SELINUX=disabled/g" /etc/sysconfig/selinux
  sed -i "s/SELINUX=enforcing/SELINUX=disabled/g" /etc/selinux/config
  setenforce 0 2 > /dev/null
fi

# Enable firewalld
systemctl enable firewalld.service
systemctl start firewalld.service
# from webserver
firewall-cmd --permanent --zone=public --add-port=80/tcp > /dev/null
firewall-cmd --permanent --zone=public --add-port=443/tcp > /dev/null
# from database
if [ "$postgresql" = "yes" ]; then
  firewall-cmd --permanent --zone=public --add-port=$pg_port/tcp > /dev/null
fi
firewall-cmd --reload > /dev/null

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
  # init
  /usr/pgsql-12/bin/postgresql-12-setup initdb
  # enable autostart
  systemctl enable postgresql-12.service
  # start
  systemctl start postgresql-12.service
  # set password
  sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD '$pg_pass'"
  # add access
  pg_hba="/var/lib/pgsql/12/data/pg_hba.conf"
  echo "# Allow from ProjectDB" >> $pg_hba
  echo "host    all             all             0.0.0.0/0               md5" >> $pg_hba
  # add config
  pg_config="/var/lib/pgsql/12/data/postgresql.conf"
  echo "# Configuration from ProjectDB" >> $pg_config
  echo "listen_addresses = '*'" >> $pg_config
  echo "port = $pg_port" >> $pg_config
  # restart
  systemctl restart postgresql-12.service
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