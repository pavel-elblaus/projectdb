"use strict";

const _projectdb = require("../package.json");
const _commander = require("commander").program;
const _fse = require("fs-extra");
const _path = require("path");
const _util = require("util");
const _pm2 = require("pm2");

// ��������������� ����������
let desc_format = str => "\x1b[32m::: " + str + " :::\x1b[0m";
let app_name = "\x1b[33m" + _projectdb.name + "\x1b[0m";
// ������� ��������� ����������
let exit = function (err){
	// ���������� �� ������
	if(err)
		console.error("\x1b[31m[PM2][ERROR]\x1b[0m", err instanceof Error ? err.message : _util.inspect(err, { compact: false, colors: true, depth: null }));
	// ����� �� ����������
	process.exit();
}

// ��������� ����������
_commander
	.name(app_name)
	.description(desc_format(_projectdb.description))
	.version(_projectdb.version, "-v, --version", "# output projectdb version")
	.helpOption("-h, --help", "# output usage information")
	.addHelpCommand(false)
	.configureOutput({
		writeOut: (str) => process.stdout.write("\n  " + str.split("\n").join("\n  ")),
		writeErr: (str) => process.stdout.write("\n  " + str.split("\n").join("\n  ")),
		outputError: (str, write) => write(`\x1b[31m${str}\x1b[0m`)
	})
	.addHelpText("after", `Examples:
  # Starting process by name
  \x1b[31m$\x1b[0m `+ app_name +` start PDB-SERVER
  # Help on command
  \x1b[31m$\x1b[0m `+ app_name +` pm2-start --help
  # Stopping all process on process manager
  \x1b[31m$\x1b[0m `+ app_name +` pm2-stop`);

// ������� ������� ���������� � ���������� ������
_commander
	.command("start")
	.argument("<servername>", "# app server name")
	.description(desc_format("Starting process by name"))
	.summary("# starting process by name")
	.action(function (servername) {
		// ������ ���������� �� ����� � ��������� ���������
		_pm2.describe(servername, function (err, proc){
			if(err) exit(err);
			// ���� ���� �������� ����������
			if(proc instanceof Array && proc.length > 0){
				// �������� ���������� �� �����
				_pm2.delete(servername, function (err){
					if(err) exit(err);
					console.log("\x1b[36m[PM2 I/O]\x1b[0m Stopped " + servername);
					_pm2.dump(true, function (err){
						if(err) exit(err);
						console.log("\x1b[36m[PM2 I/O]\x1b[0m List process saved");
						// ������
						callback();
					});
				});
				// ����
				return;
			}
			// ������
			callback();
		});
		// �������� �����
		let callback = function (){
			// todo ��������, ���������� �������� ��� �������� ����� process.env
			process.argv[2] = servername;
			process.argv.splice(3, 1);
			// ������
			require("./app.js");
		}
	});

// ������� ��������� ���������� ������� ��� ���� ������� ����������
_commander
	.command("enable")
	.argument("<servername>", "# app server name")
	.description(desc_format("Enable the service to start on boot"))
	.summary("# enable the service to start on boot")
	.option("-s, --host [value]", "# host server keys", "node.projectdb.pro")
	.option("-p, --password [value]", "# config password")
	.action(function (servername, options) {
		// todo developing
		exit(new Error("command \"enable\" in developing"));
	});

// ������� �������� ���������� ������� ���� �������
_commander
	.command("disable")
	.argument("<servername>", "# app server name")
	.description(desc_format("Disables starting the service on boot"))
	.summary("# disables starting the service on boot")
	.action(function (servername) {
		// todo developing
		exit(new Error("command \"disable\" in developing"));
	});

