"use strict";
// загрузка базовых модулей
const { inspect } = require("util");

// экспорт
module.exports.exit = exit;
module.exports.print = print;

// функция остановки приложения
function exit(err) {
	// информация по ошибке
	if(err)
		console.error("\x1b[31m[PDB][ERROR]\x1b[0m", err instanceof Error ? err.message : inspect(err, { compact: false, colors: true, depth: null }));
	// выход из приложения
	process.exit();
}
// функция вывода информации в консоль
function print(txt){
	console.log("\x1b[36m[PDB I/O]\x1b[0m", txt);
}