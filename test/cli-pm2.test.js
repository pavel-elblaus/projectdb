// ---------------------------------------------------------
// Проверки команд запуска ProjectDB и PM2
// ---------------------------------------------------------

// Запуск: npm test. Выполняется код lib/cli.js с подменой файлов, процессов и системных команд.
// Реальные службы и приложения не останавливаются. events хранит порядок действий, files — содержимое условных файлов.
// Параметр fail моделирует ошибку операции; assert проверяет результат и отсутствие опасных следующих действий.

"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join, posix } = require("node:path");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const vm = require("node:vm");
const { Command, InvalidArgumentError } = require("commander");

const cli = readFileSync(join(__dirname, "../lib/cli.js"), "utf8");
const pm2Require = createRequire(require.resolve("pm2/package.json"));

// Все процессы, файлы и вызовы systemctl заменены состоянием в памяти.
// Эти тесты не подключаются к установленному демону PM2 и не управляют системой.
// Выполнение сценария и сбор результата для проверок ниже.
function run(args, options = {}) {
	const events = [];
	const messages = [];
	const env = { ...options.env };
	const user = options.user || "root";
	if(env.USER == null) env.USER = user;
	if(env.LOGNAME == null) env.LOGNAME = user;
	const home = user === "root" ? "/root" : "/home/" + user;
	const pm2Home = env.PM2_HOME || home + "/.pm2";
	const dump = env.PM2_DUMP_FILE_PATH || pm2Home + "/dump.pm2";
	const agent = env.PM2_INTERACTION_CONF || pm2Home + "/agent.json5";
	const unit = "/etc/systemd/system/pm2-" + user + ".service";
	const service = "/etc/systemd/system/pdb.demo.service";
	const files = new Map([["/work/db.demo.json", {}]]);
	if(options.unit !== false) files.set(unit, "PM2 unit");
	if(options.linked !== false) files.set(agent, options.agentConfig || { public_key: "public", secret_key: "secret" });
	const initialAgent = files.get(agent);
	if(options.piDevice != null) files.set(home + "/.projectdb/raspberrypi-device", options.piDevice);
	if(options.service) files.set(service, "ProjectDB unit");
	let apps = (options.apps || []).map(name => ({ name, pid: 100 }));
	if(options.dump !== null) files.set(dump, options.dump || apps.map(({ name }) => ({ name })));
	let alive = options.alive !== false;
	let agentAlive = options.agentAlive == null ? options.linked !== false : options.agentAlive;
	let enabled = options.unit !== false;
	let cwd = "/work";
	let error;
	let completed = false;
	const halted = {};
	const fail = name => options.fail === name ? new Error("Failure: " + name) : null;
	const missing = () => Object.assign(new Error("Missing file"), { code: "ENOENT" });
	const finish = err => { error = err; completed = true; throw halted; };
	const fse = {
		ensureDirSync() {},
		readFileSync(path) { if(!files.has(path)) throw missing(); return files.get(path); },
		pathExists(path, cb) { cb(null, files.has(path)); },
		readJson(path, cb) {
			if(path === dump && options.badDump) return cb(new Error("Invalid JSON"));
			cb(files.has(path) ? null : missing(), files.get(path));
		},
		outputJson(path, data, options, cb) {
			events.push("write:" + path);
			if(fail("write")) return cb(fail("write"));
			files.set(path, JSON.parse(JSON.stringify(data)));
			cb();
		},
		chmod(path, mode, cb) { cb(); },
		outputFile(path, data, options, cb) { events.push("write:" + path); files.set(path, data); cb(); },
		remove(path, cb) {
			events.push("remove:" + path);
			if(fail("remove")) return cb(fail("remove"));
			files.delete(path);
			cb();
		}
	};
	const pm2 = {
		Client: { pingDaemon(cb) { events.push("ping"); cb(alive); } },
		connect(cb) {
			events.push(alive ? "connect" : "spawn");
			if(!alive && files.has(agent)) agentAlive = true;
			alive = true;
			cb();
		},
		disconnect(cb) { events.push("disconnect"); cb(); },
		describe(name, cb) { events.push("describe:" + name); cb(null, apps.filter(app => app.name === name)); },
		list(cb) { events.push("list"); cb(fail("list"), apps); },
		delete(name, cb) {
			events.push("delete:" + name);
			if(fail("delete")) return cb(fail("delete"));
			if(name === "all" && apps.length === 0) return cb(new Error("process name not found"));
			apps = name === "all" ? [] : apps.filter(app => app.name !== name);
			cb();
		},
		dump(force, cb) {
			events.push("dump");
			if(fail("dump")) return cb(fail("dump"));
			files.set(dump, apps.map(({ name }) => ({ name })));
			cb();
		},
		start(config, cb) {
			events.push("start:" + config.name);
			if(!apps.some(app => app.name === config.name)) apps.push({ name: config.name, pid: 100 });
			cb();
		},
		restart(name, cb) { events.push("restart:" + name); cb(); },
		killDaemon(cb) {
			events.push("kill");
			this.killAgent(() => { alive = false; apps = []; cb(); });
		},
		killAgent(cb) {
			events.push("kill-agent");
			if(fail("agent")) return cb(fail("agent"));
			if(!agentAlive) return cb(new Error("Interactor not launched"));
			agentAlive = false;
			cb();
		},
		agentInfos(cb) { cb(agentAlive ? null : new Error("Interactor is offline"), agentAlive ? files.get(agent) : undefined); },
		linkManagement(secret, publicKey, machine, options, cb) {
			events.push("link"); files.set(agent, { secret_key: secret, public_key: publicKey }); agentAlive = true; cb();
		},
		exitCli() { throw new Error("Unexpected PM2 exitCli"); }
	};
	function execFile(file, args, cb) {
		if(file === "systemctl") {
			const event = "systemctl:" + args.join(" ");
			events.push(event);
			if(fail(args[0])) return cb(fail(args[0]), "", "systemctl failure");
			if(args[0] === "disable" && args[1] === "--now") {
				enabled = false;
				// Активный unit выполняет ExecStop, а неактивный не влияет на ручной демон.
				if(options.unitActive !== false && alive) { alive = false; agentAlive = false; apps = []; }
			}
			return cb();
		}
		assert.equal(file, "/usr/bin/node");
		let command = args[1];
		assert.ok(command === "startup" || command === "unstartup" || command === "unlink");
		if(command === "unlink"){
			assert.deepEqual(Array.from(args), ["/projectdb/node_modules/pm2/bin/pm2", "unlink"]);
			events.push("unlink");
			if(fail("unlink")) return cb(fail("unlink"), "", "Unable to unlink PM2+");
			agentAlive = false;
			files.delete(agent);
			return cb();
		}
		assert.deepEqual(Array.from(args), ["/projectdb/node_modules/pm2/bin/pm2", command]);
		events.push(command);
		if(command === "unstartup" && !files.has(unit))
			return cb(null, "[PM2][ERROR] Return code : 5", "Failed to stop service: Unit not loaded.");
		if(fail(command)){
			return cb(fail(command), "", "Permission denied");
		}
		if(command === "startup"){
			files.set(unit, "PM2 unit");
			enabled = true;
		} else {
			let installed = files.has(unit);
			files.delete(unit);
			enabled = false;
			// Штатный unstartup останавливает демон, если unit был активен.
			if(installed && options.unitActive !== false && alive){
				alive = false;
				agentAlive = false;
				apps = [];
			}
		}
		cb();
	}
	function mockedRequire(name) {
		if(name === "commander") return { program: new Command(), InvalidArgumentError };
		if(name === "../package.json") return { name: "projectdb", description: "test", version: "3.4.0" };
		if(name === "./tools.js") return { print(message) { messages.push(message); }, exit: finish };
		if(name === "fs-extra") return fse;
		if(name === "child_process") return { execFile };
		if(name === "path") return posix;
		if(name === "os") return { homedir: () => home };
		if(name === "readline") return { createInterface() { throw new Error("Unexpected prompt"); } };
		if(name === "pm2") return pm2;
		if(name === "./index.js") { events.push("kernel"); finish(); }
		throw new Error("Unexpected require " + name);
	}
	mockedRequire.resolve = name => "/projectdb/node_modules/pm2/" + (name === "pm2" ? "index.js" : "bin/pm2");
	try {
		vm.runInNewContext(cli, {
			require: mockedRequire, __dirname: "/projectdb/lib", console, Error,
			process: {
				argv: ["node", "projectdb", ...args], platform: options.platform || "linux", env,
				execPath: "/usr/bin/node", cwd: () => cwd, chdir: path => { cwd = posix.resolve(cwd, path); },
				stdin: { isTTY: false }, stdout: { isTTY: false }
			}
		}, { filename: "cli.js" });
	} catch(err) { if(err !== halted) throw err; }
	assert.equal(completed, true, "command must complete");
	return { env, events, messages, files, alive, agentAlive, initialAgent, enabled, apps, error, dump, agent, unit, service };
}

