"use strict";
// загрузка базовых модулей
const _path = require("path");
const _fs = require("fs");
const _fse = require("fs-extra");
const _moment = require("moment");
const { metric } = require("./tools");
const { version } = require("../package.json");

// версия приложения
process.env.PDB_VERSION = "15.14.0";

/** запрос временной директории процесса */
global.tmp_path = (function (){
	// создаем / проверяем пусть к временной директории
	let path_tmp = _path.join(process.cwd(), "tmp");
	if(!_fs.existsSync(path_tmp)) _fs.mkdirSync(path_tmp, { recursive: true });
	// функция запроса пути к директории
	return function (){
		// создаем / проверяем пусть к временной директории сервера
		let path = process.env.PDB_SERVERNAME ? _path.join(path_tmp, "server", process.env.PDB_SERVERNAME) : path_tmp;
		if(!_fs.existsSync(path)) _fs.mkdirSync(path, { recursive: true });
		// ответ
		return path;
	}
})();

/** логер ошибок */
global.log = (function () {
	const _strip_ansi = require("strip-ansi");
	const _util = require("util");
	// получение сводной информации для лога
	let get_log_info = function(){
		return {
			date: _moment().format("YYYY-MM-DD HH:mm:ss Z"),
			version: process.env.PDB_VERSION
		}
	};
	// конвертирование входящих данных для лога
	let get_log_text = function(args, colors = false, trim_object = false){
		return {
			// параметр сокращение объекта начинает действовать только с 3-его аргумента
			text: Array.from(args).map(function(o, i) { return to_str(o, colors, i > 1 ? trim_object : false ) }).join(" ")
		}
	};
	// перевод значения к строке
	let to_str = function(o, colors = false, trim_object = false){
		if(o === null){
			return "NULL";
		}
		if(typeof o === "undefined"){
			return "UNDEFINED";
		}
		if (typeof o === "object"){
			if(o instanceof Date){
				return _moment(o).format("YYYY-MM-DD HH:mm:ss Z");
			}
			// сокращение отображения объекта/массива
			if(trim_object){
				if(o instanceof Array){
					return "[...]";
				}
				return "{...}";
			}
			return _util.inspect(o, { compact: false, colors: colors, depth: null })
		}
		return colors ? o.toString() : _strip_ansi(o.toString());
	};
	// чистка массива лога
	let get_log_array = function(o){
		// очистка от специальных объектов todo не нравится мне система логирования для базы!!!
		let trim_object = function(val) {
			// null или undefined сразу возвращаем
			if(val == null){
				return null;
			}
			// массив
			if(val instanceof Array){
				// если пустой, возвращаем null
				if(val.length === 0){
					return null;
				}
				// запускаем рекурсию очистки каждого элемента массива
				let out = [];
				for(let i in val){
					out[i] = trim_object(val[i]);
				}
				// возврат полученных данных
				return out;
			}
			// дата
			if(val instanceof Date){
				// возврат полученных данных
				return _moment(val).format("YYYY-MM-DD HH:mm:ss Z");
			}
			// буфер
			if(val instanceof Uint8Array || val instanceof Buffer){
				return "[Buffer]"
			}
			// все остальные объекты
			if(typeof val === "object"){
				// формируем массив ключей объекта
				let keys = Object.keys(val);
				// если пустой, возвращаем null
				if(keys.length === 0){
					return null;
				}
				// запускаем рекурсию очистки каждого элемента объекта
				let out = {};
				for(let i of keys){
					let v = trim_object(val[i]);
					// если не null и не undefined, записываем в новый объект
					if(v != null){
						out[i] = v;
					}
				}
				// если получился пустой, возвращаем null
				if(Object.keys(out).length === 0){
					return null;
				}
				// возврат полученных данных
				return out;
			}
			// оставляем как есть
			return val;
		};
		// возврат объекта
		return {
			array: Array.from(o).map(function(o) {
				// проверка если NULL
				if(o === null){
					return "NULL";
				}
				// проверка если UNDEFINED
				if(typeof o === "undefined"){
					return "UNDEFINED";
				}
				// если строка, очищаем от раскраски
				if(typeof o === "string"){
					return _strip_ansi(o);
				}
				// чистка объекта
				o = trim_object(o);
				// проверка если получился NULL
				if(o === null){
					return "NULL";
				}
				// оставляем как есть
				return o;
			})
		}
	};
	// запрос временной директории
	let path_tmp = tmp_path();
	// пути, файлы для логирования
	let out_file = _path.join(path_tmp, "stdout.log");
	let err_file = _path.join(path_tmp, "stderr.log");
	// создаем клиента для отправки данных в базу
	let client = (function () {
		let pg_console = false;
		return {
			pg: function () {
				// если не активирован канал консоли и активирован основной канал приложения
				if(pg_console === false && global.pg){
					// поднимаем собственный канал для консоли
					pg_console = require_source("channel")(1, "console")();
				}
				return pg_console ? pg_console.query(...arguments, false) : null
			}
		}
	})();
	// функции действий логирования
	return {
		inf: function (msg = "", obj = null) {
			return {
				name: "LogInfo" + (msg != null && msg.name ? (" (" + msg.name + ")") : ""),
				message: msg != null && msg.message ? msg.message : msg,
				data: msg != null && msg.data ? msg.data : obj,
			}
		},
		infStr: function(msg = "", obj = null){
			return to_str(this.inf(...arguments));
		},
		err: function (msg = "", obj = null) {
			return {
				name: "LogError" + (msg != null && msg.name ? (" (" + msg.name + ")") : ""),
				message: msg != null && msg.message ? msg.message : msg,
				data: msg != null && msg.data ? msg.data : obj,
				stack: msg != null && typeof msg.stack === "string" ? msg.stack.split("\n") : (new Error()).stack.split("\n")
			}
		},
		errStr: function(msg = "", obj = null){
			return to_str(this.err(...arguments));
		},
		infPrint: function () {
			let info = get_log_info();
			// пишем консоль
			if(!global.config || config.get("log", "console") !== "off") {
				// в консоль
				console.log(Object.values({...info, ...get_log_text(arguments, true, true)}).join(" ~ "));
			}
			// пишем в лог
			if(!global.config || config.get("log", "stdout") === "1"){
				let data = {...info, ...get_log_text(arguments)};
				// в файл
				_fs.appendFile(out_file, Object.values(data).join(" ~ ") + "\n", function (err) {
					if(err) {
						log.errPrint("ERROR SERVER SEND LOG", err);
					}
				});
				// в базу
				let data_db = {...info, ...get_log_array(arguments)};
				client.pg("web_api_console", data_db, function (err) {
					if(err) {
						log.errPrint("ERROR SERVER SEND LOG", err);
					}
				});
			}
		},
		errPrint: function () {
			let info = get_log_info();
			// пишем консоль
			if(!global.config || config.get("log", "console") !== "off") {
				// в консоль
				console.error(Object.values({...info, ...get_log_text(arguments, true)}).join(" ~ "));
			}
			// пишем в лог
			if(!global.config || config.get("log", "stderr") === "1"){
				let data = {...info, ...get_log_text(arguments)};
				// в файл
				_fs.appendFile(err_file, Object.values(data).join(" ~ ") + "\n", function (err) {
					if(err) {
						log.errPrintFile("ERROR SERVER SEND ERR", err);
					}
				});
				// в базу
				let data_db = {...info, ...get_log_array(arguments)};
				client.pg("web_api_error_server", data_db, function (err) {
					if(err) {
						log.errPrintFile("ERROR SERVER SEND ERR", err);
					}
				});
			}
		},
		errPrintFile: function () {
			let info = get_log_info();
			// пишем консоль
			if(!global.config || config.get("log", "console") !== "off") {
				// в консоль
				console.error(Object.values({...info, ...get_log_text(arguments, true)}).join(" ~ "));
			}
			// пишем в лог
			if(!global.config || config.get("log", "stderr") === "1"){
				let data = {...info, ...get_log_text(arguments)};
				// в файл
				_fs.appendFile(err_file, Object.values(data).join(" ~ ") + "\n", function (err) {
					if(err) {
						console.error("ERROR errPrintFile", err);
					}
				});
			}
		},
		setLogFolder: function (path){
			// изменение пути до файлов лога
			out_file = _path.join(path, "stdout.log");
			err_file = _path.join(path, "stderr.log");
		}
	}
})();

