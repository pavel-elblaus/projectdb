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
- PHP 7.2 and `mbstring, dom, gd, zip` modules
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
  start [options] <servername>              # starting process by name
  service-start [options] <servername>      # create, enable and start the service
  service-restart <servername>              # restart the installed service
  service-stop <servername>                 # stop, disable and remove the service
  pm2-start [options] <servername>          # starting process by name on process manager
  pm2-restart <servername>                  # restarting process by name on process manager
  pm2-stop [servername]                     # stop all active processes or select on process manager

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

### Choose how to run ProjectDB

Use one of the following modes for each server name:

| Mode | Start | Restart | Stop |
| --- | --- | --- | --- |
| Current terminal | `projectdb start <servername>` | Run `start` again | Press `Ctrl+C` |
| Linux systemd service | `projectdb service-start <servername>` | `projectdb service-restart <servername>` | `projectdb service-stop <servername>` |
| PM2 | `projectdb pm2-start <servername>` | `projectdb pm2-restart <servername>` | `projectdb pm2-stop <servername>` |

The systemd mode is intended for a Linux server and starts ProjectDB automatically after reboot. PM2 mode uses the PM2 process manager. The terminal mode is convenient for a first launch, diagnostics, or manual operation.

Only one process with the same `servername` should run on a server. When you start it in another mode, ProjectDB stops the existing service or PM2 process with that exact name. Run these commands from the same operating-system account so an existing PM2 process can be found; service management is normally performed as `root`.

### Configure the database connection

The easiest first launch is:

```bash
$ projectdb start PDB-SERVER
```

If no configuration has been saved yet, ProjectDB asks whether to create one and then guides you through the database settings. The same setup is available with `service-start` and `pm2-start`.

You can save the settings for:

- one process in `db.<servername>.json`;
- all processes in the working directory in `db.json`.

The process-specific file has priority over the common file. Both are stored in the directory selected by `--work-path` (the current directory by default).

For a remote ProjectDB configuration server, pass its password instead of using the setup questions:

```bash
$ projectdb start PDB-SERVER --password PASSWORD
$ projectdb service-start PDB-SERVER --host node.projectdb.pro --password PASSWORD
$ projectdb pm2-start PDB-SERVER --host node.projectdb.pro --password PASSWORD
```

The remote settings are saved in `tmp/server/<servername>/cli.json`. If a local `db.<servername>.json` or `db.json` exists, ProjectDB uses it instead.

### Local configuration file

Both local configuration files use the following structure:

```json
{
  "user": "postgres",
  "pass": "",
  "host": "127.0.0.1",
  "port": 5780,
  "db": "my_database",
  "schema": "api_pdb",
  "min_connect": 1,
  "max_connect": 10,
  "channel": 1,
  "ssl": false
}
```

Replace `my_database` with the required database name; it has no default. The default schema is `api_pdb`. `min_connect` and `max_connect` set the connection limits for each worker, `channel` sets the number of active workers, and `ssl` enables an SSL connection.

Before saving, the setup shows all entered values for confirmation. Local configuration files are created with permissions `0600`. For a non-interactive launch, create one of these files beforehand or provide `--password` (and, when needed, `--host`).

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
