"use strict";
// загрузка базовых модулей
const { name, description, version } = require("../package.json");
const { print, exit } = require("./tools.js");
const { program } = require("commander");
const { pathExists, outputJson } = require("fs-extra");
const { join } = require("path");
const pm2 = require("pm2");

// вспомогательные переменные
let desc_format = str => "\x1b[32m::: " + str + " :::\x1b[0m";
let app_name = "\x1b[33m" + name + "\x1b[0m";

// настройка коммандера
program
	.name(app_name)
	.description(desc_format(description))
	.version(version, "-v, --version", "# output projectdb version")
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
program
	.command("start")
	.argument("<servername>", "# app server name")
	.description(desc_format("Starting process by name"))
	.summary("# starting process by name")
	.option("-w, --work-path [value]", "# application working directory", process.cwd())
	.action(function (servername, options) {
		// установка рабочей папки
		process.chdir(options.workPath);
		// запрос информации по имени в менеджере процессов
		pm2.describe(servername, function (err, proc){
			if(err) exit(err);
			// если есть запущено приложение
			if(proc instanceof Array && proc.length > 0){
				// удаление приложения по имени
				pm2.delete(servername, function (err){
					if(err) exit(err);
					print("Stopped " + servername);
					pm2.dump(true, function (err){
						if(err) exit(err);
						print("List process saved");
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
			// фиксируем имя запускаемого сервера
			process.env.PDB_SERVERNAME = servername;
			// запуск
			require("./index.js");
		}
	});

// команда установки локального сервиса для авто запуска приложения
program
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
program
	.command("disable")
	.argument("<servername>", "# app server name")
	.description(desc_format("Disables starting the service on boot"))
	.summary("# disables starting the service on boot")
	.action(function (servername) {
		// todo developing
		exit(new Error("command \"disable\" in developing"));
	});

// команда запуска приложения в процесс менеджере
program
	.command("pm2-start")
	.argument("<servername>", "# app server name")
	.description(desc_format("Starting process by name on process manager"))
	.summary("# starting process by name on process manager")
	.option("-w, --work-path [value]", "# application working directory", process.cwd())
	.option("-m, --memory-limit [value]", "# set nodejs max-old-space-size [in megabytes]", (v => isNaN(+v) ? 2048 : +v), 2048)
	.option("-s, --host [value]", "# host server keys", "node.projectdb.pro")
	.option("-p, --password [value]", "# config password")
	.option("-l, --link [secret-key,public-key]", "# pm2 link to connect the application dashboard", value => value.split(","))
	.action(function (servername, options) {
		// установка рабочей папки
		process.chdir(options.workPath);
		// todo при первом старте предложить создать файл конфигурации подключения к базе данных
		// проверка конфигурации подключения к базе данных
		let database_config = join(process.cwd(), "db.json");
		pathExists(database_config, function (err, exists){
			if(err) exit(err);
			// если есть файл конфигурации для базы данных
			if(exists){
				// запуск
				return callback();
			}
			// проверка конфигурации для процесса
			let servername_config = join(process.cwd(), "tmp", "server", servername, "cli.json");
			pathExists(servername_config, function (err, exists){
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
				outputJson(servername_config, { host: options.host, password: options.password }, function (err){
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
				pm2.agentInfos(function (err, info){
					// если есть данные по подключению и они совпадают, переходим к следующему шагу
					if(info && info.public_key === link[1] && info.secret_key === link[0]){
						print("PM2+ already activated!");
						// запуск
						callback();
					} else {
						// активация подключения pm2+ и запуск
						pm2.linkManagement(link[0], link[1], null, {}, callback);
					}
				});
				return;
			}
			// подключение, инициализация демона
			pm2.connect(function(err) {
				if(err) exit(err);
				// запуск приложения
				pm2.start({
					name: servername,
					script: join(__dirname, "index.js"),
					cwd: process.cwd(),
					node_args: "--max-old-space-size=" + options.memoryLimit,
					env: {
						NODE_ENV: "production",
						PDB_METRIC: "pm2",
						PDB_SERVERNAME: servername
					},
					output: "/dev/null",
					error: "/dev/null"
				}, function(err, proc) {
					if(err) exit(err);
					print("Started " + servername);
					// сохранение для последующего авто запуска
					pm2.dump(true, function (err){
						if(err) exit(err);
						print("List process saved");
						// запрос информация по активным приложениям демона
						pm2.list(function (err, proc){
							if(err) exit(err);
							print("Table active process " + proc.map(d => d.name + "-" + d.pid). join(", "))
							// остановка приложения
							exit();
						});
					});
				})
			})
		}
	});

// команда перезапуска приложения в процесс менеджере
program
	.command("pm2-restart")
	.argument("<servername>", "# app server name")
	.description(desc_format("Restarting process by name on process manager"))
	.summary("# restarting process by name on process manager")
	.action(function (servername) {
		// перезагрузка процесса
		pm2.reload(servername, function (err){
			if(err) exit(err);
			print("Restarted " + servername);
			// остановка приложения
			exit();
		})
	});

// команда остановки приложения или всего сервера процесс менеджера
program
	.command("pm2-stop")
	.argument("[servername]", "# app server name")
	.description(desc_format("Stop all active processes or select on process manager"))
	.summary("# stop all active processes or select on process manager")
	.action(function (servername) {
		// если не передано имя процесса, останавливаем все
		if(servername == null){
			// остановка демона
			pm2.killDaemon(function (err){
				if(err) exit(err);
				print("Kill daemon");
				// сохранение для последующего авто запуска
				pm2.dump(true, function (err){
					if(err) exit(err);
					print("List process saved");
					// отключение от панели управления
					pm2.killAgent(function (err){
						if(err) exit(err);
						print("Unlink application dashboard");
						// остановка приложения
						exit();
					})
				});
			});
			// стоп
			return;
		}
		// удаление приложения по имени
		pm2.delete(servername, function (err){
			if(err) exit(err);
			print("Stopped " + servername);
			pm2.dump(true, function (err){
				if(err) exit(err);
				print("List process saved");
				// остановка приложения
				exit();
			});
		});
	});

// инициализация
program.parse(process.argv);