// Общие ожидания полной очистки PM2: приложения, автозапуск, агент и сохранённые настройки.
function cleaned(result, agentAlive = false, keys = false) {
	assert.equal(result.error, undefined);
	assert.equal(result.alive, false);
	assert.equal(result.enabled, false);
	assert.equal(result.files.has(result.unit), false);
	assert.equal(result.agentAlive, agentAlive);
	assert.equal(result.files.has(result.agent), keys);
	if(keys) assert.deepEqual(result.files.get(result.agent), result.initialAgent);
	assert.deepEqual(result.files.get(result.dump), []);
	assert.equal(result.events.includes("spawn"), false, "cleanup must not spawn PM2");
}

// ---------------------------------------------------------
// Переход с PM2 на другой режим запуска
// ---------------------------------------------------------

// При переходе в службу сначала отключаем PM2+, затем старый автозапуск, и только потом запускаем службу.
test("service-start unlinks PM2+ before stopping the last PM2 process", () => {
	const result = run(["service-start", "demo"], { apps: ["demo"] });
	cleaned(result);
	assert.equal(result.events.includes("dump"), false, "an empty dump must not be written twice");
	assert.ok(result.events.indexOf("unlink") < result.events.indexOf("unstartup"));
	assert.ok(result.events.indexOf("unstartup") < result.events.indexOf("systemctl:restart pdb.demo.service"));
	assert.match(result.files.get(result.service), /--work-path "\/work"/);
});

