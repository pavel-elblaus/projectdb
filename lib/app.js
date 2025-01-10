"use strict";
// загрузка базовых модулей
const { print, exit, github } = require("./tools.js");
const { name, version, config } = require("../package.json");
const crypto = require("crypto");
const path = require("path");
const fse = require("fs-extra");
const os = require("os");
const require_string = require("require-from-string");
const unzip = require("unzip-stream");
const readable = require("stream").Readable;

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
				print("Application found in working directory, decryption ...");
				fse.readFile(file_server_crypto, callback);
			}
			// запрос с github
			else {
				// поиск последнего запроса
				let release_latest = path.join(os.homedir(), ".projectdb", "lib", `release-${process.env.PDB_VERSION.split(".")[0]}.latest`);
				fse.readJson(release_latest, function (err, latest){
					// минимальное время между запросами
					let check_timeout = 180000;
					// ошибка или если пришло время обновить данные из репозитория или не известна версия релиза
					if(err || ( +latest.time || 0 ) + check_timeout < +new Date() || latest.release == null){
						// запрос тегов из репозитория
						print("Search latest release for kernel on GitHub ...");
						github("tags?per_page=100", false, function (err, data){
							// ошибка, если известен релиз, запуск
							if(err) return latest && latest.release ? check(latest.release) : callback(err);
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
							// сохранение данных
							fse.outputJson(release_latest, { time: +new Date(), release: tags[0] }, function(err){
								if(err) return callback(err);
								// запуск
								check(tags[0]);
							});
						});
						// СТОП
						return;
					}
					// пропускаем проверку чтобы не превысить лимит в 60 запросов в час для не аутентифицированных запросов
					print("Search latest release on GitHub skipped, next check on [31m"+Math.ceil((latest.time + check_timeout - +new Date()) / 1000)+"[39m seconds");
					check(latest.release);
				});

				// функция проверки и запуска релиза приложения
				let check = function (release){
					// проверка библиотеки в кеше пользователя
					let cache_file_server_crypto = path.join(os.homedir(), ".projectdb", "lib", release, "app.so");
					fse.pathExists(cache_file_server_crypto, function (err, exists){
						// ошибка
						if(err) return callback(err);
						// если существует в кеше
						if(exists){
							// читаем и переходим к запуску
							print("Application release [33m"+release+"[39m found in user cache, decryption ...");
							fse.readFile(cache_file_server_crypto, callback);
						}
						// запрос с github
						else {
							// запрос данных релиза
							print("Search app in release [33m"+release+"[39m ...");
							github("releases/tags/"+release, false, function (err, data){
								// ошибка
								if(err) return callback(err);
								// поиск приложения в полученных данных
								if(data.body?.assets instanceof Array) for(let v1 of data.body.assets) if(v1.name === "app.so"){
									// запрос контента
									print("Found app [33mid:"+v1.id+"[39m, download ...");
									github(v1.url, true, function (err, app_so){
										// ошибка
										if(err) return callback(err);
										// поиск хеш приложения
										if(data.body?.assets instanceof Array) for(let v2 of data.body.assets) if(v2.name === "app.so.sha384"){
											// запрос контента
											print("Found app hash [33mid:"+v2.id+"[39m, download ...");
											github(v2.url, true, function (err, app_so_sha384){
												// ошибка
												if(err) return callback(err);
												// проверка полученного буфера
												if(app_so_sha384.body == null || app_so_sha384.body.length === 0){
													return callback(new Error("The application hash could not be loaded!"));
												}
												// формирование, сравнение хеш приложений
												if(app_so_sha384.body.toString() !== crypto.createHash("sha384").update(app_so.body).digest("hex")){
													return callback(new Error("The downloaded application hash does not match the repository, please try running it again."));
												}
												// сохранение версии приложения в кеш пользователя
												print("Application buffer successfully retrieved, save to user cache ...");
												fse.outputFile(cache_file_server_crypto, app_so.body, function (err){
													// ошибка
													if(err) return callback(err);
													// файл получен, все ок
													print("Successfully saved to [33m"+cache_file_server_crypto+"[39m, decryption ...");
													callback(null, app_so.body);
												});
											});
											// СТОП
											return;
										}
										// если не найдено, ошибка
										callback(new Error("Application hash for release [33m"+release+"[39m not found!"));
									});
									// СТОП
									return;
								}
								// если не найдено, ошибка
								callback(new Error("Application in release [33m"+release+"[39m not found!"));
							});
						}
					});
				};
			}
		});

		// функция запуска приложения
		let callback = function (err, buffer){
			// ошибка
			if(err) exit(err);

			// проверка полученного буфера
			if(buffer == null || buffer.length === 0){
				exit(new Error("Application buffer is empty, check installed library in working directory and user home directory cache."));
			}

			// разбираем строку
			let app = buffer.toString().split(":");

			// проверяем версию app
			if(app[0].split(".")[0] !== process.env.PDB_VERSION.split(".")[0]){
				exit(new Error("The application version does not match the kernel version!"));
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
			let server_js;
			try {
				let decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
				// получаем контент файла
				server_js = Buffer.concat([decipher.update(Buffer.from(data[0]+data[2], "hex")), decipher.final()]);
			} catch (e) {
				exit(new Error("Application decryption error!"));
			}

			// запускаем сервер
			if(server_js){
				// путь к виртуальному каталогу
				const path_tmp_app = path.join(process.cwd(), "tmp", "server", process.env.PDB_SERVERNAME, "app");
				// база скриптов
				const database = {};
				// счетчик загрузки
				let count = 0;
				// создаем поток из буфера
				readable.from(server_js)
					// обработка потока
					.pipe(unzip.Parse())
					.on("entry", function (entry) {
						if(entry.type === "File"){
							count++;
							let bufs = [];
							entry.on("data", d => bufs.push(d));
							entry.on("end", function(){
								database[entry.path] = Buffer.concat(bufs);
								count--;
								// закончили чтение
								if(count === 0){
									// версия сервера
									process.env.PDB_VERSION = app[0];
									// загрузка pdb библиотеки
									global.pdb = require_string(database["pdb.js"].toString(), path.join(path_tmp_app, "pdb.js"));
									// сохранение буфера файла библиотеки для передачи в дочерние процессы
									pdb.buffer = database["pdb.js"];
									// загружаем модуль
									cb(require_string(database["server.js"].toString(), path.join(path_tmp_app, "server.js")));
								}
							});
						} else {
							entry.autodrain();
						}
					})
					.on("error", exit);
			} else {
				exit(new Error("Server app code is empty or not found."));
			}
		}
	}
}
