"use strict";
// загрузка базовых модулей
const { print, exit, github } = require("./tools.js");
const { name, version, config } = require("../package.json");
const crypto = require("crypto");
const path = require("path");
const fse = require("fs-extra");

// фикс для собранного приложения, иначе не может найти пути из app и source модулей
global.require_path = path => require(path);
// глобальные пути к библиотекам собранного приложения, для передачи в worker
global.require_paths = module.paths;

// версия ноды
process.versions[name] = version;
// версия сервера
process.env.PDB_VERSION = config.PDB_VERSION;
// пишем клиенту
print("Kernel init version [33m"+process.env.PDB_VERSION+"[39m ...");

// экспорт
module.exports = {
	// запрос приложения из разных источников
	get: function (cb){
		// проверка локальной библиотеки
		let file_server_crypto = path.join(process.cwd(), "lib", "app.so");
		fse.pathExists(file_server_crypto, function (err, exists){
			// ошибка
			if(err) return callback(err);
			// если есть локальная библиотека приложения
			if(exists){
				// читаем и переходим к запуску
				print("App found in local directory, decryption ...");
				fse.readFile(file_server_crypto, callback);
			}
			// запрос с github
			else {
				// запрос тегов из репозитория
				print("Search latest release for kernel ...");
				github("tags?per_page=100", false, function (err, data){
					// ошибка
					if(err) return callback(err);
					// обработка полученных данных
					let tags = data.body
						// запрос версий
						.map( o => o && o.name ? o.name : "" )
						// фильтр по версии приложения
						.filter( a => a.split(".")[0] === process.env.PDB_VERSION.split(".")[0] )
						// поиск самой свежей
						.sort( (a, b) => b.split(".")[1] - a.split(".")[1] );
					// если не найден подходящий тег
					if(tags[0] == null){
						return callback(new Error("Release by kernel version [33m"+process.env.PDB_VERSION+"[39m not found!"));
					}
					// запрос данных релиза
					print("Search app in release [33m"+tags[0]+"[39m ...");
					github("releases/tags/"+tags[0], false, function (err, data){
						// ошибка
						if(err) return callback(err);
						// проверка полученных вложений
						if(data.body && data.body.assets instanceof Array){
							// поиск приложения
							for (let val of data.body.assets) if(val.name === "app.so"){
								// запрос кода
								print("Found app [33mid:"+val.id+"[39m, download ...");
								github(val.url, true, function (err, data){
									// ошибка
									if(err) return callback(err);
									// файл получен, все ок
									print("App buffer received successfully, decryption ...");
									callback(null, data.body)
								})
								// СТОП
								return;
							}
						}
						// если не найдено, ошибка
						callback(new Error("App in release [33m"+tags[0]+"[39m not found!"));
					})
				});
			}
		});

		// функция запуска приложения
		let callback = function (err, buffer){
			// ошибка
			if(err) exit(err);

			// разбираем строку
			let app = buffer.toString().split(":");

			// проверяем версию app
			if(app[0].split(".")[0] !== process.env.PDB_VERSION.split(".")[0]){
				exit(new Error("The app version is not suitable for the kernel version!"));
			}

			// закрытый ключ
			let hash = crypto.createHash("sha512");
			hash.update(config.PDB_PASSWORD);
			let key = hash.digest().slice(0, 32);

			// разбираем строку
			let data = app[1].split("-");

			// открытый ключ
			let iv = Buffer.from(data[1], "hex");

			// декодируем
			let server_js = false;
			try {
				let decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
				// получаем контент файла
				server_js = Buffer.concat([decipher.update(Buffer.from(data[0]+data[2], "hex")), decipher.final()]);
			} catch (e) {
				exit(new Error("App decryption error!"));
			}

			// запускаем сервер
			if(server_js){
				// виртуальный путь до файла
				let path_module = path.join(process.cwd(), "tmp", "app", "server.js");
				// сохраняем в файл
				fse.outputFile(path_module, server_js, function (err){
					// ошибка
					if(err) exit(err);
					// версия сервера
					process.env.PDB_VERSION = app[0];
					// загружаем модуль
					cb(require(path_module))
					// удаляем временно созданную папку
					fse.remove(path.join(process.cwd(), "tmp", "app"));
					// очистка
					server_js = null;
				});
			} else {
				exit(new Error("Server app code is empty or not found"));
			}
		}
	}
}
