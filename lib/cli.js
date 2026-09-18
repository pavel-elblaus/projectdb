"use strict";
// загрузка информации о приложении и общих функций вывода
const { name, description, version } = require("../package.json");
const { print, exit } = require("./tools.js");

// загрузка модулей для разбора команд, работы с файлами и дочерними процессами
const { program, InvalidArgumentError } = require("commander");
const { chmod, pathExists, outputFile, outputJson, ensureDirSync, readJson, remove, readFileSync } = require("fs-extra");
const { execFile } = require("child_process");
const { basename, join } = require("path");
const { homedir } = require("os");
const { createInterface } = require("readline");

// оформление названия и описания команд для вывода в терминал
let desc_format = str => "\x1b[32m::: " + str + " :::\x1b[0m";
let app_name = "\x1b[33m" + name + "\x1b[0m";

// создание и назначение рабочей директории приложения
let set_home_dir_app = function (path){
	try{
		// создание директории, если она еще не существует
		ensureDirSync(path);
		// установка директории для всех относительных путей текущего запуска
		process.chdir(path);
	} catch (e){
		// сообщаем, если рабочую папку не удалось открыть или создать
		exit(new Error("It is not possible to set this directory \""+path+"\" as the application's home directory."))
	}
};

// запрос значения с проверкой и повтором при ошибке
let question = function (readline, text, default_value, parse, callback){
	// добавление выделенного цветом значения по умолчанию к тексту вопроса
	let suffix = default_value == null ? "" : " [\x1b[33m" + default_value + "\x1b[39m]";
	// каждый вопрос использует тот же префикс, что и стандартный информационный вывод
	let label = "[PDB I/O]";
	// строки после первой выравниваются по началу текста, а не по началу префикса
	let prompt = String(text).replace(/\r?\n/g, "\n" + " ".repeat(label.length + 1));
	readline.question("\x1b[36m" + label + "\x1b[0m " + prompt + suffix + ": ", function (answer){
		// пробелы в начале и конце ответа не считаются частью значения
		answer = answer.trim();
		// пустой ответ принимает предложенное значение по умолчанию
		if(answer === "" && default_value != null) answer = String(default_value);
		// проверка и преобразование введенного значения
		let value = parse(answer);
		if(value instanceof Error){
			// при ошибке повторяется только текущий вопрос
			readline.output.write("\x1b[31m[PDB][ERROR]\x1b[0m " + value.message + "\n");
			return question(readline, text, default_value, parse, callback);
		}
		// продолжение опроса с принятым ответом
		callback(value);
	});
};

// запись JSON-конфигурации с правами доступа только для владельца файла
let output_secure_json = function (path, data, callback){
	// mode применяется при создании нового файла
	outputJson(path, data, { spaces: "\t", mode: 0o600 }, function (err){
		if(err) return exit(err);
		// ограничиваем доступ также к ранее созданному файлу
		chmod(path, 0o600, function (err){
			if(err) return exit(err);
			callback();
		});
	});
};

// проверка существующего JSON-файла конфигурации
let config_exists = function (path, callback){
	// отсутствие файла является допустимым результатом проверки
	pathExists(path, function (err, exists){
		if(err) return exit(err);
		if(!exists) return callback(false);
		// чтение одновременно проверяет синтаксис JSON
		readJson(path, function (err, data){
			if(err) return exit(new Error("Invalid configuration file \"" + path + "\": " + err.message));
			// корневым значением конфигурации должен быть объект
			if(data == null || typeof data !== "object" || Array.isArray(data))
				return exit(new Error("Invalid configuration file \"" + path + "\": an object is required"));
			callback(true);
		});
	});
};

// преобразование и проверка целочисленного ответа
let parse_integer = function (name, min, max){
	return function (value){
		let number = Number(value);
		// проверка целого значения и разрешенного диапазона
		if(!Number.isInteger(number) || number < min || max != null && number > max)
			return new Error(name + " must be an integer from " + min + (max == null ? "" : " to " + max));
		return number;
	};
};