// вешаем события для текущего процесса
process.on("uncaughtException", function (err) { log.errPrint("ERROR UNCAUGHT EXCEPTION", log.err(err)) });
process.on("exit", function (code) { log.infPrint("process exit (" + code + ")") });
process.on("SIGINT", function () { process.exit() });

// создаем uuid устройства
process.uuid = (function (){
	const _os = require("os");
	const _crypto = require("crypto");
	// массив данных для ключа
	let key = [];
	// логические ядра ЦП
	key.push(_os.cpus().map(c => c.model).join(", "));
	// общий объем оперативной памяти
	key.push(_os.totalmem());
	// сетевые интерфейсы
	let interfaces = _os.networkInterfaces();
	for(let [k, v] of Object.entries(interfaces)){
		if(v instanceof Array){
			key.push(k + ": " + v.map(i => i.mac).join(", "))
		}
	}
	// формируем ключ
	key = _crypto.createHash("md5").update(key.join()).digest("hex");
	// форматируем ключ
	key = [key.substring(0, 8), key.substring(8, 12), key.substring(12, 16), key.substring(16, 20), key.substring(20)];
	// возврат готового ключа
	return key.join("-");
})();

// метрики
metric("Device ID", process.uuid);
metric("Node version", version);

// настройки по умолчанию
let cli_conf = {
	servername: "PDB-SERVER",
	host: "www.projectdb.ru",
	password: "",
};