// Если PM2 уже остановлен, убираем сохранённое приложение и автозапуск, сохраняя прежние настройки подключения.
test("offline daemon still has its saved app and old startup removed while retaining the link", () => {
	const result = run(["service-start", "demo"], { alive: false, dump: [{ name: "demo" }] });
	cleaned(result, true, true);
	assert.equal(result.events.includes("kill-agent"), false);
});

// Отсутствующий или пустой список приложений не должен мешать удалению старого автозапуска PM2.
test("missing or empty dump still cleans up an old PM2 startup", () => {
	for(const dump of [null, []]) cleaned(run(["start", "demo"], { alive: false, dump }), true, true);
});

// У работающего пустого PM2 очищаем устаревший список, чтобы старое приложение не восстановилось позже.
test("an empty live daemon with a stale dump cannot resurrect old apps", () => {
	cleaned(run(["start", "demo"], { apps: [], dump: [{ name: "demo" }] }));
});

// При переносе одного приложения оставшиеся работающие приложения сохраняют PM2, автозапуск и мониторинг.
test("other live applications preserve PM2 startup and monitoring", () => {
	const result = run(["service-start", "demo"], { apps: ["demo", "demo-other"] });
	assert.equal(result.error, undefined);
	assert.deepEqual(result.apps.map(app => app.name), ["demo-other"]);
	assert.deepEqual(result.files.get(result.dump), [{ name: "demo-other" }]);
	assert.equal(result.enabled, true);
	assert.equal(result.files.has(result.agent), true);
	assert.equal(result.events.includes("kill-agent"), false);
	assert.equal(result.agentAlive, true);
});

