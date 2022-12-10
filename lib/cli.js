"use strict";

const _projectdb = require("../package.json");
const _commander = require("commander").program;
const _fse = require("fs-extra");
const _path = require("path");
const _util = require("util");
const _pm2 = require("pm2");

// вспомогательные переменные
let desc_format = str => "\x1b[32m::: " + str + " :::\x1b[0m";
let app_name = "\x1b[33m" + _projectdb.name + "\x1b[0m";
// функция остановки приложения
let exit = function (err){
	// информация по ошибке
	if(err)
		console.error("\x1b[31m[PM2][ERROR]\x1b[0m", err instanceof Error ? err.message : _util.inspect(err, { compact: false, colors: true, depth: null }));
	// выход из приложения
	process.exit();
}

// настройка коммандера
_commander
	.name(app_name)
	.description(desc_format(_projectdb.description))
	.version(_projectdb.version, "-v, --version", "# output projectdb version")
	.helpOption("-h, --help", "# output usage information")
	.addHelpCommand(false)
	.configureOutput({
		outputError: (str, write) => write(`\x1b[31m${str}\x1b[0m`)
	})
	.addHelpText("after", `
Examples:
  # Starting process by name
  \x1b[31m$\x1b[0m `+ app_name +` start PDB-SERVER
  # Help on command
  \x1b[31m$\x1b[0m `+ app_name +` pm2-start --help
  # Stopping all process on process manager
  \x1b[31m$\x1b[0m `+ app_name +` pm2-stop`);

// команда запуска приложения в консольном режиме
_commander
	.command("start")
	.argument("<servername>", "# app server name")
	.description(desc_format("Starting process by name"))
	.summary("# starting process by name")
	.action(function (servername) {
		// запрос информации по имени в менеджере процессов
		_pm2.describe(servername, function (err, proc){
			if(err) exit(err);
			// если есть запущено приложение
			if(proc instanceof Array && proc.length > 0){
				// удаление приложения по имени
				_pm2.delete(servername, function (err){
					if(err) exit(err);
					console.log("\x1b[36m[PM2 I/O]\x1b[0m Stopped " + servername);
					_pm2.dump(true, function (err){
						if(err) exit(err);
						console.log("\x1b[36m[PM2 I/O]\x1b[0m List process saved");
						// запуск
						callback();
					});
				});
				// стоп
				return;
			}
			// запуск
			callback();
		});
		// обратный вызов
		let callback = function (){
			// todo времянка, необходимо передать имя например через process.env
			process.argv[2] = servername;
			process.argv.splice(3, 1);
			// запуск
			require("./app.js");
		}
	});

// команда установки локального сервиса для авто запуска приложения
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

// команда удаления локального сервиса авто запуска
_commander
	.command("disable")
	.argument("<servername>", "# app server name")
	.description(desc_format("Disables starting the service on boot"))
	.summary("# disables starting the service on boot")
	.action(function (servername) {
		// todo developing
		exit(new Error("command \"disable\" in developing"));
	});

// команда запуска приложения в процесс менеджере
_commander
	.command("pm2-start")
	.argument("<servername>", "# app server name")
	.description(desc_format("Starting process by name on process manager"))
	.summary("# starting process by name on process manager")
	.option("-s, --host [value]", "# host server keys", "node.projectdb.pro")
	.option("-p, --password [value]", "# config password")
	.option("-l, --link [secret-key,public-key]", "# pm2 link to connect the application dashboard", value => value.split(","))
	.action(function (servername, options) {
		// todo при первом старте предложить создать файл конфигурации подключения к базе данных
		// проверка конфигурации подключения к базе данных
		let database_config = _path.join(process.cwd(), "db.json");
		_fse.pathExists(database_config, function (err, exists){
			if(err) exit(err);
			// если есть файл конфигурации для базы данных
			if(exists){
				// запуск
				return callback();
			}
			// проверка конфигурации для процесса
			let servername_config = _path.join(process.cwd(), "tmp", "server", servername, "cli.json");
			_fse.pathExists(servername_config, function (err, exists){
				if(err) exit(err);
				// если есть файл конфигурации для процесса
				if(exists){
					// запуск
					return callback();
				}
				// проверка пароля, если не передан - ошибка
				if(options.password == null){
					exit(new Error("You did not enter password! set option --password [value]"))
				}
				// сохраняем
				_fse.outputJson(servername_config, { host: options.host, password: options.password }, function (err){
					if(err) exit(err);
					// запуск
					callback();
				});
			});
		});
		// обратный вызов
		let callback = function (){
			// если переданы данные для активации pm2+
			if(options.link != null){
				let link = options.link; delete options.link;
				// запрос состояния pm2+
				_pm2.agentInfos(function (err, info){
					// если есть данные по подключению и они совпадают, переходим к следующему шагу
					if(info && info.public_key === link[1] && info.secret_key === link[0]){
						console.log("\x1b[36m[PM2 I/O]\x1b[0m PM2+ already activated!");
						// запуск
						callback();
					} else {
						// активация подключения pm2+ и запуск
						_pm2.linkManagement(link[0], link[1], null, {}, callback);
					}
				});
				return;
			}
			// подключение, инициализация демона
			_pm2.connect(function(err) {
				if(err) exit(err);
				// запуск приложения
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
					// сохранение для последующего авто запуска
					_pm2.dump(true, function (err){
						if(err) exit(err);
						console.log("\x1b[36m[PM2 I/O]\x1b[0m List process saved");
						// запрос информация по активным приложениям демона
						_pm2.list(function (err, proc){
							if(err) exit(err);
							console.log("\x1b[36m[PM2 I/O]\x1b[0m Table active process", proc.map(d => d.name + "-" + d.pid). join(", "))
							// остановка приложения
							exit();
						});
					});
				})
			})
		}
	});

// команда остановки приложения или всего сервера процесс менеджера
_commander
	.command("pm2-stop")
	.argument("[servername]", "# app server name")
	.description(desc_format("Stop all active processes or select on process manager"))
	.summary("# stop all active processes or select on process manager")
	.action(function (servername) {
		// если не передано имя процесса, останавливаем все
		if(servername == null){
			// остановка демона
			_pm2.killDaemon(function (err){
				if(err) exit(err);
				console.log("\x1b[36m[PM2 I/O]\x1b[0m Kill daemon");
				// сохранение для последующего авто запуска
				_pm2.dump(true, function (err){
					if(err) exit(err);
					console.log("\x1b[36m[PM2 I/O]\x1b[0m List process saved");
					// отключение от панели управления
					_pm2.killAgent(function (err){
						if(err) exit(err);
						console.log("\x1b[36m[PM2 I/O]\x1b[0m Unlink application dashboard");
						// остановка приложения
						exit();
					})
				});
			});
			// стоп
			return;
		}
		// удаление приложения по имени
		_pm2.delete(servername, function (err){
			if(err) exit(err);
			console.log("\x1b[36m[PM2 I/O]\x1b[0m Stopped " + servername);
			_pm2.dump(true, function (err){
				if(err) exit(err);
				console.log("\x1b[36m[PM2 I/O]\x1b[0m List process saved");
				// остановка приложения
				exit();
			});
		});
	});

// инициализация
_commander.parse(process.argv);