// преобразование ответа да/нет в логическое значение
let parse_yes_no = function (value){
	// поддержка короткой и полной формы ответа без учета регистра
	value = value.toLowerCase();
	if(value === "y" || value === "yes") return true;
	if(value === "n" || value === "no") return false;
	return new Error("Enter y or n");
};

// проверка servername для всех режимов запуска
let is_service_key = servername => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(servername);
let server_key = function (servername){
	// имя допускает буквы, цифры, точку, дефис и подчеркивание
	if(!is_service_key(servername))
		throw new InvalidArgumentError("may contain only letters, numbers, dots, underscores and hyphens");
	return servername;
};

// проверка пути из параметров командной строки
let work_path = function (value){
	// переносы строк запрещены во входном значении пути
	if(/[\r\n]/.test(value))
		throw new InvalidArgumentError("must not contain line breaks");
	return value;
};
let memory_limit = function (value){
	// лимит памяти передается Node.js как целое количество мегабайт
	let number = Number(value);
	if(!Number.isInteger(number) || number < 1)
		throw new InvalidArgumentError("must be a positive integer");
	return number;
};
let pm2_link = function (value){
	// параметр должен содержать пару непустых ключей PM2+
	let keys = value.split(",").map(value => value.trim());
	if(keys.length !== 2 || keys.some(value => value === ""))
		throw new InvalidArgumentError("must contain secret-key,public-key");
	return keys;
};

// интерактивное создание конфигурации локальной базы данных
let prompt_database_config = function (servername, process_database_config, common_database_config, callback){
	let config_error = "Configuration not found: create db." + servername + ".json or db.json, or set option --password <password>";
	// опрос доступен только при непосредственной работе пользователя с терминалом
	if(process.stdin.isTTY !== true || process.stdout.isTTY !== true)
		return exit(new Error(config_error));
	// один интерфейс используется для всей последовательности вопросов
	let readline = createInterface({ input: process.stdin, output: process.stdout });
	// заполнение и запись выбранного локального файла
	let create_config = function (database_config){
		// объект заполняется последовательно ответами из списка вопросов
		let config = {};
		let questions = [
			{ key: "user", text: "Database user", value: "postgres", parse: value => value },
			{ key: "pass", text: "Database password (leave empty if not required)", parse: value => value },
			{ key: "host", text: "Database host", value: "127.0.0.1", parse: value => value },
			{ key: "port", text: "Database port", value: 5780, parse: parse_integer("Port", 1, 65535) },
			{ key: "db", text: "Database name", parse: value => value === "" ? new Error("Database name is required") : value },
			{ key: "schema", text: "Database schema", value: "api_pdb", parse: value => value },
			{ key: "min_connect", text: "Minimum connections per worker", value: 1, parse: parse_integer("Minimum connections per worker", 0) },
			{ key: "max_connect", text: "Maximum connections per worker", value: 10, parse: function (value){
				// максимум дополнительно проверяется относительно уже введенного минимума
				let number = parse_integer("Maximum connections per worker", 1)(value);
				if(number instanceof Error) return number;
				if(number < config.min_connect) return new Error("Maximum connections per worker must not be less than minimum connections per worker");
				return number;
			} },
			{ key: "channel", text: "Active workers", value: 1, parse: parse_integer("Active workers", 1) },
			{ key: "ssl", text: "Use SSL", value: "n", parse: parse_yes_no }
		];
		// переход к следующему вопросу выполняется после успешной проверки ответа
		let next = function (index){
			if(index < questions.length){
				let item = questions[index];
				return question(readline, item.text, item.value, item.parse, function (value){
					// сохранение ответа в конфигурации
					config[item.key] = value;
					next(index + 1);
				});
			}
			// итоговая сводка позволяет проверить все значения перед записью
			let summary = `Please check that the entered data is correct
------------------------------------
User: ${config.user}
Password: ${config.pass}
Host: ${config.host}
Port: ${config.port}
Database: ${config.db}
Schema: ${config.schema}
Minimum connections per worker: ${config.min_connect}
Maximum connections per worker: ${config.max_connect}
Active workers: ${config.channel}
SSL: ${config.ssl ? "yes" : "no"}
File: ${database_config}
------------------------------------
Create ${basename(database_config)}?`;
			// файл записывается только после отдельного подтверждения
			question(readline, summary, "y", parse_yes_no, function (confirmed){
				// завершение опроса
				readline.close();
				if(!confirmed) return exit(new Error("Local database configuration canceled due to user action"));
				// конфигурация содержит пароль и сохраняется с ограниченными правами
				output_secure_json(database_config, config, function (){
					print("Created " + database_config);
					// продолжение запуска с созданной конфигурацией
					callback();
				});
			});
		};
		// запуск опроса с первого параметра
		next(0);
	};
	// сначала предлагается конфигурация только для указанного servername
	question(readline, "Local database configuration was not found. Create db." + servername + ".json for this process?", "y", parse_yes_no, function (create_process){
		if(create_process) return create_config(process_database_config);
		// второй вариант создает общую конфигурацию рабочей директории
		question(readline, "Create common db.json for all processes?", "y", parse_yes_no, function (create_common){
			if(create_common) return create_config(common_database_config);
			// отказ от обоих вариантов завершает команду
			readline.close();
			exit(new Error(config_error));
		});
	});
};