// При остановленном PM2 чужие сохранённые приложения и их автозапуск тоже должны остаться.
test("other saved applications preserve startup and monitoring with the daemon offline", () => {
	const result = run(["service-start", "demo"], { alive: false, dump: [{ name: "demo" }, { name: "other" }] });
	assert.equal(result.error, undefined);
	assert.deepEqual(result.files.get(result.dump), [{ name: "other" }]);
	assert.equal(result.enabled, true);
	assert.equal(result.files.has(result.agent), true);
	assert.equal(result.events.includes("spawn"), false);
	assert.equal(result.events.includes("kill-agent"), false);
	assert.equal(result.agentAlive, true);
});

// ---------------------------------------------------------
// Остановка приложений и обработка ошибок очистки
// ---------------------------------------------------------

// Явная команда pm2-stop без имени удаляет все приложения как при работающем, так и при остановленном PM2.
test("pm2-stop without a name cleans all apps, including when daemon is offline", () => {
	for(const alive of [true, false]) cleaned(run(["pm2-stop"], { alive, apps: ["demo", "other"] }), !alive, !alive);
});

// Остановка по имени очищает PM2 полностью только для последнего приложения; остальные приложения сохраняются.
test("pm2-stop by name cleans the last app but preserves other apps", () => {
	cleaned(run(["pm2-stop", "demo"], { apps: ["demo"] }));
	const result = run(["pm2-stop", "demo"], { apps: ["demo", "other"] });
	assert.equal(result.error, undefined);
	assert.equal(result.enabled, true);
	assert.equal(result.events.filter(event => event === "dump").length, 1);
	assert.equal(result.events.includes("kill-agent"), false);
});

// Запущенный вручную PM2 нужно завершить после удаления даже неактивной службы автозапуска.
test("a manually started daemon is killed after its inactive startup unit is removed", () => {
	const result = run(["start", "demo"], { apps: ["demo"], unitActive: false });
	cleaned(result);
	assert.ok(result.events.indexOf("kill") > result.events.indexOf("unstartup"));
});

// Если службы автозапуска нет, PM2 завершается через собственный API без вызовов systemctl.
test("without an installed startup unit the PM2 API stops the daemon", () => {
	const result = run(["pm2-stop", "demo"], { apps: ["demo"], unit: false });
	assert.equal(result.error, undefined);
	assert.equal(result.alive, false);
	assert.ok(result.events.includes("kill"));
	assert.ok(result.events.indexOf("kill") > result.events.indexOf("unstartup"));
	assert.ok(result.events.includes("unlink"));
	assert.ok(result.events.includes("kill-agent"));
	assert.equal(result.agentAlive, false);
	assert.equal(result.files.has(result.agent), false);
	assert.equal(result.events.some(event => event.startsWith("systemctl:")), false);
});

// Даже пустой работающий PM2 после общей остановки не должен сохранять мониторинг и автозапуск.
test("stopping an already empty live PM2 still unlinks and disables startup", () => {
	cleaned(run(["pm2-stop"], { apps: [] }));
});

// Ошибка удаления приложения запрещает дальнейшую полную очистку PM2, чтобы не остановить оставшиеся процессы.
test("a failed application deletion prevents full PM2 cleanup", () => {
	const result = run(["pm2-stop"], { apps: ["demo"], fail: "delete" });
	assert.ok(result.error);
	assert.equal(result.events.includes("unlink"), false);
	assert.equal(result.alive, true);
});

// Диагностика PM2 показывается как есть: наличие слова ERROR в тексте не заменяет проверку результата операции.
test("unstartup output is shown without interpreting PM2 diagnostic messages", () => {
	const result = run(["start", "demo"], { alive: false, unit: false });
	assert.equal(result.error, undefined);
	assert.ok(result.messages.includes("[PM2][ERROR] Return code : 5"));
	assert.ok(result.messages.includes("Failed to stop service: Unit not loaded."));
	assert.ok(result.events.includes("kernel"));
});

