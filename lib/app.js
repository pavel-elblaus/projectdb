'use strict';

// загрузка базовых модулей
const _path = require("path");
const _fse = require("fs-extra");
const _crypto = require("crypto");
const _util = require("util");
const _io_client = require("socket.io-client");

// фикс для собранного приложения, иначе не может найти пути из app и source модулей
global.require_path = function (path) {
	return require(path);
};

// глобальные пути к библиотекам собранного приложения, для передачи в worker
global.require_paths = module.paths;

// функция показа сообщения
let _print = function (txt){
	console.log(txt);
}
// функция показа сообщения ошибки
let _print_error = function (err){
	console.error(err instanceof Error ? err.message : _util.inspect(err, { compact: false, colors: true, depth: null }));
}
// функция остановки приложения
let _exit = function (err){
	// информация по ошибке
	_print_error(err);
	// выход из приложения
	process.exit();
}

// пароль шифрования
let password = "sL:KJdsa09ukjNJ%@KV7itdsf$987YTGFD54ew3)($";
// версия сервера
let version = "15.0.0";
// список серверов
let servers = [
	"node.projectdb.xyz",
	"node.projectdb.pro",
	"node.projectdb.ru",
	"www.projectdb.ru"
];

// версия сервера
process.env.npm_package_version = version;
// пишем клиенту
_print("Start kernel version \"[33m"+version+"[39m\" ...");

// проверка локальной библиотеки
let file_server_crypto = _path.join(process.cwd(), "lib", "app.so");
_fse.pathExists(file_server_crypto, function (err, exists){
	// ошибка
	if(err){
		return callback(err);
	}
	// если есть локальная библиотека приложения
	if(exists){
		// читаем и переходим к запуску
		_fse.readFile(file_server_crypto, (err, buffer) => callback(err, buffer));
	}
	// запрос с сервера
	else {
		// функция запроса приложения с сервера
		let request = function(){
			// хост запроса
			let host = servers.shift();
			// если закончились зеркала, возвращаем ошибку
			if(host == null){
				return callback(new Error("Failed to connect to any of the servers"));
			}
			// пробуем подключится
			_print("Connect to host \"[33m"+host+"[39m\" ...");
			let io = _io_client("wss://"+host+"/server", {
				path: "/ws",
				reconnection: false
			});
			io.on("connect", function(){
				// таймаут ожидания ответа
				let request_timeout = setTimeout(function (){
					// отметка, что сработал таймаут запроса
					request_timeout = true;
					// ошибка
					_print_error(new Error("Server did not respond to the request"));
					// опрос следующего зеркала
					request();
				}, 15000);
				// запрос кода
				_print("Application request ...");
				io.binary(false).emit("server.app", version, function (err, buffer) {
					// если отработал таймаут, обработка ответа не требуется
					if(request_timeout === true){
						return;
					}
					// сброс таймера
					clearTimeout(request_timeout);
					// обработка ответа
					if(err){
						// ошибка
						_print_error(err);
						// опрос следующего зеркала
						request();
					} else {
						// файл получен, все ок
						_print("Application buffer received successfully, decryption ...");
						// переходим к запуску
						callback(null, buffer, host);
					}
					// закрываем подключение
					io.close();
				});
			});
			io.on("connect_error", function (err){
				// ошибка
				_print_error(new Error("Connection failed, select next application server!"));
				// опрос следующего зеркала
				request();
			});
		}
		// запуск опроса серверов
		request();
	}
});

// функция запуска приложения
let callback = function (err, buffer, server_host){
	// ошибка
	if(err){
		_exit(err);
	}

	// разбираем строку
	let app = buffer.toString().split(":");

	// версия сервера
	process.env.npm_package_version = app[0];
	// пишем клиенту
	_print("Start app version \"[33m"+app[0]+"[39m\" ...");

	// проверяем версию app
	if(app[0].split(".")[0] !== version.split(".")[0]){
		_exit(new Error("The app version is not suitable for the kernel version!"));
	}

	// закрытый ключ
	let hash = _crypto.createHash("sha512");
	hash.update(password);
	let key = hash.digest().slice(0, 32);

	// разбираем строку
	let data = app[1].split("-");

	// открытый ключ
	let iv = Buffer.from(data[1], "hex");

	// декодируем
	let server_js = false;
	try {
		let decipher = _crypto.createDecipheriv("aes-256-cbc", key, iv);
		let decrypted = Buffer.concat([decipher.update(Buffer.from(data[0]+data[2], "hex")), decipher.final()]);
		// получаем контент файла
		server_js = decrypted.toString();
	} catch (e) {
		_exit(new Error("Application decryption error!"));
	}

	// запускаем сервер
	if(server_js){
		// виртуальный путь до файла
		let path_module = _path.join(process.cwd(), "tmp", "app", "server.js");
		// сохраняем в файл
		_fse.outputFile(path_module, server_js, function (err){
			// ошибка
			if(err){
				_exit(err);
			}
			// загружаем модуль
			require(path_module).run(server_host);
			// удаляем временно созданную папку
			_fse.remove(_path.join(process.cwd(), "tmp", "app"));
			// очистка
			server_js = null;
		});
	} else {
		_exit(new Error("Server app code is empty or not found"));
	}
}