// выбор конфигурации процесса, общей локальной конфигурации или удаленного сервера
let prepare_server_config = function (servername, options, callback){
	// сначала проверяем настройки указанного процесса
	let process_database_config = join(process.cwd(), "db." + servername + ".json");
	config_exists(process_database_config, function (exists){
		if(exists) return callback();
		// общая локальная конфигурация используется при отсутствии отдельной
		let common_database_config = join(process.cwd(), "db.json");
		config_exists(common_database_config, function (exists){
			if(exists) return callback();
			// без локальных настроек используем конфигурацию удаленного сервера
			let servername_config = join(process.cwd(), "tmp", "server", servername, "cli.json");
			// переданный пароль создает или обновляет конфигурацию удаленного сервера
			if(options.host != null && options.password != null){
				return output_secure_json(servername_config, { host: options.host, password: options.password }, function (){
					callback();
				});
			}
			// ранее сохраненная удаленная конфигурация используется без опроса
			config_exists(servername_config, function (exists){
				if(exists) return callback();
				// при отсутствии всех вариантов запускается интерактивное создание
				prompt_database_config(servername, process_database_config, common_database_config, callback);
			});
		});
	});
};

// Логи службы сохраняются вместе с остальными данными текущего пользователя.
let service_log = servername => join(homedir(), ".projectdb", "log", "pdb." + servername + ".log");

// формирование имени и пути unit-файла systemd
let get_service = function (servername){
	let name = "pdb." + servername + ".service";
	return {
		name: name,
		path: join("/etc/systemd/system", name)
	};
};

// экранирование аргумента команды в unit-файле systemd
let systemd_arg = function (value){
	// сохраняем пробелы и специальные символы в переданном аргументе
	// удвоение % и $ запрещает подстановки systemd
	return JSON.stringify(String(value))
		.replace(/%/g, "%%")
		.replace(/\$/g, () => "$$");
};

// выполнение команды управления systemd
let systemctl = function (args, callback){
	// execFile передает аргументы напрямую без промежуточной командной оболочки
	execFile("systemctl", args, function (err, stdout, stderr){
		if(err){
			// добавление диагностического вывода systemctl к основной ошибке
			if(stderr && stderr.trim()) err.message += "\n" + stderr.trim();
			return exit(err);
		}
		callback();
	});
};

// подключение к уже запущенному PM2 без создания God Daemon
let connect_existing_pm2 = function (callback){
	// сначала проверяем, работает ли PM2
	const pm2 = require("pm2");
	pm2.Client.pingDaemon(function (alive){
		if(!alive) return callback();
		// подключаемся к работающему PM2
		pm2.connect(function (err){
			if(err) return exit(err);
			callback(pm2);
		});
	});
};