// Если список оставшихся приложений не сохранился, новую службу запускать нельзя.
test("a failed save of remaining applications prevents a service launch", () => {
	const result = run(["service-start", "demo"], { apps: ["demo", "other"], fail: "dump" });
	assert.ok(result.error);
	assert.equal(result.events.includes("systemctl:restart pdb.demo.service"), false);
	assert.equal(result.events.includes("unlink"), false);
});

// ---------------------------------------------------------
// Запуск PM2 и подключение мониторинга
// ---------------------------------------------------------

// Первый запуск PM2 сначала запускает приложение и сохраняет список, затем включает автозапуск.
test("pm2-start enables startup only after start and dump, with the bundled PM2 CLI", () => {
	const result = run(["pm2-start", "demo"], { alive: false, unit: false, linked: false });
	assert.equal(result.error, undefined);
	assert.equal(result.enabled, true);
	assert.ok(result.events.indexOf("startup") > result.events.indexOf("dump"));
	assert.ok(result.events.indexOf("dump") > result.events.indexOf("start:demo"));
});

// Повторный pm2-start сохраняет одно приложение с прежним именем и обновляет автозапуск.
test("repeated pm2-start uses the same application name and refreshes startup", () => {
	const result = run(["pm2-start", "demo"], { apps: ["demo"] });
	assert.equal(result.error, undefined);
	assert.equal(result.apps.length, 1);
	assert.ok(result.events.includes("startup"));
	assert.equal(result.events.includes("delete:demo"), false);
});

// Параметр --link при первом запуске должен создать подключение к мониторингу PM2+.
test("pm2-start --link creates the initial monitoring connection", () => {
	const result = run(["pm2-start", "demo", "--link", "secret,public"], { linked: false, alive: false });
	assert.equal(result.error, undefined);
	assert.equal(result.files.has(result.agent), true);
	assert.ok(result.events.includes("link"));
	assert.ok(result.events.includes("startup"));
});

// После полной очистки прежние ключи не восстанавливаются автоматически; новый запуск без --link не подключает мониторинг.
test("after a full stop pm2-start requires --link to configure PM2+ again", () => {
	const stopped = run(["pm2-stop"], { agentConfig: { public_key: "original-public", secret_key: "original-secret" } });
	cleaned(stopped);
	const started = run(["pm2-start", "demo"], { alive: false, agentAlive: false, unit: false, linked: false });
	assert.equal(started.error, undefined);
	assert.equal(started.agentAlive, false);
	assert.equal(started.events.includes("link"), false);
});

// Остановленный PM2 нельзя запускать только ради остановки отдельно работающего агента мониторинга.
test("an offline PM2 is not initialized only to stop a separate agent", () => {
	const result = run(["start", "demo"], { alive: false, agentAlive: true, unit: false, dump: null });
	cleaned(result, true, true);
	assert.equal(result.events.includes("kill-agent"), false);
	assert.equal(result.events.includes("kill"), false);
});

// Отсутствующий или уже остановленный агент не должен превращать обычную очистку в ошибку.
test("already stopped and never configured agents are both normal cleanup results", () => {
	for(const linked of [true, false]) {
		const result = run(["pm2-stop"], { alive: false, agentAlive: false, linked });
		cleaned(result, false, linked);
		assert.equal(result.files.has(result.agent), linked);
	}
});

// Совпадающие ключи существующего подключения не должны вызывать повторную активацию PM2+.
test("pm2-start keeps an existing matching link without activating it again", () => {
	const result = run(["pm2-start", "demo", "--link", "secret,public"]);
	assert.equal(result.error, undefined);
	assert.equal(result.events.includes("link"), false);
	assert.equal(result.files.has(result.agent), true);
});

// ---------------------------------------------------------
// Обычный запуск, точные имена и перезапуск
// ---------------------------------------------------------

// Первый запуск в текущем терминале запускает ProjectDB без ненужного фонового PM2 и его автозапуска.
test("a first console launch never starts a God Daemon", () => {
	const result = run(["start", "demo"], { alive: false, unit: false, linked: false, dump: null });
	assert.equal(result.error, undefined);
	assert.equal(result.events.includes("spawn"), false);
	assert.equal(result.events.includes("startup"), false);
	assert.ok(result.events.includes("kernel"));
});

