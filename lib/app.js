"use strict";
// загрузка информации о приложении и общих функций вывода
const { name, version, config } = require("../package.json");
const { print, exit, github } = require("./tools.js");

// загрузка модулей для расшифровки, работы с файлами и распаковки приложения
const { createDecipheriv, createHash, randomBytes, timingSafeEqual } = require("crypto");
const { outputFile, outputJson, readFile, readJson, remove, rename } = require("fs-extra");
const { dirname, join } = require("path");
const { homedir } = require("os");
const require_string = require("require-from-string");
const { Parse } = require("unzip-stream");
const { Readable } = require("stream");

// разбор и расшифровка файла приложения без запуска содержащегося в нем кода
let decode_application_buffer = function (buffer){
	// проверка типа и размера полученного буфера
	if(!Buffer.isBuffer(buffer) || buffer.length === 0){
		throw new Error("Application buffer is empty.");
	}
	// перевод содержимого в строку для разбора служебной части файла
	let raw = buffer.toString();
	// поиск разделителя между версией приложения и зашифрованными данными
	let separator = raw.indexOf(":");
	// разделитель должен присутствовать в файле только один раз
	if(separator <= 0 || separator !== raw.lastIndexOf(":")){
		throw new Error("Application file format is invalid.");
	}
	// получение версии приложения из заголовка файла
	let release = raw.slice(0, separator);
	// сверка основной версии приложения с основной версией ядра
	if(release.split(".")[0] !== process.env.PDB_VERSION.split(".")[0]){
		throw new Error("The application version does not match the kernel version!");
	}
	// разбор зашифрованных данных на первую часть, вектор инициализации и вторую часть
	let data = raw.slice(separator + 1).split("-");
	// проверка количества частей, размера вектора и шестнадцатеричного формата
	if(
		data.length !== 3 ||
		data[1].length !== 32 ||
		data.some(value => value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value))
	){
		throw new Error("Application encryption data is invalid.");
	}
	// объединение разделенных частей зашифрованного приложения
	let encrypted = Buffer.from(data[0] + data[2], "hex");
	// размер данных для AES должен быть кратен размеру блока
	if(encrypted.length === 0 || encrypted.length % 16 !== 0){
		throw new Error("Application encrypted payload is invalid.");
	}
	// формирование симметричного ключа на основании пароля текущей версии ядра
	let hash = createHash("sha512");
	// хеширование пароля перед выделением ключа нужной длины
	hash.update(config.PDB_PASSWORD);
	// получение первых 32 байт для алгоритма AES-256
	let key = hash.digest().slice(0, 32);
	try{
		// создание AES-дешифратора с ключом и вектором инициализации из файла
		let decipher = createDecipheriv("aes-256-cbc", key, Buffer.from(data[1], "hex"));
		// расшифровка архива приложения и возврат результата проверки
		return {
			release,
			server_js: Buffer.concat([decipher.update(encrypted), decipher.final()])
		};
	} catch (err){
		// ошибка возникает при повреждении данных или использовании другого ключа
		throw new Error("Application decryption error!");
	}
};

// полная проверка файла приложения, включая целостность архива и обязательные модули
let validate_application_buffer = function (buffer, callback){
	// результат первичного разбора и расшифровки приложения
	let application;
	try{
		// проверка формата, версии и зашифрованной части файла
		application = decode_application_buffer(buffer);
	} catch (err){
		// возврат ошибки без попытки чтения поврежденного архива
		return callback(err);
	}
	// файлы, извлеченные из архива приложения и доступные по внутреннему пути
	let database = {};
	// количество файлов архива, чтение которых еще не завершено
	let count = 0;
	// признак полного завершения разбора архива
	let closed = false;
	// защита от повторного вызова функции обратного вызова
	let completed = false;
	// завершение проверки после закрытия архива и чтения всех его файлов
	let complete = function (err){
		// пропуск повторных событий после завершения проверки
		if(completed) return;
		// немедленное завершение проверки при ошибке потока
		if(err){
			completed = true;
			return callback(err);
		}
		// ожидание закрытия архива и окончания чтения всех файлов
		if(!closed || count !== 0) return;
		// проверка обязательных библиотек приложения и их содержимого
		if(!Buffer.isBuffer(database["pdb.js"]) || database["pdb.js"].length === 0 || !Buffer.isBuffer(database["server.js"]) || database["server.js"].length === 0){
			completed = true;
			return callback(new Error("Application archive does not contain required modules."));
		}
		// фиксация успешного окончания проверки
		completed = true;
		// возврат подготовленного приложения без запуска его кода
		callback(null, {
			release: application.release,
			database
		});
	};
	// создание потока из расшифрованного архива приложения
	Readable.from(application.server_js)
		// запуск последовательного разбора ZIP-архива
		.pipe(Parse())
		// обработка очередной записи из архива
		.on("entry", function (entry) {
			// каталоги и другие служебные записи не сохраняются в коллекцию файлов
			if(entry.type !== "File"){
				entry.autodrain();
				return;
			}
			// увеличение счетчика активных файлов
			count++;
			// временное хранение частей текущего файла
			let bufs = [];
			// сбор поступающих частей файла
			entry.on("data", data => bufs.push(data));
			// передача ошибки чтения в общую функцию завершения
			entry.on("error", complete);
			// обработка полного чтения текущего файла
			entry.on("end", function (){
				// пропуск события если проверка уже завершена с ошибкой
				if(completed) return;
				// объединение частей и сохранение файла по его пути в архиве
				database[entry.path] = Buffer.concat(bufs);
				// уменьшение счетчика активных файлов
				count--;
				// повторная проверка готовности приложения
				complete();
			});
		})
		// отметка полного завершения разбора архива
		.on("close", function (){
			closed = true;
			complete();
		})
		// обработка ошибки структуры или распаковки архива
		.on("error", complete);
};