// путь основного dump с учетом PM2_DUMP_FILE_PATH и PM2_HOME
let get_pm2_dump_path = () => process.env.PM2_DUMP_FILE_PATH || join(process.env.PM2_HOME || join(homedir(), ".pm2"), "dump.pm2");

// включение или удаление автозапуска стандартной командой PM2
let set_pm2_startup = function (enabled, callback){
	// управление автозапуском доступно на Linux
	if(process.platform !== "linux") return callback();
	// CLI установленного PM2 самостоятельно определяет init-систему
	execFile(process.execPath, [require.resolve("pm2/bin/pm2"), enabled ? "startup" : "unstartup"], function (err, stdout, stderr){
		if(err){
			if(stderr && stderr.trim()) err.message += "\n" + stderr.trim();
			return exit(err);
		}
		// вывод результата, сообщенного PM2
		if(stdout && stdout.trim()) print(stdout.trim());
		if(stderr && stderr.trim()) print(stderr.trim());
		callback();
	});
};

// остановка подключенного PM2 и удаление его автозапуска
let stop_pm2_daemon = function (pm2, callback){
	// пустой основной dump предотвращает восстановление ранее сохраненных приложений
	output_secure_json(get_pm2_dump_path(), [], function (){
		// если PM2 уже выключен, отключаем его автозапуск
		if(pm2 == null) return set_pm2_startup(false, callback);
		// при пустом списке стандартная команда unlink отключает PM2+ и удаляет ключи
		execFile(process.execPath, [require.resolve("pm2/bin/pm2"), "unlink"], function (err, stdout, stderr){
			if(err){
				if(stderr && stderr.trim()) err.message += "\n" + stderr.trim();
				return exit(err);
			}
			print("Unlinked PM2+");
			// закрываем подключение перед остановкой сервиса PM2
			pm2.disconnect(function (err){
				if(err) return exit(err);
				set_pm2_startup(false, function (){
					// проверяем, остался ли PM2 запущен после отключения автозапуска
					connect_existing_pm2(function (pm2){
						if(pm2 == null) return callback();
						// останавливаем демон PM2, если отключение автозапуска не завершило его работу
						pm2.killDaemon(function (err){
							if(err) return exit(err);
							print("Kill daemon");
							callback();
						});
					});
				});
			});
		});
	});
};

// удаление одноименного процесса из активного PM2 или сохраненного dump
let stop_pm2_process = function (servername, callback){
	// проверка не создает демон, если PM2 ранее не использовался
	connect_existing_pm2(function (pm2){
		if(pm2 == null){
			// при выключенном демоне проверяется сохраненный список приложений
			let path = get_pm2_dump_path();
			return readJson(path, function (err, proc){
				// отсутствие dump не отменяет удаление оставшегося автозапуска PM2
				if(err && err.code === "ENOENT") proc = [];
				else if(err) return exit(new Error("Invalid PM2 process list \"" + path + "\": " + err.message));
				if(!Array.isArray(proc))
					return exit(new Error("Invalid PM2 process list \"" + path + "\": an array is required"));
				// удаляем из сохраненного списка только указанное приложение
				let filtered = proc.filter(item => item == null || item.name !== servername);
				let stopped = filtered.length !== proc.length;
				// если приложений не осталось, отключаем автозапуск PM2
				if(filtered.length === 0)
					return stop_pm2_daemon(null, () => callback(stopped));
				// указанное приложение отсутствует в сохраненном списке
				if(!stopped) return callback(false);
				// сохраняем остальные приложения, не изменяя автозапуск и настройки PM2+
				output_secure_json(path, filtered, function (){
					print("Removed " + servername + " from saved PM2 process list");
					callback(true);
				});
			});
		}
		// закрываем подключение и сообщаем, было ли удалено приложение
		let disconnect = function (stopped){
			pm2.disconnect(function (err){
				if(err) return exit(err);
				callback(stopped);
			});
		};
		// после поиска или удаления приложения проверяем оставшийся список
		let finish = function (stopped){
			pm2.list(function (err, current){
				if(err) return exit(err);
				// если приложений не осталось, отключаем PM2, его автозапуск и PM2+
				if(current.length === 0)
					return stop_pm2_daemon(pm2, () => callback(stopped));
				// если ничего не удалено, сохранять список повторно не требуется
				if(!stopped) return disconnect(false);
				// сохраняем оставшиеся приложения перед закрытием подключения
				pm2.dump(true, function (err){
					if(err) return exit(err);
					print("List process saved");
					disconnect(true);
				});
			});
		};
		// ищем приложение с указанным именем
		pm2.describe(servername, function (err, proc){
			if(err) return exit(err);
			let active = Array.isArray(proc) && proc.some(item => item && item.name === servername);
			if(!active) return finish(false);
			// останавливаем приложение и удаляем его из PM2
			pm2.delete(servername, function (err){
				if(err) return exit(err);
				print("Stopped " + servername + " on process manager");
				finish(true);
			});
		});
	});
};

