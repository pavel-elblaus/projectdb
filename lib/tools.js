"use strict";
// загрузка базовых модулей
const { name, version } = require("../package.json");
const { inspect } = require("util");
const https = require("https");
const http = require("http");

// экспорт функции остановки приложения
module.exports.exit = function exit(err) {
	// информация по ошибке
	if(err)
		console.error("\x1b[31m[PDB][ERROR]\x1b[0m", err instanceof Error ? err.message : inspect(err, { compact: false, colors: true, depth: null }));
	// выход из приложения
	process.exit();
}
// экспорт функции вывода информации в консоль
module.exports.print = function print(txt){
	console.log("\x1b[36m[PDB I/O]\x1b[0m", txt);
}
// экспорт функции апи запроса к сервису api.github.com
module.exports.github = function github(type, buffer, cb){
	// определяем библиотеку для запроса
	let request = ( buffer === false || buffer && type.indexOf("https:") === 0 ? https : http ).request(buffer ? type : ( "https://api.github.com/repos/pavel-elblaus/projectdb/" + type ), {
		method: "GET",
		headers: {
			"Accept": buffer ? "application/octet-stream" : "application/json",
			"User-Agent": name + " " + version,
			"X-GitHub-Api-Version": "2022-11-28"
		}
	});
	// ответ
	request.on("response", function (res) {
		// при запросе файла перенаправляет на безопасный урл
		if(buffer && res.statusCode === 302){
			module.exports.github(res.headers.location, buffer, cb);
			// СТОП
			return;
		}
		// формируем данные для ответа
		let response = {
			code: res.statusCode,
			body: []
		}
		// загружаем данные ответа
		res.on("data", d => response.body.push(d));
		res.on("end", function () {
			// объединение полученных пакетов
			response.body = Buffer.concat(response.body);
			// если не буфер, декодируем json ответ
			if(buffer === false){
				try {
					response.body = JSON.parse(response.body.toString())
				} catch (err) {
					return cb({
						code: 500,
						body: err
					})
				}
			}
			// если код ответа успешный
			if(response.code === 200) cb(null, response);
			// или ошибка
			else cb(response);
		});
	});
	// ошибка
	request.on("error", function (err) {
		cb({
			code: 500,
			body: err
		})
	});
	// таймаут
	request.on("timeout", function () {
		request.abort();
	});
	// установка таймаута
	request.setTimeout(60000);
	// отправка
	request.end();
}