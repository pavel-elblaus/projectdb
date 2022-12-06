<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://projectdb.pro/catalog-pdb/repository-open-graph-projectdb-dark.png">
  <img alt="" src="https://projectdb.pro/catalog-pdb/repository-open-graph-projectdb.png">
</picture>

ProjectDB is a user-friendly tool for creating information systems. Efficient and easy tool for creating information systems and solving wide variety of problems of your business. From easy catalogs to advanced systems, which covers all structure of company.

Official website: [https://projectdb.pro](https://projectdb.pro)

### Installing ProjectDB
```bash
$ npm install projectdb
```

After installing it, run `projectdb --help` without arguments to see list of options:

```bash
projectdb [options] <input>

  Options:
    --help         # output usage information
    --version      # output projectdb version
    --enable       # enable the service to start on boot
    --disable      # disables starting the service on boot
    --start        # starting process by name
    --stop         # stop all your active processes or select
    --pm2-start    # starting process by name on process manager
    --pm2-stop     # stop all your active processes or select on process manager

  Examples:
  # Starting process by name
  $ projectdb --start PDB-SERVER
  # Stopping all process
  $ projectdb --stop
```

Works on Linux (stable) & Windows (stable). All Node.js versions are supported starting Node.js 14.X.

### Updating ProjectDB
```bash
$ npm install projectdb@latest
```

### Do you have any questions?
Ask a Question [here](https://projectdb.pro/question/)