// остановка установленного systemd-сервиса с необязательным отключением автозапуска
let stop_systemd_service = function (servername, disable, callback){
	// за пределами Linux управление systemd не выполняется
	if(process.platform !== "linux" || !is_service_key(servername))
		return callback();
	// проверяется только unit, который мог быть создан командами ProjectDB
	let service = get_service(servername);
	// отсутствие unit-файла означает, что останавливать нечего
	pathExists(service.path, function (err, exists){
		if(err) return exit(err);
		if(!exists) return callback();
		// остановка не удаляет unit-файл и не меняет настройку автозапуска
		systemctl(["stop", service.name], function (){
			if(!disable){
				print("Stopped " + service.name);
				return callback();
			}
			// параметр disable дополнительно запрещает запуск этого unit после перезагрузки
			systemctl(["disable", service.name], function (){
				print("Stopped and disabled " + service.name);
				callback();
			});
		});
	});
};

// настройка интерфейса командной строки
program
	// установка имени, описания и версии главной команды
	.name(app_name)
	.description(desc_format(description))
	.version(version, "-v, --version", "# output projectdb version")
	// настройка стандартной справки без отдельной команды help
	.helpOption("-h, --help", "# output usage information")
	.helpCommand(false)
	// выделение ошибок разбора аргументов красным цветом
	.configureOutput({
		outputError: (str, write) => write(`\x1b[31m${str}\x1b[0m`)
	})
	// добавление основных примеров после общей справки
	.addHelpText("after", `
Examples:
  # Starting process by name
  \x1b[31m$\x1b[0m `+ app_name +` start PDB-SERVER
  # Help on command
  \x1b[31m$\x1b[0m `+ app_name +` pm2-start --help
  # Stopping all process on process manager
  \x1b[31m$\x1b[0m `+ app_name +` pm2-stop`);

// На устройстве LIMS-USB сохраняем специальную службу и управляем ею через systemd.
// Отметка хранится вне рабочей папки, поэтому смена каталога не снимает ограничение.
let raspberrypi_device = "";
program.hook("preAction", (_program, action) => {
	if(process.platform !== "linux") return;
	try {
		const device_file = join(homedir(), ".projectdb", "raspberrypi-device");
		raspberrypi_device = readFileSync(device_file, "utf8").trim();
		if(!is_service_key(raspberrypi_device) || raspberrypi_device.length > 100)
			throw new Error("Invalid LIMS-USB device registration.");
	} catch (err) {
		if(err.code !== "ENOENT") return exit(err);
	}
	if(!raspberrypi_device && process.env.PDB_METRIC !== "raspberrypi") return;
	if(action.name() !== "start")
		return exit(new Error("LIMS-USB is managed by systemd. Use systemctl to manage the device service."));
	if(raspberrypi_device && action.args[0] !== raspberrypi_device)
		return exit(new Error("Use the registered LIMS-USB device name: " + raspberrypi_device));
});

