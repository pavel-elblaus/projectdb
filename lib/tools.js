"use strict";
// загрузка базовых модулей
const { inspect } = require("util");

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
// экспорт функции вывода значения в процесс менеджер
module.exports.metric = (function() {
	// метрика для менеджера процессов pm2
	if(process.env.PDB_METRIC === "pm2"){
		// загрузка модуля метрики
		const pm2_io = require("@pm2/io");
		// объект хранения активированных метрик для последующих обновлений данных
		let metric = {};
		// исполняемая функция, для отправки данных
		return function pm2_metric(name, value){
			// проверяем существования объекта метрики
			if(metric[name] == null){
				// создаем
				metric[name] = pm2_io.metric({ name });
			}
			// устанавливаем значение
			metric[name].set(value);
		}
	}
	// заглушка
	return function(){}
})();