<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://projectdb.pro/catalog-pdb/repository-open-graph-projectdb-dark.png">
  <img alt="ProjectDB" src="https://projectdb.pro/catalog-pdb/repository-open-graph-projectdb.png">
</picture>

ProjectDB is a user-friendly tool for creating information systems. Efficient and easy tool for creating information systems and solving wide variety of problems of your business. From easy catalogs to advanced systems, which covers all structure of company.

Official website: [https://projectdb.pro](https://projectdb.pro)

### Installing ProjectDB
```bash
$ npm install projectdb -g
```

After installing it, run `projectdb --help` without arguments to see list of options:

```bash
$ projectdb [options] [command]

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

### Do you have any questions?
Ask a Question [here](https://projectdb.pro/question/)