// команда запуска приложения в консольном режиме
program
	.command("start")
	.argument("<servername>", "# app server name", server_key)
	.description(desc_format("Starting process by name"))
	.summary("# starting process by name")
	.option("-w, --work-path <path>", "# application working directory", work_path, process.cwd())
	.option("-s, --host <host>", "# host server keys", "node.projectdb.pro")
	.option("-p, --password <password>", "# config password")
	.action(function (servername, options) {
		// Ручной start включает готовую службу, не создавая второй процесс устройства.
		if(raspberrypi_device && process.env.PDB_METRIC !== "raspberrypi")
			return systemctl(["start", get_service(servername).name], () => exit());
		// создание и установка рабочей папки приложения
		set_home_dir_app(options.workPath);
		// выбор готовой конфигурации или запуск опроса для создания локального файла
		prepare_server_config(servername, options, function (){
			// процесс внутри systemd не должен пытаться остановить собственный сервис
			let stop_service = ["service", "raspberrypi"].includes(process.env.PDB_METRIC)
				? callback => callback()
				: callback => stop_systemd_service(servername, false, callback);
			// остановка установленного systemd-сервиса при запуске вне него
			stop_service(function (){
				// остановка одноименного процесса PM2 и самого демона, если он опустел
				stop_pm2_process(servername, function (){
					// передача servername запускаемому ядру через переменную окружения
					process.env.PDB_SERVERNAME = servername;
					// загрузка ядра после устранения конфликтов с systemd и PM2
					require("./index.js");
				});
			});
		});
	});

// команда создания локального сервиса, включения автозапуска и запуска приложения
program
	.command("service-start")
	.argument("<servername>", "# app server name", server_key)
	.description(desc_format("Create, enable and start the service"))
	.summary("# create, enable and start the service")
	.option("-w, --work-path <path>", "# application working directory", work_path, process.cwd())
	.option("-s, --host <host>", "# host server keys", "node.projectdb.pro")
	.option("-p, --password <password>", "# config password")
	.action(function (servername, options) {
		// команда доступна только на Linux
		if(process.platform !== "linux")
			return exit(new Error("command \"service-start\" is supported only on Linux with systemd"));
		// создание и установка рабочей папки приложения
		set_home_dir_app(options.workPath);
		// подготовка локальной или удаленной конфигурации подключения
		prepare_server_config(servername, options, function (){
			// удаление одноименного процесса PM2 и остановка демона, если он опустел
			stop_pm2_process(servername, function (){
				// определение имени и пути создаваемого unit-файла
				let service = get_service(servername);
				ensureDirSync(join(homedir(), ".projectdb", "log"), {mode: 0o700});
				// формирование полного содержимого unit-файла
				let service_config = `[Unit]
Description=ProjectDB command line interface
Wants=network-online.target
After=network-online.target

[Service]
Type=exec
User=root
Group=root
Environment=PDB_METRIC=service
ExecStart=${systemd_arg(process.execPath)} ${systemd_arg(join(__dirname, "..", "bin", "projectdb"))} start ${systemd_arg(servername)} --work-path ${systemd_arg(process.cwd())}
Restart=always
RestartSec=3
StandardOutput=append:${service_log(servername).replace(/%/g, "%%")}
StandardError=append:${service_log(servername).replace(/%/g, "%%")}
SyslogIdentifier=pdb.${servername}

[Install]
WantedBy=multi-user.target
`;
				// сохранение unit-файла со стандартными правами 0644
				outputFile(service.path, service_config, { encoding: "utf8", mode: 0o644 }, function (err){
					if(err) return exit(err);
					// обновление списка unit-файлов после создания или изменения сервиса
					systemctl(["daemon-reload"], function (){
						// включение автоматического запуска при загрузке системы
						systemctl(["enable", service.name], function (){
							// restart запускает новый сервис и применяет изменения существующего
							systemctl(["restart", service.name], function (){
								print("Enabled and started " + service.name);
								exit();
							});
						});
					});
				});
			});
		});
	});

