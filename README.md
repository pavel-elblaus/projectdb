<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://projectdb.pro/catalog-pdb/repository-open-graph-projectdb-dark.png">
  <img alt="ProjectDB" src="https://projectdb.pro/catalog-pdb/repository-open-graph-projectdb.png">
</picture>

ProjectDB is a user-friendly tool for creating information systems. Efficient and easy tool for creating information systems and solving wide variety of problems of your business. From easy catalogs to advanced systems, which covers all structure of company.

Official website: [https://projectdb.pro](https://projectdb.pro)

## Requirements

- Linux or Windows (stable)
- Node.js 16.x or newer
- PHP 5.6 or 7.0 - 7.2 and `mbstring, dom, gd, zip` modules
- LAME (optional) [view installation instructions](https://github.com/devowlio/node-lame#install-on-debian)

## Installation
You can install it with `npm`:
```bash
$ npm install projectdb -g
```

After installing it, run `projectdb --help` without arguments to see list of options and commands:

```console
Usage: projectdb [options] [command]

::: User friendly tool for creating information systems :::

Options:
  -v, --version                     # output projectdb version
  -h, --help                        # output usage information

Commands:
  start <servername>                # starting process by name
  enable [options] <servername>     # enable the service to start on boot
  disable <servername>              # disables starting the service on boot
  pm2-start [options] <servername>  # starting process by name on process manager
  pm2-stop [servername]             # stop all active processes or select on process manager

Examples:
  # Starting process by name
  $ projectdb start PDB-SERVER
  # Help on command
  $ projectdb pm2-start --help
  # Stopping all process on process manager
  $ projectdb pm2-stop
```
We hope you enjoy ProjectDB. Please feel free to [contact us](https://projectdb.pro/question/) at any time if you have any questions.
Thank you.

### Updating ProjectDB to latest version
```bash
$ npm install projectdb@latest -g
```

## Quick start on your new server

Currently supported operating systems:
- RHEL/CentOS 7
- Debian 10, 11
- Ubuntu 18.04, 20.04, 22.04

### How to install ProjectDB

```bash
# Connect to the server as root via SSH
$ ssh root@your.server
# Download installation script
$ curl -O https://raw.github.com/pavel-elblaus/projectdb/master/dist/pdb-install.sh
# Run it
$ bash pdb-install.sh
```
The ProjectDB can be installed on a RHEL, CentOS, Debian and Ubuntu server. For a smooth installation you will need clean system "minimal install base".

## Do you have any questions?
Ask a Question [here](https://projectdb.pro/question/)