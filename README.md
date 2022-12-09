<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://projectdb.pro/catalog-pdb/repository-open-graph-projectdb-dark.png">
  <img alt="ProjectDB" src="https://projectdb.pro/catalog-pdb/repository-open-graph-projectdb.png">
</picture>

ProjectDB is a user-friendly tool for creating information systems. Efficient and easy tool for creating information systems and solving wide variety of problems of your business. From easy catalogs to advanced systems, which covers all structure of company.

Official website: [https://projectdb.pro](https://projectdb.pro)

## Installing ProjectDB
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

Works on Linux (stable) & Windows (stable). All Node.js versions are supported starting Node.js 14.X.

### Updating ProjectDB
```bash
$ npm install projectdb@latest -g
```

## Installing dependent LAME package

If you have not installed [LAME](http://lame.sourceforge.net/) yet, please use the following instruction.

### Install on Debian
```bash
$ sudo apt-get install lame
```
### Install on CentOS
```bash
$ yum install lame
```

### Install on MacOS with brew
```bash
$ brew install lame
```

### Install on Windows
1. Go to the the [Lame Download Page](https://lame.buanzo.org/#lamewindl) and download the EXE or ZIP file.
2. Navigate to the directory Lame was installed in (most commonly `C:\Program Files (x86)\Lame For Audacity`).
3. Add the directory to your [Environment Variables](https://www.java.com/en/download/help/path.xml).

## Do you have any questions?
Ask a Question [here](https://projectdb.pro/question/)