"use strict";
// загрузка базовых модулей
const { print } = require("./tools.js");

// фикс для собранного приложения, иначе не может найти пути из app и source модулей
global.require_path = path => require(path);
// глобальные пути к библиотекам собранного приложения, для передачи в worker
global.require_paths = module.paths;

// версия сервера
process.env.npm_package_version = "15.13.0";
// пишем клиенту
print("Start production mode version \x1b[33m"+process.env.npm_package_version+"\x1b[0m ...");

// загружаем модуль, запускаем приложение
require("./app.js").run("node.projectdb.pro");