// команда перезапуска локального сервиса
program
	.command("service-restart")
	.argument("<servername>", "# app server name", server_key)
	.description(desc_format("Restart the service if it is installed"))
	.summary("# restart the installed service")
	.action(function (servername) {
		// команда доступна только на Linux
		if(process.platform !== "linux")
			return exit(new Error("command \"service-restart\" is supported only on Linux with systemd"));
		// определение имени и пути ранее созданного unit-файла
		let service = get_service(servername);
		// перезапуск разрешен только для существующего сервиса
		pathExists(service.path, function (err, exists){
			if(err) return exit(err);
			if(!exists) return exit(new Error("Service " + service.name + " does not exist"));
			// удаление одноименного процесса PM2 и остановка демона, если он опустел
			stop_pm2_process(servername, function (){
				// перезапуск установленного systemd-сервиса
				systemctl(["restart", service.name], function (){
					print("Restarted " + service.name);
					exit();
				});
			});
		});
	});

// команда остановки локального сервиса, отключения автозапуска и удаления unit-файла
program
	.command("service-stop")
	.argument("<servername>", "# app server name", server_key)
	.description(desc_format("Stop, disable and remove the service"))
	.summary("# stop, disable and remove the service")
	.action(function (servername) {
		// команда доступна только на Linux
		if(process.platform !== "linux")
			return exit(new Error("command \"service-stop\" is supported only on Linux with systemd"));
		// определение имени и пути удаляемого сервиса
		let service = get_service(servername);
		// проверка существования ранее созданного unit-файла
		pathExists(service.path, function (err, exists){
			if(err) return exit(err);
			if(!exists) return exit(new Error("Service " + service.name + " does not exist"));
			// остановка работающего экземпляра сервиса
			systemctl(["stop", service.name], function (){
				// отключение автоматического запуска сервиса
				systemctl(["disable", service.name], function (){
					// удаление unit-файла после остановки и отключения
					remove(service.path, function (err){
						if(err) return exit(err);
						// обновление systemd после удаления unit-файла
						systemctl(["daemon-reload"], function (){
							print("Stopped and removed " + service.name);
							exit();
						});
					});
				});
			});
		});
	});

// команда запуска приложения в процесс-менеджере PM2
program
	.command("pm2-start")
	.argument("<servername>", "# app server name", server_key)
	.description(desc_format("Starting process by name on process manager"))
	.summary("# starting process by name on process manager")
	.option("-w, --work-path <path>", "# application working directory", work_path, process.cwd())
	.option("-m, --memory-limit <megabytes>", "# set nodejs max-old-space-size [in megabytes]", memory_limit, 2048)
	.option("-s, --host <host>", "# host server keys", "node.projectdb.pro")
	.option("-p, --password <password>", "# config password")
	.option("-l, --link <secret-key,public-key>", "# pm2 link to connect the application dashboard", pm2_link)
	.action(function (servername, options) {
		// создание и установка рабочей папки приложения
		set_home_dir_app(options.workPath);
		// загрузка PM2 для запуска приложения
		const pm2 = require("pm2");
		// запуск после подготовки конфигурации и остановки одноименного сервиса
		let start_process = function (){
			// подключение к PM2 с запуском при необходимости
			pm2.connect(function(err) {
				if(err) return exit(err);
				// PM2 запускает новый процесс или перезапускает уже существующий с тем же именем
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
				}, function(err) {
					if(err) return exit(err);
					print("Started " + servername);
					// сохранение текущего списка для последующего восстановления PM2
					pm2.dump(true, function (err){
						if(err) return exit(err);
						print("List process saved");
						// автозапуск включается после запуска приложения и сохранения списка
						set_pm2_startup(true, function (){
							// список используется только для информационного вывода запущенных приложений
							pm2.list(function (err, proc){
								if(err) return exit(err);
								print("Table active process " + proc.filter(d => d).map(d => d.name + "-" + d.pid).join(", "));
								exit();
							});
						});
					});
				});
			});
		};
		// выбор готовой конфигурации или запуск опроса для создания локального файла
		prepare_server_config(servername, options, function (){
			// перед запуском PM2 останавливаем и отключаем одноименный systemd-сервис
			stop_systemd_service(servername, true, function (){
				// без ключей панели сразу переходим к обычному запуску PM2
				if(options.link == null) return start_process();
				// ключи передаются после проверки формата параметра --link
				let link = options.link;
				// получение текущего состояния подключения PM2+
				pm2.agentInfos(function (err, info){
					// повторная активация не требуется при совпадении обоих ключей
					if(!err && info && info.public_key === link[1] && info.secret_key === link[0]){
						print("PM2+ already activated!");
						return start_process();
					}
					// перехватываем ошибки подключения к PM2+, которые PM2 завершает через exitCli
					let original_exit_cli = pm2.exitCli;
					let completed = false;
					let complete = function (err){
						if(completed) return;
						completed = true;
						pm2.exitCli = original_exit_cli;
						if(err) return exit(err);
						start_process();
					};
					// временно перехватываем нестандартное завершение только операции link
					pm2.exitCli = function (code){
						complete(code ? new Error("Unable to activate PM2+ dashboard") : null);
					};
					try {
						pm2.linkManagement(link[0], link[1], null, {}, complete);
					} catch (err) {
						complete(err);
					}
				});
			});
		});
	});

