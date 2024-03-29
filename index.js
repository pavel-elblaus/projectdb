"use strict";
// загрузка базовых модулей
const { print } = require("./lib/tools.js");
const { get } = require("./lib/app.js");

// экспорт
module.exports = function init(){
	// запрос библиотеки
	get( app => {
		// пишем клиенту
		print("Start development mode version \x1b[33m"+process.env.PDB_VERSION+"\x1b[0m ...");
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
		// запуск инициализации
		app.init(...arguments);
	} );
};