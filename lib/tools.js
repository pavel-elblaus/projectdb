"use strict";
// загрузка базовых модулей
const { name, version } = require("../package.json");
const { inspect } = require("util");
const https = require("https");
const http = require("http");

// экспорт общего завершения CLI с кодом результата
module.exports.exit = function exit(err) {
	// вывод причины ошибки перед завершением
	if(err)
		console.error("\x1b[31m[PDB][ERROR]\x1b[0m", err instanceof Error ? err.message : inspect(err, { compact: false, colors: true, depth: null }));
	// ненулевой код сообщает оболочке о неуспешном выполнении команды
	process.exit(err ? 1 : 0);
}
// экспорт стандартного информационного вывода ProjectDB
module.exports.print = function print(txt){
	console.log("\x1b[36m[PDB I/O]\x1b[0m", txt);
}
// экспорт функции запроса к GitHub API и файлам релизов
module.exports.github = function github(type, buffer, cb, redirects = 0){
	// формирование полного адреса для API или использование адреса файла из релиза
	let url = buffer ? type : "https://api.github.com/repos/pavel-elblaus/projectdb/" + type;
	// выбор библиотеки запроса в зависимости от протокола сформированного адреса
	let request = ( url.indexOf("https:") === 0 ? https : http ).request(url, {
		// загрузка данных выполняется методом GET
		method: "GET",
		// заголовки для работы с API и бинарными файлами GitHub
		headers: {
			// запрос бинарного содержимого файла или данных в формате JSON
			"Accept": buffer ? "application/octet-stream" : "application/json",
			// информация о клиенте необходимая для выполнения запроса GitHub
			"User-Agent": name + " " + version,
			// фиксированная версия API для одинакового формата ответа
			"X-GitHub-Api-Version": "2022-11-28"
		}
	});
	// признак завершения запроса для защиты от повторного вызова callback
	let completed = false;
	// единая функция завершения запроса
	let complete = function (err, response){
		// пропуск повторных событий ошибки или закрытия соединения
		if(completed) return;
		// фиксация завершения до вызова внешнего обработчика
		completed = true;
		// возврат ошибки и полученного ответа вызывающей стороне
		cb(err, response);
	};
	// обработка HTTP-ответа
	request.on("response", function (res) {
		// обработка перенаправления при запросе файла на безопасный адрес GitHub
		if(buffer && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location){
			// ограничение количества перенаправлений для защиты от бесконечного цикла
			if(redirects >= 5){
				// освобождение потока ответа без сохранения его содержимого
				res.resume();
				// возврат ошибки превышения допустимого количества перенаправлений
				return complete({
					code: 500,
					body: new Error("Too many redirects while downloading from GitHub.")
				});
			}
			// формирование абсолютного адреса из абсолютного или относительного Location
			let location = new URL(res.headers.location, url).toString();
			// текущий запрос больше не должен вызывать callback
			completed = true;
			// освобождение потока ответа перенаправления
			res.resume();
			// повторный запрос файла по новому адресу
			module.exports.github(location, buffer, cb, redirects + 1);
			// обработка исходного ответа завершена переходом на новый адрес
			return;
		}
		// формирование объекта для кода ответа и поступающих частей содержимого
		let response = {
			code: res.statusCode,
			body: []
		}
		// последовательное накопление всех частей ответа
		res.on("data", d => response.body.push(d));
		// обработка полного завершения ответа
		res.on("end", function () {
			// пропуск события если запрос уже завершен другим обработчиком
			if(completed) return;
			// объединение всех полученных частей в единый буфер
			response.body = Buffer.concat(response.body);
			// чтение заявленного размера из заголовка Content-Length
			let content_length = Number(res.headers["content-length"]);
			// сравнение заявленного и фактического размера, если заголовок передан
			if(Number.isFinite(content_length) && content_length >= 0 && response.body.length !== content_length){
				return complete({
					code: 500,
					body: new Error("Incomplete response received from GitHub.")
				});
			}
			// преобразование ответа API из буфера в объект JSON
			if(buffer === false){
				try {
					// декодирование строки и разбор данных ответа
					response.body = JSON.parse(response.body.toString())
				} catch (err) {
					// ошибка означает получение некорректного ответа вместо JSON
					return complete({
						code: 500,
						body: err
					})
				}
			}
			// успешный ответ возвращается без ошибки
			if(response.code === 200) complete(null, response);
			// остальные коды ответа передаются как ошибка GitHub
			else complete(response);
		});
		// обработка прерывания ответа до получения всех данных
		res.on("aborted", function () {
			complete({
				code: 500,
				body: new Error("GitHub response was aborted before completion.")
			});
		});
		// обработка ошибки чтения потока ответа
		res.on("error", function (err) {
			complete({
				code: 500,
				body: err
			});
		});
	});
	// обработка ошибки создания запроса или подключения
	request.on("error", function (err) {
		complete({
			code: 500,
			body: err
		})
	});
	// обработка превышения допустимого времени запроса
	request.on("timeout", function () {
		// принудительное завершение запроса с передачей причины в обработчик error
		request.destroy(new Error("GitHub request timed out."));
	});
	// установка максимального времени ожидания сетевой активности
	request.setTimeout(60000);
	// завершение формирования и отправка HTTP-запроса
	request.end();
}
