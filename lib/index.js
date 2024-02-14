"use strict";
// загрузка базовых модулей
const { print } = require("./tools.js");
const { get } = require("./app.js");

// запрос библиотеки
get( app => {
	// пишем клиенту
	print("Start production mode version \x1b[33m"+process.env.PDB_VERSION+"\x1b[0m ...");
	// запуск приложения
	app.run("node.projectdb.pro");
} );