// безопасное сравнение двух буферов одинакового размера
let buffers_equal = function (left, right){
	// сначала проверяется размер, затем содержимое без досрочного выхода
	return left.length === right.length && timingSafeEqual(left, right);
};

// сохранение сначала во временный файл, затем атомарная установка готового кеша
let output_file_atomic = function (file, data, callback){
	// создание уникального имени временного файла в каталоге конечного кеша
	let temporary = join(dirname(file), `.app.so.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	// признак завершения операции для защиты от повторного вызова callback
	let completed = false;
	// удаление временного файла и возврат результата
	let complete = function (err){
		// пропуск повторных событий после завершения операции
		if(completed) return;
		// фиксация завершения до удаления временного файла
		completed = true;
		// удаление временного файла после успешной установки или ошибки
		remove(temporary, function (remove_err){
			// приоритет имеет исходная ошибка операции записи
			callback(err || remove_err || null);
		});
	};
	// запись полного буфера приложения во временный файл с созданием каталога
	outputFile(temporary, data, function (err){
		// ошибка создания или записи временного файла
		if(err) return complete(err);
		// чтение временного файла для проверки результата записи
		readFile(temporary, function (err, saved){
			// ошибка чтения временного файла
			if(err) return complete(err);
			// поврежденный временный файл не должен устанавливаться в кеш
			if(!buffers_equal(saved, data)) return complete(new Error("The temporary application cache verification failed after saving."));
			// атомарная установка полностью записанного и проверенного файла в кеш
			rename(temporary, file, function (err){
				// после успешного переименования выполняется итоговая проверка файла
				if(!err){
					return readFile(file, function (err, saved){
						// ошибка чтения конечного файла
						if(err) return complete(err);
						// идентичный файл успешно установлен в кеш
						if(buffers_equal(saved, data)) return complete();
						// поврежденный конечный файл удаляется после проверки
						remove(file, function (remove_err){
							complete(remove_err || new Error("The application cache verification failed after saving."));
						});
					});
				}
				// остальные ошибки файловой системы сразу возвращаются вызывающей стороне
				if(err.code !== "EEXIST" && err.code !== "EPERM") return complete(err);
				// при параллельном запуске другой процесс мог установить тот же кеш первым
				readFile(file, function (read_err, existing){
					// готовый идентичный файл можно использовать без повторной записи
					if(!read_err && buffers_equal(existing, data)) return complete();
					// возврат ошибки чтения или исходной ошибки переименования
					complete(read_err || err);
				});
			});
		});
	});
};

// запуск проверенного приложения из распакованного архива
let start_application = function (application, callback){
	// виртуальный каталог для разрешения относительных импортов загруженного кода
	let path_tmp_app = join(process.cwd(), "tmp", "server", process.env.PDB_SERVERNAME || "", "app");
	try{
		// переключение версии окружения на выбранный релиз приложения
		process.env.PDB_VERSION = application.release;
		// выполнение pdb.js из проверенного архива
		global.pdb = require_string(application.database["pdb.js"].toString(), join(path_tmp_app, "pdb.js"));
		// сохранение буфера файла библиотеки для передачи в дочерние процессы
		global.pdb.buffer = application.database["pdb.js"];
		// выполнение server.js и передача его экспорта вызывающей стороне
		callback(require_string(application.database["server.js"].toString(), join(path_tmp_app, "server.js")));
	} catch (err){
		// ошибка выполнения загруженного кода приложения
		exit(err);
	}
};

// чтение и полная проверка локального файла; поврежденные файлы удаляются
let load_application_file = function (file, callback){
	// чтение выбранной локальной копии приложения
	readFile(file, function (err, buffer){
		// обработка ошибки чтения файла
		if(err){
			// отсутствие файла возвращается без ошибки и без приложения
			if(err.code === "ENOENT") return callback();
			// остальные ошибки файловой системы возвращаются вызывающей функции
			return callback(err);
		}
		// проверка формата, версии, расшифровки и содержимого архива
		validate_application_buffer(buffer, function (err, application){
			// проверенный файл возвращается вызывающей функции
			if(!err){
				// вывод фактического пути успешно проверенного файла приложения
				print("Application file [33m" + file + "[39m successfully verified, start ...");
				return callback(null, application);
			}
			// вывод причины удаления поврежденного файла
			print("Application file " + file + " is damaged (" + err.message + "), delete and load another copy ...");
			// удаление поврежденного файла без помещения в карантин
			remove(file, function (remove_err){
				// ошибка удаления не позволяет перейти к следующему источнику
				if(remove_err) return callback(remove_err);
				// после удаления возвращается результат без приложения
				callback();
			});
		});
	});
};

// загрузка выбранного релиза из кеша или GitHub
let load_release_application = function (release, callback){
	// формирование пути к библиотеке выбранного релиза в кеше пользователя
	let cache_file_server_crypto = join(homedir(), ".projectdb", "lib", release, "app.so");
	// чтение и полная проверка кеша перед его использованием
	load_application_file(cache_file_server_crypto, function (err, application){
		// возврат ошибки или проверенного приложения из кеша
		if(err || application) return callback(err, application);
		// кеш отсутствует или был удален, выполняется запрос данных релиза
		print("Search app in release [33m" + release + "[39m ...");
		github("releases/tags/" + release, false, function (err, data){
			// ошибка запроса данных выбранного релиза
			if(err) return callback(err);
			// проверка списка файлов выбранного релиза
			if(data.body == null || !Array.isArray(data.body.assets)){
				return callback(new Error("Application assets for release [33m" + release + "[39m not found!"));
			}
			// поиск приложения и его контрольной суммы
			let app_file = data.body.assets.find(value => value.name === "app.so");
			let hash_file = data.body.assets.find(value => value.name === "app.so.sha384");
			// ошибка если файл приложения не найден
			if(app_file == null){
				return callback(new Error("Application in release [33m" + release + "[39m not found!"));
			}
			// ошибка если контрольная сумма приложения не найдена
			if(hash_file == null){
				return callback(new Error("Application hash for release [33m" + release + "[39m not found!"));
			}
			// загрузка бинарного содержимого приложения
			print("Found app [33mid:" + app_file.id + "[39m, download ...");
			github(app_file.url, true, function (err, app_so){
				// ошибка загрузки файла приложения
				if(err) return callback(err);
				// проверка типа и размера загруженного приложения
				if(!Buffer.isBuffer(app_so.body) || app_so.body.length === 0){
					return callback(new Error("The application could not be loaded or is empty!"));
				}
				// загрузка контрольной суммы приложения
				print("Found app hash [33mid:" + hash_file.id + "[39m, download ...");
				github(hash_file.url, true, function (err, app_so_sha384){
					// ошибка загрузки контрольной суммы
					if(err) return callback(err);
					// проверка типа и размера загруженной контрольной суммы
					if(!Buffer.isBuffer(app_so_sha384.body) || app_so_sha384.body.length === 0){
						return callback(new Error("The application hash could not be loaded!"));
					}
					// перевод контрольной суммы из файла в нормализованную строку
					let repository_hash = app_so_sha384.body.toString().trim().toLowerCase();
					// проверка длины и шестнадцатеричного формата SHA-384
					if(!/^[0-9a-f]{96}$/.test(repository_hash)){
						return callback(new Error("The application hash has an invalid format!"));
					}
					// сравнение контрольной суммы репозитория с загруженным приложением
					if(repository_hash !== createHash("sha384").update(app_so.body).digest("hex")){
						return callback(new Error("The downloaded application hash does not match the repository, please try running it again."));
					}
					// проверка структуры и содержимого приложения до записи на диск
					validate_application_buffer(app_so.body, function (err, application){
						// поврежденный загруженный файл не сохраняется в кеш
						if(err) return callback(new Error("The downloaded application is damaged: " + err.message));
						// сохранение проверенного приложения во временный файл
						print("Application buffer successfully retrieved, save to user cache ...");
						output_file_atomic(cache_file_server_crypto, app_so.body, function (err){
							// ошибка записи или итоговой проверки кеша
							if(err) return callback(err);
							// возврат приложения после успешного сохранения файла
							print("Successfully saved to [33m" + cache_file_server_crypto + "[39m ...");
							callback(null, application);
						});
					});
				});
			});
		});
	});
};

// выбор версии приложения и обновление маркеров текущего процесса
let get_application_release = function (callback){
	// пути основного и резервного маркеров версии для указанного servername
	let servername = process.env.PDB_SERVERNAME || "";
	let release_server = join(process.cwd(), "tmp", "server", servername, "release");
	let release_backup = join(process.cwd(), "tmp", "server", servername, "release.bak");
	// проверка маркера резервной версии перед поиском нового релиза
	readFile(release_backup, function (err, release_prev){
		// непустой совместимый резерв восстанавливается без поиска новой версии
		if(!err && release_prev.length && release_prev.toString().split(".")[0] === process.env.PDB_VERSION.split(".")[0]){
			release_prev = release_prev.toString();
			print("Search latest release on GitHub skipped, running previous version from backup");
			return outputFile(release_server, release_prev, function (err){
				if(err) return callback(err);
				callback(null, release_prev);
			});
		}
		// чтение основного маркера текущего релиза
		readFile(release_server, function (err, release_prev){
			// отсутствующий или пустой маркер обозначается значением false
			release_prev = !err && release_prev.length ? release_prev.toString() : false;
			// запуск выбранного релиза с обновлением маркеров процесса
			let use_release = function (release_last){
				// без servername или при совпадении версии маркеры изменять не требуется
				if(servername === "" || release_prev === release_last) return callback(null, release_last);
				// запись выбранной версии в основной маркер release
				outputFile(release_server, release_last, function (err){
					if(err) return callback(err);
					// при первом запуске предыдущей версии для резервной копии еще нет
					if(release_prev === false) return callback(null, release_last);
					// сохранение прежней версии для отката при неуспешном запуске
					outputFile(release_backup, release_prev, function (err){
						if(err) return callback(err);
						callback(null, release_last);
					});
				});
			};
			// путь к общему кешу последнего совместимого релиза
			let release_latest = join(homedir(), ".projectdb", "lib", `release-${process.env.PDB_VERSION.split(".")[0]}.latest`);
			// чтение кеша последнего запроса для текущей основной версии
			readJson(release_latest, function (err, latest){
				// минимальный интервал между обращениями к GitHub
				let check_timeout = 180000;
				// свежий кеш позволяет продолжить без запроса к GitHub
				if(!err && latest != null && latest.release != null && (+latest.time || 0) + check_timeout >= +new Date()){
					print("Search latest release on GitHub skipped, next check on [31m" + Math.ceil((latest.time + check_timeout - +new Date()) / 1000) + "[39m seconds");
					return use_release(latest.release);
				}
				// запрос тегов после истечения кеша или ошибки его чтения
				print("Search latest release for kernel on GitHub ...");
				github("tags?per_page=100", false, function (err, data){
					// при ошибке GitHub используется ранее закешированный релиз, если он известен
					if(err) return latest && latest.release ? use_release(latest.release) : callback(err);
					// получение списка совместимых тегов из ответа GitHub
					let tags = data.body
						// получение имени каждого тега
						.map(o => o && o.name ? o.name : "")
						// выбор тегов с основной версией текущего ядра
						.filter(a => a.split(".")[0] === process.env.PDB_VERSION.split(".")[0])
						// сортировка по номеру релиза от нового к старому
						.sort((a, b) => b.split(".")[1] - a.split(".")[1]);
					// если не найден подходящий тег
					if(tags[0] == null){
						return callback(new Error("Release by kernel version [33m" + process.env.PDB_VERSION + "[39m not found!"));
					}
					// сохранение времени проверки и последней совместимой версии
					outputJson(release_latest, { time: +new Date(), release: tags[0] }, function (err){
						if(err) return callback(err);
						use_release(tags[0]);
					});
				});
			});
		});
	});
};

// доступ к обычному require для загрузки модулей app и source после сборки проекта
global.require_path = path => require(path);
// глобальные пути к библиотекам собранного приложения, для передачи в worker
global.require_paths = module.paths;

// добавление версии ProjectDB в общий список версий текущего процесса
process.versions[name] = version;
// версия ядра, используемая для поиска совместимого приложения
process.env.PDB_VERSION = config.PDB_VERSION;
// вывод версии ядра при запуске
print("Kernel init version [33m" + process.env.PDB_VERSION + "[39m ...");

// экспорт загрузчика серверного приложения
module.exports = {
	// поиск приложения в рабочей директории, пользовательском кеше и GitHub
	get: function (callback){
		// локальная библиотека имеет приоритет перед кешем и загрузкой релиза
		load_application_file(join(process.cwd(), "lib", "app.so"), function (err, application){
			if(err) return exit(err);
			if(application) return start_application(application, callback);
			// выбор версии приложения с учетом основного и резервного маркеров
			get_application_release(function (err, release){
				if(err) return exit(err);
				// загрузка выбранного релиза и запуск проверенного приложения
				load_release_application(release, function (err, application){
					if(err) return exit(err);
					start_application(application, callback);
				});
			});
		});
	}
}