// Поиск приложения выполняется по точному имени: demo не должен удалять demo-other.
test("a similar application name is preserved when the exact name does not exist", () => {
	const result = run(["pm2-stop", "demo"], { apps: ["demo-other"] });
	assert.match(result.error.message, /does not exist/);
	assert.deepEqual(result.apps.map(app => app.name), ["demo-other"]);
	assert.equal(result.events.includes("kill-agent"), false);
	assert.equal(result.enabled, true);
});

// Перезапуск приложения через PM2 сохраняет существующий автозапуск и мониторинг.
test("pm2-restart keeps existing startup and monitoring", () => {
	const result = run(["pm2-restart", "demo"], { apps: ["demo"] });
	assert.equal(result.error, undefined);
	assert.ok(result.events.includes("restart:demo"));
	assert.equal(result.events.includes("kill-agent"), false);
	assert.equal(result.enabled, true);
});

// Перезапуск службы устраняет конфликт с одноимённым PM2; остановка службы не затрагивает чужие приложения.
test("service-restart also cleans the last PM2 app; service-stop only removes its own unit", () => {
	cleaned(run(["service-restart", "demo"], { apps: ["demo"], service: true }));
	const result = run(["service-stop", "demo"], { apps: ["other"], service: true });
	assert.equal(result.error, undefined);
	assert.equal(result.files.has(result.service), false);
	assert.equal(result.enabled, true);
	assert.equal(result.events.includes("kill-agent"), false);
});

// ---------------------------------------------------------
// ОС, пользователь и ошибки системных операций
// ---------------------------------------------------------

// На Windows команды PM2 не должны пытаться создавать или удалять службы systemd.
test("non-Linux systems do not attempt systemd startup management", () => {
	const options = { platform: "win32" };
	const result = run(["pm2-start", "demo"], options);
	assert.equal(result.error, undefined);
	assert.equal(result.events.includes("startup"), false);
	const stopped = run(["pm2-stop"], options);
	assert.equal(stopped.error, undefined);
	assert.equal(stopped.alive, false);
	assert.equal(stopped.events.some(event => event.startsWith("systemctl:")), false);
});

// Пути автозапуска учитывают пользователя ОС, а файлы PM2 — явно заданные переменные окружения.
test("the operating-system account and overridden PM2 paths are respected", () => {
	const result = run(["pm2-start", "demo"], { user: "worker" });
	assert.equal(result.error, undefined);
	assert.ok(result.files.has("/etc/systemd/system/pm2-worker.service"));
	const stopped = run(["pm2-stop"], { env: { PM2_HOME: "/custom", PM2_DUMP_FILE_PATH: "/saved/dump", PM2_INTERACTION_CONF: "/saved/agent" } });
	cleaned(stopped);
	assert.equal(stopped.files.has("/root/.pm2/dump.pm2"), false);
});

// Ошибка сохранения списка или включения автозапуска должна возвращаться пользователю как ошибка запуска.
test("startup and save failures return errors instead of a successful command result", () => {
	for(const fail of ["startup", "dump"]) {
		const result = run(["pm2-start", "demo"], { fail });
		assert.ok(result.error);
		if(fail === "dump") assert.equal(result.events.includes("startup"), false);
	}
});

// Ошибка очистки старого режима запрещает запуск новой службы, чтобы не получить конфликт процессов.
test("cleanup failures prevent a conflicting ProjectDB service from being started", () => {
	for(const fail of ["write", "unlink", "unstartup"]) {
		const result = run(["service-start", "demo"], { apps: ["demo"], fail });
		assert.ok(result.error, fail);
		assert.equal(result.events.includes("systemctl:restart pdb.demo.service"), false);
	}
});

// Повреждённый сохранённый список приложений должен остановить очистку до изменения автозапуска и мониторинга.
test("invalid saved dump prevents destructive cleanup", () => {
	const result = run(["service-start", "demo"], { alive: false, badDump: true });
	assert.ok(result.error);
	assert.equal(result.events.includes("kill-agent"), false);
	assert.equal(result.enabled, true);
});