// команда перезапуска приложения в процесс-менеджере PM2
program
	.command("pm2-restart")
	.argument("<servername>", "# app server name", server_key)
	.description(desc_format("Restarting process by name on process manager"))
	.summary("# restarting process by name on process manager")
	.action(function (servername) {
		// подключение только к существующему демону без его автоматического запуска
		connect_existing_pm2(function (pm2){
			// отсутствие демона равнозначно отсутствию запрошенного процесса
			if(pm2 == null)
				return exit(new Error("PM2 process " + servername + " does not exist"));
			// проверяем наличие приложения перед остановкой одноименного сервиса
			pm2.describe(servername, function (err, proc){
				if(err) return exit(err);
				if(!Array.isArray(proc) || !proc.some(item => item && item.name === servername)){
					return exit(new Error("PM2 process " + servername + " does not exist"));
				}
				// останавливаем одноименный systemd-сервис и отключаем его автозапуск только после проверки процесса PM2
				stop_systemd_service(servername, true, function (){
					// перезапуск приложения с указанным именем
					pm2.restart(servername, function (err){
						if(err) return exit(err);
						print("Restarted " + servername);
						exit();
					});
				});
			});
		});
	});

// команда остановки одного процесса или всего демона PM2
program
	.command("pm2-stop")
	.argument("[servername]", "# app server name", server_key)
	.description(desc_format("Stop all active processes or select on process manager"))
	.summary("# stop all active processes or select on process manager")
	.action(function (servername) {
		// если не передано имя процесса, останавливаем все
		if(servername == null){
			// проверка не запускает отсутствующий демон только ради команды stop
			return connect_existing_pm2(function (pm2){
				// при отсутствии демона достаточно очистить dump и удалить автозапуск
				if(pm2 == null) return stop_pm2_daemon(null, () => exit());
				// перед unlink и остановкой PM2 удаляются все зарегистрированные приложения
				pm2.delete("all", function (err){
					// даже если приложений нет, продолжаем остановку PM2, отключение PM2+ и автозапуска
					if(err && err.message !== "process name not found") return exit(err);
					stop_pm2_daemon(pm2, () => exit());
				});
			});
		}
		// удаляем приложение по точному имени и не создаем демон ради команды stop
		stop_pm2_process(servername, function (stopped){
			// сообщаем, если указанное приложение не найдено
			if(!stopped) return exit(new Error("PM2 process " + servername + " does not exist"));
			exit();
		});
	});

// запуск разбора аргументов и выполнение выбранной команды
program.parse(process.argv);