// ������� ������� ���������� � ������� ���������
_commander
	.command("pm2-start")
	.argument("<servername>", "# app server name")
	.description(desc_format("Starting process by name on process manager"))
	.summary("# starting process by name on process manager")
	.option("-s, --host [value]", "# host server keys", "node.projectdb.pro")
	.option("-p, --password [value]", "# config password")
	.option("-l, --link [secret-key,public-key]", "# pm2 link to connect the application dashboard", value => value.split(","))
	.action(function (servername, options) {
		// todo ��� ������ ������ ���������� ������� ���� ������������ ����������� � ���� ������
		// �������� ������������ ����������� � ���� ������
		let database_config = _path.join(process.cwd(), "db.json");
		_fse.pathExists(database_config, function (err, exists){
			if(err) exit(err);
			// ���� ���� ���� ������������ ��� ���� ������
			if(exists){
				// ������
				return callback();
			}
			// �������� ������������ ��� ��������
			let servername_config = _path.join(process.cwd(), "tmp", "server", servername, "cli.json");
			_fse.pathExists(servername_config, function (err, exists){
				if(err) exit(err);
				// ���� ���� ���� ������������ ��� ��������
				if(exists){
					// ������
					return callback();
				}
				// �������� ������, ���� �� ������� - ������
				if(options.password == null){
					exit(new Error("You did not enter password! set option --password [value]"))
				}
				// ���������
				_fse.outputJson(servername_config, { host: options.host, password: options.password }, function (err){
					if(err) exit(err);
					// ������
					callback();
				});
			});
		});
		// �������� �����
		let callback = function (){
			// ���� �������� ������ ��� ��������� pm2+
			if(options.link != null){
				let link = options.link; delete options.link;
				// ������ ��������� pm2+
				_pm2.agentInfos(function (err, info){
					// ���� ���� ������ �� ����������� � ��� ���������, ��������� � ���������� ����
					if(info && info.public_key === link[1] && info.secret_key === link[0]){
						console.log("\x1b[36m[PM2 I/O]\x1b[0m PM2+ already activated!");
						// ������
						callback();
					} else {
						// ��������� ����������� pm2+ � ������
						_pm2.linkManagement(link[0], link[1], null, {}, callback);
					}
				});
				return;
			}
			// �����������, ������������� ������
			_pm2.connect(function(err) {
				if(err) exit(err);
				// ������ ����������
				_pm2.start({
					name: servername,
					script: "lib/app.js",
					node_args: "--max-old-space-size=2048",
					args: [ servername ],
					env: {
						NODE_ENV: "production"
					},
					output: "/dev/null",
					error: "/dev/null"
				}, function(err, proc) {
					if(err) exit(err);
					console.log("\x1b[36m[PM2 I/O]\x1b[0m Started " + servername);
					// ���������� ��� ������������ ���� �������
					_pm2.dump(true, function (err){
						if(err) exit(err);
						console.log("\x1b[36m[PM2 I/O]\x1b[0m List process saved");
						// ������ ���������� �� �������� ����������� ������
						_pm2.list(function (err, proc){
							if(err) exit(err);
							console.log("\x1b[36m[PM2 I/O]\x1b[0m Table active process", proc.map(d => d.name + "-" + d.pid). join(", "))
							// ��������� ����������
							exit();
						});
					});
				})
			})
		}
	});

// ������� ��������� ���������� ��� ����� ������� ������� ���������
_commander
	.command("pm2-stop")
	.argument("[servername]", "# app server name")
	.description(desc_format("Stop all active processes or select on process manager"))
	.summary("# stop all active processes or select on process manager")
	.action(function (servername) {
		// ���� �� �������� ��� ��������, ������������� ���
		if(servername == null){
			// ��������� ������
			_pm2.killDaemon(function (err){
				if(err) exit(err);
				console.log("\x1b[36m[PM2 I/O]\x1b[0m Kill daemon");
				// ���������� ��� ������������ ���� �������
				_pm2.dump(true, function (err){
					if(err) exit(err);
					console.log("\x1b[36m[PM2 I/O]\x1b[0m List process saved");
					// ���������� �� ������ ����������
					_pm2.killAgent(function (err){
						if(err) exit(err);
						console.log("\x1b[36m[PM2 I/O]\x1b[0m Unlink application dashboard");
						// ��������� ����������
						exit();
					})
				});
			});
			// ����
			return;
		}
		// �������� ���������� �� �����
		_pm2.delete(servername, function (err){
			if(err) exit(err);
			console.log("\x1b[36m[PM2 I/O]\x1b[0m Stopped " + servername);
			_pm2.dump(true, function (err){
				if(err) exit(err);
				console.log("\x1b[36m[PM2 I/O]\x1b[0m List process saved");
				// ��������� ����������
				exit();
			});
		});
	});

// �������������
_commander.parse(process.argv);