// ---------------------------------------------------------
// Совместимость с установленной версией PM2
// ---------------------------------------------------------

// Проверяем код установленного PM2 5.4.2 с подменами: unlink должен остановить агент и удалить его настройки.
test("PM2 5.4.2 unlink stops the agent and deletes its saved configuration", () => {
	assert.equal(pm2Require("./package.json").version, "5.4.2");
	const source = readFileSync(pm2Require.resolve("./lib/API/pm2-plus/link.js"), "utf8");
	let killed = false;
	let deleted = false;
	let exited = false;
	const module = { exports: {} };
	vm.runInNewContext(source, {
		module, console: { log() {} }, process: { exit() { exited = true; } },
		require(name) {
			if(name === "fs") return { unlinkSync() { deleted = true; } };
			if(name.endsWith("Common.js")) return { retErr: err => err };
			if(name === "@pm2/agent/src/InteractorClient") return { killInteractorDaemon(conf, cb) { killed = true; cb(); } };
			return {};
		}
	});
	function API() {}
	module.exports(API);
	new API().unlink();
	assert.equal(killed, true);
	assert.equal(deleted, true);
	assert.equal(exited, true);
});

// Проверяем код и шаблон PM2 с подменами: startup создаёт нужную службу, а unstartup останавливает и удаляет её.
test("the installed PM2 startup commands create and remove the unit using standard systemd operations", () => {
	const source = readFileSync(pm2Require.resolve("./lib/API/Startup.js"), "utf8");
	const template = readFileSync(pm2Require.resolve("./lib/templates/init-scripts/systemd.tpl"), "utf8");
	const written = new Map();
	const commands = [];
	const module = { exports: {} };
	const chalk = text => text;
	chalk.bold = chalk.blue = chalk.red = chalk;
	vm.runInNewContext(source, {
		module, __dirname: "/projectdb/node_modules/pm2/lib/API", console: { error() {} },
		process: { mainModule: { filename: "/projectdb/node_modules/pm2/bin/pm2" }, execPath: "/usr/bin/node", getuid: () => 0, env: { PATH: "/usr/bin", USER: "root" } },
		require(name) {
			if(name === "path") return posix;
			if(name === "chalk") return chalk;
			if(name === "fs") return {
				existsSync() { return false; },
				readFileSync(path) { assert.ok(path.endsWith("systemd.tpl")); return template; },
				writeFileSync(path, contents) { written.set(path, contents); }
			};
			if(name.endsWith("constants.js")) return { PM2_ROOT_PATH: "/root/.pm2" };
			if(name === "../Common.js") return { printOut() {}, printError() {} };
			if(name === "../tools/which.js") return command => command === "systemctl" ? "/bin/systemctl" : null;
			if(name === "../tools/sexec") return (command, cb) => { commands.push(command); cb(0); };
			if(name === "async/forEachLimit") return (items, limit, each, cb) => {
				for(const item of items) each(item, err => assert.equal(err, undefined));
				cb();
			};
			return pm2Require(name);
		}
	});
	function API() {}
	module.exports(API);
	let completed = false;
	new API().startup("systemd", { user: "root" }, (err, result) => {
		assert.equal(err, null);
		assert.equal(result.destination, "/etc/systemd/system/pm2-root.service");
		completed = true;
	});
	assert.equal(completed, true);
	const unit = written.get("/etc/systemd/system/pm2-root.service");
	assert.match(unit, /ExecStart=\/projectdb\/node_modules\/pm2\/bin\/pm2 resurrect/);
	assert.match(unit, /ExecStop=\/projectdb\/node_modules\/pm2\/bin\/pm2 kill/);
	assert.match(unit, /Environment=PM2_HOME=\/root\/\.pm2/);
	let removed = false;
	new API().uninstallStartup("systemd", { user: "root" }, err => {
		assert.equal(err, null);
		removed = true;
	});
	assert.equal(removed, true);
	assert.deepEqual(commands, [
		"systemctl enable pm2-root",
		"systemctl stop pm2-root&& systemctl disable pm2-root&& rm /etc/systemd/system/pm2-root.service"
	]);
});