// импорт функции
module.exports = {
	// функция инициализации
	init: function (cli_serv_conf, cb) {
		// загружаем подсказки при вводе если существуют
		let file_cli_conf = _path.join(tmp_path(), "cli.json");
		if(_fs.existsSync(file_cli_conf)){
			try {
				// конвертируем json файл
				let conf = JSON.parse(_fs.readFileSync(file_cli_conf).toString());
				if(conf){
					for(let [key, val] of Object.entries(conf)){
						cli_conf[key] = val;
					}
				}
			} catch (e) {}
		}

		/** библиотека построения последовательно-параллельных цепочек */
		global.step = (function () {
			// функция запуска следующего шага
			const next_step = function (err = null) {
				let that = this;
				// при ошибке - остановка выполнения
				if(err !== null){
					let last = that.queue[that.queue.length - 1];
					if(last && typeof last.func === "function"){
						last.func.apply(that, [log.err(that.name, err)]);
					} else {
						throw new Error("Last function from send error on Step() not found.");
					}
					return;
				}

				// входящие данные из прошлого шага
				let args = [].slice.call(arguments, 1);

				// запуск следующего шага, если есть
				let _ = that.queue.shift();
				if(typeof _ !== "undefined") {
					// последовательные функции
					if(typeof _.func === "function"){
						let recall = !1, next_seq = function (err = null) {
							// повторный вызов внутри функции
							if(recall) {
								throw new Error("Callback function call again");
							}
							recall = !0;
							// ошибка выполнения
							if(err !== null){
								next_step.apply(that, [{
									step: _.step,
									type: "seq",
									stack: err.each ? { "0-each": err.each } : { "0": log.inf(err) }
								}]);
							}
							// данные по ответу, переход к следующему шагу
							else {
								next_step.apply(that, [null, ...[].slice.call(arguments, 1)]);
							}
						};
						try {
							_.func.apply(that, [next_seq, ...args]);
						}
						// если при выполнении произошла синтаксическая ошибка
						catch (e) {
							next_seq.apply(that, [e]);
						}
					}
					// параллельные функции
					else
					if(_.func instanceof Array) {
						let length = _.func.length, errs = {}, outs = [];
						// вызов стека параллельных функций
						for(let key of Object.keys(_.func)) (function (index, func, step) {
							let next_par = function (err = null, out) {
								// повторный вызов внутри параллельной функции
								if(index in outs){
									throw new Error("Re-calling callback function #"+index+" inside a parallel function");
								}
								// ошибка выполнения
								if(err !== null){
									if(err.each){
										errs[index + "-each"] = err.each;
									} else {
										errs[index] = log.inf(err);
									}
								}
								// данные по ответу
								outs[index] = out;
								// завершения стека параллельных функций
								if(--length === 0){
									// стек ошибок при выполнении
									if(Object.keys(errs).length !== 0){
										next_step.apply(that, [{
											step: step,
											type: "par",
											stack: errs
										}]);
									}
									// переход к следующему шагу
									else {
										next_step.apply(that, [null, ...outs]);
									}
								}
							};
							try {
								func.apply(that, [next_par, ...args]);
							}
							// если при выполнении произошла синтаксическая ошибка
							catch (e) {
								next_par.apply(that, [e]);
							}
						})(key, _.func[key], _.step)
					}
					// неизвестный тип, что-то пошло не так
					else {
						throw new Error("Unknown function type \"_.func\" on Step().");
					}
				}

				return null;
			};
			// возврат экземпляра функции для построения цепочки шагов
			return function (name = "unknown step chain name") {
				const that = { name, queue: [], length: 0 };
				return {
					/** Функция добавления последовательных шагов
					 *  параметры: next, param, ...
					 * */
					seq: function () {
						let fn = typeof arguments[0] === "function" ? arguments[0] : function(){};
						that.queue.push({
							step: ++that.length,
							func: fn
						});
						return this;
					},
					/** Функция добавления параллельных шагов
					 *  параметры: next, param, ...
					 * */
					par: function () {
						let fn = typeof arguments[0] === "function" ? arguments[0] : function(){};
						let last = that.queue[that.queue.length - 1];
						if(last && last.func instanceof Array){
							last.func.push(fn)
						} else {
							that.queue.push({
								step: ++that.length,
								func: [fn]
							});
						}
						return this;
					},
					/** Последовательный перебор первого параметра входящего Array или Object с возможностью подмены данных
					 *  параметры: next, value, key, index, param, ...
					 * */
					seqEach: function () {
						let fn = typeof arguments[0] === "function" ? arguments[0] : function(){};
						return this.seq(function (next, data) {
							let that = this,
								args = [].slice.call(arguments, 2)
							;
							if(data !== null && typeof data === "object"){
								let _data = data instanceof Array ? [...data] : {...data},
									_queue = Object.entries(data),
									index = 0
								;
								// функция последовательного вызова функций
								let seq = function(){
									let _ = _queue.shift();
									if(typeof _ !== "undefined"){
										(function (key, value, index) {
											let next_seq_each = function (err = null, replace) {
												if(err !== null){
													next.apply(that, [{ each: [{ key, error: log.inf(err) }] }]);
													return;
												}
												// маппинг, подмена данных
												if(typeof replace !== "undefined"){
													_data[key] = replace;
												}
												seq();
											};
											fn.apply(that, [next_seq_each, value, key, index, ...args]);
										})(_[0], _[1], index++);
									} else {
										next.apply(that, [null, _data, ...args]);
									}
								};
								seq();
							} else {
								next.apply(that, [null, data, ...args]);
							}
						});
					},
					/** Параллельный перебор первого параметра входящего Array или Object с возможностью подмены данных
					 *  параметры: next, value, key, index, param, ...
					 * */
					parEach: function () {
						let fn = typeof arguments[0] === "function" ? arguments[0] : function(){};
						return this.seq(function (next, data) {
							let that = this,
								args = [].slice.call(arguments, 2)
							;
							if(data !== null && typeof data === "object"){
								let _data = data instanceof Array ? [...data] : {...data},
									length = Object.keys(data).length,
									errs = [],
									index = 0
								;
								// вызов стека параллельных функций
								if(length > 0){
									for(let i in _data) (function (key, value, index) {
										let next_par_each = function (err = null, replace) {
											if(err !== null){
												errs.push({ key, error: log.inf(err) });
											}
											// маппинг, подмена данных
											if(typeof replace !== "undefined"){
												_data[key] = replace;
											}
											if(--length === 0){
												if(errs.length !== 0){
													next.apply(that, [{ each: errs }]);
												} else {
													next.apply(that, [null, _data, ...args]);
												}
											}
										};
										fn.apply(that, [next_par_each, value, key, index, ...args]);
									})(i, _data[i], index++)
								} else {
									next.apply(that, [null, _data, ...args]);
								}
							} else {
								next.apply(that, [null, data, ...args]);
							}
						});
					},
					/** Функция добавления заключающего шага
					 *  параметры: error, param, ...
					 * */
					exec: function () {
						let fn = typeof arguments[0] === "function" ? arguments[0] : function(){};
						this.seq(function () {
							let that = this;
							// затираем функцию следующего шага, если не ошибка
							if(typeof arguments[0] === "function"){
								arguments[0] = null;
							}
							// завершение
							try {
								fn.apply(that, arguments);
							} catch (e) {
								fn.apply(that, [e]);
							}
							// чистка
							that.queue = null;
						});
						// запускаем очередь
						return next_step.apply(that);
					},
					/** Конвертирует все входящие аргументы в массив
					 *  параметры: -
					 * */
					array: function () {
						return this.seq(function (next) {
							next.apply(that, [null, [].slice.call(arguments, 1)]);
						});
					},
					/** Конвертирует второй входящий парамер в аргументы
					 *  параметры: -
					 * */
					arguments: function () {
						return this.seq(function (next, data) {
							if(data !== null && typeof data === "object"){
								next.apply(that, [null, ...Object.values(data)]);
							} else {
								next.apply(that, [null, data]);
							}
						});
					},
					/** Установка данных для следующего шага (клонирует входящие аргументы)
					 *  параметры: param, ...
					 * */
					set: function () {
						let args = Object.values([].slice.call(arguments));
						return this.seq(function (next) {
							next.apply(that, [null, ...args]);
						});
					},
					/** Функция для проверки по условиям с возможностью остановить цепочку
					 * параметры: proceed, finish, args
					 * */
					check: function () {
						let fn = typeof arguments[0] === "function" ? arguments[0] : function(){};
						return this.seq(function (next) {
							let that = this,
								args = [].slice.call(arguments, 1);
							// для продолжения цепочки
							let proceed = function () {
								next.apply(that, [null, ...args]);
							};
							// для остановки цепочки
							let finish = function () {
								let last = that.queue[that.queue.length - 1];
								if(last && typeof last.func === "function"){
									last.func.apply(that, [null, ...args]);
								} else {
									throw new Error("Last function from check on Step() not found.");
								}
							};
							fn.apply(that, [proceed, finish, args]);
						});
					}
				}
			}
		})();

		/** работа с временными именами */
		global.tmp_name = (function (){
			let counter = 0;
			return function (){
				return process.uuid + "-" + ++counter;
			}
		})();

		/** функция получения хеша по объекту */
		global.hash_object = (function (){
			// https://www.npmjs.com/package/object-hash
			const _hash = require("object-hash");
			// настройки для получения хещ объекта
			let options = {
				algorithm: "md5",
				unorderedObjects: false,
				unorderedSets: false,
				respectFunctionNames: false,
				respectFunctionProperties: false,
				respectType: false
			};
			return function (){
				return _hash({...arguments}, options)
			}
		})();

		/** функция генерации нового хеша */
		global.hash_generation = (function (){
			let chars_num = "0123456789",
				chars_num_length = chars_num.length,
				chars_str = "ABCDEFGHIKLMNOPQRSTUVWXYZabcdefghiklmnopqrstuvwxyz",
				chars_str_length = chars_str.length;
			// функция
			return function (str = true, num = true){
				let hash = "";
				// первая половина
				if(str){
					for (let i=0; i<6; i++) {
						let n = Math.floor(Math.random() * chars_str_length);
						hash += chars_str.substring(n, n + 1);
					}
					if(num) {
						hash += "-";
					}
				}
				// вторая половина
				if(num){
					for (let i=0; i<4; i++) {
						let n = Math.floor(Math.random() * chars_num_length);
						hash += chars_num.substring(n, n + 1);
					}
				}
				// сохраняем имя окна
				return hash;
			}
		})();

		/** база конфигураций по процессу */
		global.config = (function (){
			// база данных конфигурации
			let database = {};
			// функция проверки на нечего
			let check = function (data){
				return typeof data !== "undefined";
			}
			// функции работы с настройками конфигураций
			return {
				// запрос настройки
				get: function ($arg0, $arg1, $arg2, $arg3) {
					switch (arguments.length) {
						case  0: return database;
						case  1: return check(database[$arg0]) ? database[$arg0] : null;
						case  2: return database[$arg0] && check(database[$arg0][$arg1]) ? database[$arg0][$arg1] : null;
						case  3: return database[$arg0] && database[$arg0][$arg1] && check(database[$arg0][$arg1][$arg2]) ? database[$arg0][$arg1][$arg2] : null;
						case  4: return database[$arg0] && database[$arg0][$arg1] && database[$arg0][$arg1][$arg2] && check(database[$arg0][$arg1][$arg2][$arg3]) ? database[$arg0][$arg1][$arg2][$arg3] : null;
						default: return null
					}
				},
				// сохранение настройки
				set: function ($arg0, $arg1, $arg2, $arg3) {
					let arg = arguments;
					return function ($data) {
						switch (arg.length) {
							case 1:
								database[$arg0] = $data;
								break;
							case 2:
								if(!check(database[$arg0])) database[$arg0] = {};
								database[$arg0][$arg1] = $data;
								break;
							case 3:
								if(!check(database[$arg0])) database[$arg0] = {};
								if(!check(database[$arg0][$arg1])) database[$arg0][$arg1] = {};
								database[$arg0][$arg1][$arg2] = $data;
								break;
							case 4:
								if(!check(database[$arg0])) database[$arg0] = {};
								if(!check(database[$arg0][$arg1])) database[$arg0][$arg1] = {};
								if(!check(database[$arg0][$arg1][$arg2])) database[$arg0][$arg1][$arg2] = {};
								database[$arg0][$arg1][$arg2][$arg3] = $data;
								break;
						}
					}
				}
			};
		})();

		// опросник пользователя
		let question = {
			// функция отправки вопроса если неизвестен ответ
			exec: (function () {
				const _readline = require("readline");
				return function (input, text, cb) {
					// берем имя из параметра
					if(input){
						// отдаем
						cb(input);
					}
					// если не передан параметр
					else {
						const rl = _readline.createInterface({
							input: process.stdin,
							output: process.stdout
						});
						// спросить у пользователя
						rl.question(text, function (input) {
							// закрываем
							rl.close();
							// отдаем
							cb(input);
						});
					}
				}
			})()
		};

		// начинаем процесс авторизации/инициализации
		step("start the authorization / initialization process")
			// наименование процесса
			.seq(function (next1) {
				// берем имя из параметра, если нет задает вопрос
				question.exec(process.env.PDB_SERVERNAME, "Please enter servername [[33m"+cli_conf.servername+"[39m]: ", function (name) {
					// применить, продолжить выполнение запуска сервера
					process.env.PDB_SERVERNAME = name || cli_conf.servername;
					// сохраняем конфигурацию
					cli_conf.servername = process.env.PDB_SERVERNAME;
					// устанавливаем папку лога по серверу
					log.setLogFolder(tmp_path());
					// след шаг
					next1();
				});
			})
			// поддержка однозначности
			.seq(function (next1) {
				let file_pid = _path.join(tmp_path(), "server.pid");
				if(_fs.existsSync(file_pid)){
					let pid = _fs.readFileSync(file_pid);
					try {
						process.kill(pid, "SIGINT");
					} catch (e) {}
				}
				_fs.writeFileSync(file_pid, process.pid.toString());

				// лог старта
				log.infPrint("server [36m"+process.env.PDB_SERVERNAME+"[39m#"+process.pid+" - [32m"+process.uuid+"[39m");

				// след шаг
				next1();
			})
			// поиск конфигурации основной базы данных
			.seq(function (next1) {
				/**
				 *  Доступны параметры настройки (базы данных)
				 *    user        : Пользователь
				 *    pass        : Пароль
				 *    host        : Хост/IP адрес
				 *    port        : Порт
				 *    db          : База данных
				 *    schema      : Схема
				 *    min_connect : Минимальное кол-во подключений
				 *    max_connect : Максимальное кол-во подключений
				 *    channel     : Кол-во активных работников
				 **/
				let file_db_process_conf = _path.join(process.cwd(), "db."+process.env.PDB_SERVERNAME+".json"),
					file_db_conf = _path.join(process.cwd(), "db.json");
				// проверяем доступна ли конфигурация для подключения к базе (для процесса)
				if(_fs.existsSync(file_db_process_conf)){
					log.infPrint("got first configuration in process file");
					let out;
					try {
						// конвертируем json файл, след шаг
						out = JSON.parse(_fs.readFileSync(file_db_process_conf).toString())
					} catch (err) {
						// след шаг
						return next1(err);
					}
					next1(null, {
						database_config: "local-process",
						database: out
					});
				} else
				// проверяем доступна ли конфигурация для подключения к базе
				if(_fs.existsSync(file_db_conf)){
					log.infPrint("got first configuration in global file");
					let out;
					try {
						// конвертируем json файл, след шаг
						out = JSON.parse(_fs.readFileSync(file_db_conf).toString())
					} catch (err) {
						// след шаг
						return next1(err);
					}
					next1(null, {
						database_config: "local",
						database: out
					});
				}
				// добыть конфигурацию подключения если нет на диске
				else {
					log.infPrint("getting first configuration from the network");

					const _io_client = require("socket.io-client");
					const _crypto = require("crypto");

					// начинаем процесс загрузки/расшифровки конфигурации подключения к основной базе
					step("we begin the process of loading / decrypting the configuration of the connection to the main base")
						// спрашиваем хост
						.seq(function (next2) {
							// берем хост из предварительной конфигурации, если нет задает вопрос
							question.exec(cli_serv_conf.host, "Please enter host server keys [[33m"+cli_conf.host+"[39m]: ", function (host) {
								host = host || cli_conf.host;
								// сохраняем конфигурацию
								cli_conf.host = host;
								// след шаг
								next2(null, host);
							});
						})
						// запрашиваем зашифрованный файл с сервера
						.seq(function (next2, host) {
							// метрика
							metric("Server key", host);
							// пробуем подключится
							log.infPrint("connect to host \"[33m"+host+"[39m\" ...");
							let io = _io_client("wss://"+host+"/server", {
								path: "/ws",
								reconnection: false
							});
							io.on("connect", function(){
								// таймаут ожидания ответа
								let request_timeout = setTimeout(function (){
									// отметка, что сработал таймаут запроса
									request_timeout = true;
									// ошибка по таймауту
									next2(new Error("Server did not respond to the request"));
								}, 30000);
								// запрос конфигурации
								log.infPrint("config request ...");
								io.binary(false).emit("server.config", process.env.PDB_VERSION, process.env.PDB_SERVERNAME, function (err, buffer) {
									// если отработал таймаут, обработка ответа не требуется
									if(request_timeout === true){
										return;
									}
									// сброс таймера
									clearTimeout(request_timeout);
									// обработка ответа
									if(err){
										// ошибка
										next2(err);
									} else {
										// файл получен, все ок
										log.infPrint("config buffer received successfully, decryption ...");
										next2(null, buffer.toString());
									}
									io.close();
								});
							});
							io.on("connect_error", next2);
						})
						// спрашиваем пароль
						.seq(function (next2, text) {
							// берем пароль из предварительной конфигурации, если нет задает вопрос
							question.exec(cli_serv_conf.password, "Please enter config password from \""+cli_conf.servername+"\"" + (cli_conf.password?" [[33m"+cli_conf.password+"[39m]":"") + ": ", function (password) {
								password = password || cli_conf.password;
								// сохраняем конфигурацию
								cli_conf.password = password;
								// след шаг
								if(password){
									next2(null, text, password);
								} else {
									next2(new Error("You did not enter password!"));
								}
							});
						})
						// декодируем
						.seq(function (next2, text, password) {
							// закрытый ключ
							let hash = _crypto.createHash("sha512");
							hash.update(password);
							let key = hash.digest().slice(0, 32);

							// разбираем строку
							let data = text.split("-");

							// открытый ключ
							let iv = Buffer.from(data[1], "hex");

							let out;
							try {
								// декодируем
								let decipher = _crypto.createDecipheriv("aes-256-cbc", key, iv);
								let decrypted = Buffer.concat([decipher.update(Buffer.from(data[0]+data[2], "hex")), decipher.final()]);
								// конвертируем json
								out = { ...JSON.parse(decrypted.toString()), ...{
									host: cli_conf.host,
									database_config: "network"
								} };
							} catch (e) {
								return next2(e)
							}
							next2(null, out)
						})
						// результат
						.exec(next1)
				}
			})
			// инициализация полученной конфигурации (проверка режима разработки)
			.seq(function (next1, process_conf) {
				// вид, как получена первоначальная конфигурация сервера
				if(process_conf.database_config){
					config.set("server", "database_config")(process_conf.database_config);
				}
				// данные регистрации websocket слушателя команд с удаленных серверов, и обновления базы данных
				if(process_conf.monitor && process_conf.host){
					config.set("server", "monitor")({ ...process_conf.monitor, ...{ host: process_conf.host } });
				}
				// подключение к каналу базы данных
				if(process_conf.database){
					config.set("channel", "database")(process_conf.database);
					// кол-во активных каналов
					if(process_conf.database.channel){
						config.set("channel", "count")(process_conf.database.channel);
					}
					// метрика
					metric("Global channel", "database");
				}
				// подключение к каналу базы данных (через websocket)
				if(process_conf.websocket && process_conf.host){
					config.set("channel", "websocket")({ ...process_conf.websocket, ...{ host: process_conf.host } });
					// метрика
					metric("Global channel", "websocket");
				}
				// проверка режима разработки
				let path_source_develop = _path.join(process.cwd(), "develop", "server", "source");
				if(_fs.existsSync(path_source_develop)){
					// загрузка source модуля
					global.require_source = function (path, format = "js") {
						let path_module = _path.join(path_source_develop, path + "." + format);
						// скрипты
						if(format === "js"){
							// пробуем загрузить
							return require(path_module)
						}
						// другие файлы
						else {
							return _fs.existsSync(path_module) ? _fs.readFileSync(path_module) : ""
						}
					};
					// след шаг
					next1(null, true);
				}
				// запрос source, боевой режим работы
				else {
					// если не получен source пакет, запрашиваем из базы postgresql
					if(process_conf.database && !process_conf.source && !process_conf.websocket){
						log.infPrint("get source from database");
						// разово активируем клиентское подключение к базе данных
						const _pg = require("pg");
						const client = new _pg.Client({
							host: process_conf.database.host,
							port: process_conf.database.port,
							user: process_conf.database.user,
							password: process_conf.database.pass,
							database: process_conf.database.db,
							application_name: "ProjectDB (" + process.env.PDB_SERVERNAME + ") - source - " + process.uuid,
						});
						// подключение
						client.connect(function (err){
							if(err){
								return next1(err);
							}
							// отправка запроса
							client.query("SELECT * FROM "+ process_conf.database.schema +".web_server_source($1)", [{
								SERVER_NAME: process.env.PDB_SERVERNAME,
								HTTP_REQUEST: {
									version: process.env.PDB_VERSION
								}
							}], function(err, res) {
								// отпускаем соединение
								client.end();
								// если ошибка
								if(err){
									return next1(err);
								}
								// записываем полученные данные в переменную process_conf.source
								if(res && res.rows && res.rows[0] && res.rows[0]["web_server_source"]){
									process_conf.source = res.rows[0]["web_server_source"];
								}
								// продолжаем загрузку
								next1(null, process_conf.source);
							})
						})
					}
					// продолжаем загрузку
					else {
						// след шаг
						next1(null, process_conf.source);
					}
				}
			})
			// разворачиваем source пакет
			.seq(function (next1, source) {
				// включен режим разработки
				if(source === true){
					log.infPrint("mode develop - [32mon[39m");
					// версия сервера
					process.env.PDB_VERSION = process.env.npm_package_version;
					log.infPrint("source [33m" + process.env.PDB_VERSION + "[39m version");
					return next1();
				}

				// боевой режим работы
				log.infPrint("mode develop - [31moff[39m");

				// проверка source пакета
				if(typeof source !== "object"){
					return next1(new Error("Not found source packed!"))
				}

				// версия сервера
				process.env.PDB_VERSION = source.version;
				log.infPrint("source [33m" + process.env.PDB_VERSION + "[39m version");
				// метрика
				metric("Source version", process.env.PDB_VERSION);

				// файл пакета
				let file_source = _path.join(tmp_path(), "source.zip");
				_fs.writeFileSync(file_source, Buffer.from(source.content, "base64"));

				// загрузка source модуля
				global.require_source = (function (next){
					log.infPrint("unzip source packed");
					// распаковываем, выгружаем в память
					let _source = {}, count_f = 0;
					const _unzip = require("unzip-stream");
					_fs.createReadStream(file_source)
						.pipe(_unzip.Parse())
						.on("entry", function (entry) {
							if(!entry.isDirectory){
								count_f++;
								let bufs = [];
								entry.on("data", function(d){ bufs.push(d) });
								entry.on("end", function(){
									_source[entry.path] = Buffer.concat(bufs);
									count_f--;
									// закончили чтение
									if(count_f === 0){
										log.infPrint("unzip source packed - [32mok[39m");
										next();
									}
								});
							} else {
								entry.autodrain();
							}
						})
						.on("end", function () {
							_fs.unlinkSync(file_source);
						});
					// отдаем рабочею функцию
					return function (path, format = "js") {
						path += "." + format;
						// скрипты
						if(format === "js"){
							let path_tmp = tmp_path();
							let path_module = _path.join(path_tmp, "source", path);
							try {
								// пробуем загрузить
								return require(path_module)
							} catch (e) {
								// проверка существования модуля
								if(typeof _source[path] === "undefined"){
									throw new Error("Source module \""+path+"\" not found");
								}
								// сохраняем в файл
								_fse.outputFileSync(path_module, _source[path]);
								// загружаем модуль
								let module = require(path_module);
								// удаляем временно созданную папку
								_fse.removeSync(_path.join(path_tmp, "source"));
								return module;
							}
						}
						// другие файлы
						else {
							return _source[path] ? _source[path] : "";
						}
					}
				})(next1);
			})
			// инициализация библиотеки обмена данными с базой
			.seq(function (next1) {
				global.pg = require_source("channel")(config.get("channel", "count"));
				// следующий шаг
				next1();
			})
			// запуск монитора событий клиент-сервера
			.seq(function (next1) {
				require_source("monitor")(next1);
			})
			// запускаем наследуемую функцию
			.seq(function (next1) { cb.apply(this, [next1, question]); })
			// ошибки, остановка процесса
			.exec(function (err) {
				if(err){
					// вывод ошибки
					log.errPrint("ERROR SERVER INIT", log.err(err));
					// завершаем процесс
					setTimeout(function () {
						process.exit();
					}, 3000)
				}
				// сохраняем в темп файл введенные данные
				_fs.writeFileSync(file_cli_conf, JSON.stringify(cli_conf));
			});
	},
	// инициализация сервера
	run: function (app_server_host){
		// печатаем заголовок
		console.log("[36m\n    ____                                       __     ____     ____      \n" +
			"   /\\  _`\\                __                  /\\ \\__ /\\  _`\\  /\\  _`\\    \n" +
			"   \\ \\ \\L\\ \\ _ __   ___  /\\_\\      __     ___ \\ \\ ,_\\\\ \\ \\/\\ \\\\ \\ \\L\\ \\  \n" +
			"    \\ \\ ,__//\\`'__\\/ __`\\\\/\\ \\   /'__`\\  /'___\\\\ \\ \\/ \\ \\ \\ \\ \\\\ \\  _ <' \n" +
			"     \\ \\ \\/ \\ \\ \\//\\ \\L\\ \\\\ \\ \\ /\\  __/ /\\ \\__/ \\ \\ \\_ \\ \\ \\_\\ \\\\ \\ \\L\\ \\\n" +
			"      \\ \\_\\  \\ \\_\\\\ \\____/_\\ \\ \\\\ \\____\\\\ \\____\\ \\ \\__\\ \\ \\____/ \\ \\____/\n" +
			"       \\/_/   \\/_/ \\/___//\\ \\_\\ \\\\/____/ \\/____/  \\/__/  \\/___/   \\/___/ \n" +
			"                         \\ \\____/                                        \n" +
			"                          \\/___/[39m         ProjectDB command line interface \n\n\n");

		// если предан хост подключения app.so (меняем настройки по умолчанию)
		if(app_server_host){
			cli_conf.host = app_server_host
		}

		// объект хранения конфигурации подключения к удаленному серверу для получения первоначальной конфигурации процесса
		let	cli_serv_conf = {};
		// если предано наименование сервера, ищем предварительно сохраненный файл подключений
		if(process.env.PDB_SERVERNAME){
			let file_cli_serv_conf = _path.join(process.cwd(), "tmp", "server", process.env.PDB_SERVERNAME, "cli.json");
			if(_fs.existsSync(file_cli_serv_conf)){
				try {
					// конвертируем json
					cli_serv_conf = JSON.parse(_fs.readFileSync(file_cli_serv_conf).toString());
				} catch (e) {}
			}
		}

		// инициализация
		this.init(cli_serv_conf, function (next, question) {
			// процедура запуска сервера
			step("command line interface initialization")
				// получаем информацию по устройству
				.seq(function (next1) {
					log.infPrint("get system information");
					const si = require("systeminformation");
					step("get system information")
						.set(["system","osInfo","networkInterfaces"]) // ,"uuid","versions","diskLayout","memLayout","cpu","baseboard"
						.parEach(function (next2, func) {
							si[func]()
								.then(function (data) {
									next2(null, {[func]: data})
								})
								.catch(function () {
									next2(null, {[func]: false})
								});
						})
						.exec(function (err, data) {
							if(err){
								return next1(err);
							}
							// сливаем в один объект
							let out = {};
							for(let val of data){
								out = {...out, ...val}
							}
							next1(null, out);
						});
				})
				// запрос конфигурации запускаемого процесса
				.seq(function (next1, info) {
					// статус подключения (как была получена конфигурация подключения базы данных)
					info.databaseConfig = config.get("server", "database_config");
					// uuid устройства
					info.uuid = { hardware: process.uuid };
					// добавляем версию запущенного процесса
					info.version = process.env.PDB_VERSION;
					// запрос информации
					log.infPrint("get process configuration");
					pg().query("web_api_deploy", info, next1);
				})
				// подготовка запуска сервера
				.seq(function (next1, data) {
					// загружаем полученную конфигурацию сервера
					if(data && data.config){
						for(let [key, val] of Object.entries(data.config)){
							log.infPrint("set [33m"+key+"[39m configuration");
							// сохранение / перезапись
							config.set(key)(val);
						}
					}
					// метрика
					metric("Machine ID", config.get("machine_id"));
					metric("Port", config.get("port", "http"));
					metric("Port ssl", config.get("port", "https"));
					metric("Proxy", config.get("proxy"));
					// след шаг
					next1(null, {
						// запуск сервисов
						service: data && data.service ? data.service : null,
						// запуск веб-сервера
						webserver: data && data.server ? data.server : null
					})
				})
				// запуск
				.seqEach(function (next1, data, key) {
					if(data === null){
						return next1();
					}
					try {
						require_source(key)(data, next1);
					} catch (err) {
						next1(err)
					}
				})
				// включаем слушатели метрик
				.seq(function (next1, data){
					// метрика по веб-серверу
					if(data.webserver){
						metric("Websites", data.webserver.length);
					}
					// todo переделать в слушатели для получения статистики из worker и websocket
					let update_metric = function (){
						// кол-во активных работников
						metric("Workers", global.worker_count ? global.worker_count : 0);
						// кол-во подключенных клиентов
						metric("Websocket clients", global.websocket_count ? global.websocket_count : 0);
						// сервисы
						if(global.services)
							for(let name in global.services)
								global.services[name].status((err, ids) => metric("Service " + name, err ? null : ids.length));
						// следующее обновление
						setTimeout(update_metric, 10000);
					};
					// первый запуск
					update_metric();
					// далее
					next1();
				})
				// итог
				.exec(function (err) {
					if(err){
						return next(err);
					}
					log.infPrint("server#"+process.pid+" [33m"+process.env.PDB_SERVERNAME+"[39m initialized");
					// выключаем консоль
					if(config.get("log", "console") === "0"){
						log.infPrint("console - [31moff[39m");
						config.set("log", "console")("off")
					} else {
						log.infPrint("console - [32mon[39m");
					}
					// завершение инициализации
					next();
				})
		});
	}
};