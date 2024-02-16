<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://projectdb.pro/catalog-pdb/repository-open-graph-projectdb-dark.png">
  <img alt="ProjectDB" src="https://projectdb.pro/catalog-pdb/repository-open-graph-projectdb.png">
</picture>

ProjectDB is a user-friendly tool for creating information systems. Efficient and easy tool for creating information systems and solving wide variety of problems of your business. From easy catalogs to advanced systems, which covers all structure of company.

Official website: [https://projectdb.pro](https://projectdb.pro)

[![npm Package](https://img.shields.io/npm/v/projectdb.svg?color=00a7e1)](https://www.npmjs.org/package/projectdb)
[![downloads per year](https://img.shields.io/npm/dy/projectdb.svg)](https://npmcharts.com/compare/projectdb?minimal=true)
[![GitHub Release](https://img.shields.io/github/v/release/pavel-elblaus/projectdb?color=04a589)](https://github.com/pavel-elblaus/projectdb/releases/latest)
[![License](https://img.shields.io/npm/l/projectdb.svg)](https://github.com/pavel-elblaus/projectdb/blob/master/LICENSE)

## Requirements

- Linux or Windows (stable)
- Node.js 18.x or newer
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
  start [options] <servername>      # starting process by name
  enable [options] <servername>     # enable the service to start on boot
  disable <servername>              # disables starting the service on boot
  pm2-start [options] <servername>  # starting process by name on process manager
  pm2-restart <servername>          # restarting process by name on process manager
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

### Install application not last release
If necessary, you can install the desired release by copying from the [GitHub repository](https://github.com/pavel-elblaus/projectdb/releases) to the application's working directory `./lib/app.so`

## Quick start on your new server

Currently supported operating systems:
- Debian 10, 11, 12
- Ubuntu 20.04, 22.04

### How to install ProjectDB

```bash
# Connect to the server as root via SSH
$ ssh root@your.server
# Download installation script
$ curl -O https://raw.githubusercontent.com/pavel-elblaus/projectdb/master/dist/pdb-install.sh
# Run it
$ bash pdb-install.sh
```
ProjectDB can be automatically installed on a Debian or Ubuntu server. For a smooth installation, you will need a clean "minimal install base" system.

## Do you have any questions?
Ask a Question [here](https://projectdb.pro/question/)