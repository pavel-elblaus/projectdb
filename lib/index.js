"use strict";
// загрузка базовых модулей
const { print } = require("./tools.js");
const app = require("./app.js");

// фикс для собранного приложения, иначе не может найти пути из app и source модулей
global.require_path = path => require(path);
// глобальные пути к библиотекам собранного приложения, для передачи в worker
global.require_paths = module.paths;

// пишем клиенту
print("Start production mode version \x1b[33m"+process.env.PDB_VERSION+"\x1b[0m ...");

// загружаем модуль, запускаем приложение
app.run("node.projectdb.pro");