// Установщики ОС не включают автозапуск PM2 сами: это задача команд запуска ProjectDB.
test("installers leave PM2 startup management to ProjectDB commands", () => {
	for(const system of ["debian", "ubuntu"]) {
		const source = readFileSync(join(__dirname, "../dist/pdb-install-" + system + ".sh"), "utf8");
		assert.doesNotMatch(source, /pm2\s+startup/);
	}
});

// Запуск из systemd не должен останавливать собственную службу, включая устройство Raspberry Pi.
// Признак raspberrypi сохраняется для кода устройства; обычный запуск по-прежнему останавливает старую службу.
for(const metric of ["service", "raspberrypi", undefined]) {
  test(`start: own systemd service is preserved for ${metric || "manual launch"}`, () => {
    const result = run(["start", "demo"], {
      service: true, alive: false, unit: false, dump: null,
      env: metric ? { PDB_METRIC: metric } : {}
    });
    assert.equal(result.error, undefined);
    assert.ok(result.events.includes("kernel"));
    assert.equal(result.events.includes("systemctl:stop pdb.demo.service"), metric === undefined);
    assert.equal(result.files.has(result.service), true);
  });
}

// ---------------------------------------------------------
// Защита специализированной службы LIMS-USB
// ---------------------------------------------------------
// Отметка устройства действует независимо от выбранного рабочего каталога.
for (const command of ["service-start", "service-stop", "service-restart", "pm2-start", "pm2-stop", "pm2-restart"]) {
 test("LIMS-USB blocks " + command, () => {
  const result = run([command, "demo"], {piDevice: "demo", service: true});
  assert.match(result.error.message, /managed by systemd/);
  assert.deepEqual(result.events, []);
 });
}
test("LIMS-USB manual start uses its existing service", () => {
 const result = run(["start", "demo", "-w", "/elsewhere"], {piDevice: "demo", service: true});
 assert.equal(result.error, undefined);
 assert.deepEqual(result.events, ["systemctl:start pdb.demo.service"]);
});
test("LIMS-USB rejects another name", () => {
 const result = run(["start", "other"], {piDevice: "demo"});
 assert.match(result.error.message, /registered LIMS-USB/);
 assert.deepEqual(result.events, []);
});
test("LIMS-USB rejects invalid device registration", () => {
 const result = run(["start", "demo"], {piDevice: "../demo"});
 assert.match(result.error.message, /Invalid LIMS-USB/);
 assert.deepEqual(result.events, []);
});
test("LIMS-USB systemd start enters the application", () => {
 const result = run(["start", "demo"], {piDevice: "demo", env:{PDB_METRIC:"raspberrypi"}, alive:false, unit:false, linked:false});
 assert.equal(result.error, undefined);
 assert.ok(result.events.includes("kernel"));
 assert.ok(!result.events.some(value => value.startsWith("systemctl:")));
});

// CLI использует стандартные пути PM2 и сохраняет явно заданное окружение.
test("PM2 keeps its standard data directory",()=>{
 const r=run(["pm2-start","demo"]);
 assert.equal(r.env.PM2_HOME,undefined);
 assert.equal(r.dump,"/root/.pm2/dump.pm2");
 assert.equal(r.error,undefined);
});
test("PM2 preserves an explicit data directory",()=>{
 const r=run(["pm2-start","demo"],{env:{PM2_HOME:"/custom/pm2"}});
 assert.equal(r.env.PM2_HOME,"/custom/pm2");
 assert.equal(r.dump,"/custom/pm2/dump.pm2");
 assert.equal(r.error,undefined);
});
test("systemd application output goes to ProjectDB logs",()=>{
 const r=run(["service-start","demo"]);assert.equal(r.error,undefined);
 const unit=r.files.get(r.service);
 assert.match(unit,/^StandardOutput=append:\/root\/\.projectdb\/log\/pdb\.demo\.log$/m);
 assert.match(unit,/^StandardError=append:\/root\/\.projectdb\/log\/pdb\.demo\.log$/m);
});
