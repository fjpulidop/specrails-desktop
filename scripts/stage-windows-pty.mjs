/** Fix node-pty's helper fork in the staged copy, never in developer node_modules. */
import fs from 'node:fs'
import path from 'node:path'

export function patchWindowsPtyAgent(source) {
  const start = '    WindowsPtyAgent.prototype._getConsoleProcessList = function () {'
  const end = '    Object.defineProperty(WindowsPtyAgent.prototype, "exitCode", {'
  const a = source.indexOf(start)
  const b = source.indexOf(end, a)
  if (a < 0 || b < 0 || !source.slice(a, b).includes('child_process_1.fork(')) {
    throw new Error('node-pty Windows helper changed: review packaged fork compatibility before shipping')
  }
  return source.slice(0, a) + `    // Specrails: pkg execPath is the server, not a general-purpose Node runtime.
    WindowsPtyAgent.prototype._getConsoleProcessList = function () {
        var shellPid = this._innerPid;
        return new Promise(function (resolve) {
            var agent;
            var timeout;
            var settled = false;
            function finish(pids) {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                try { if (agent && agent.connected) agent.disconnect(); } catch (_) {}
                try { if (agent) agent.kill(); } catch (_) {}
                resolve(pids);
            }
            try {
                var runtimeRoot = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH;
                var node = runtimeRoot ? path.join(runtimeRoot, 'node', 'node.exe') : process.execPath;
                if (process.pkg && (!runtimeRoot || !fs.existsSync(node))) {
                    finish([shellPid]);
                    return;
                }
                var helperEnv = Object.assign({}, process.env);
                delete helperEnv.NODE_OPTIONS;
                agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [String(shellPid)], {
                    execPath: node, execArgv: [], env: helperEnv, windowsHide: true
                });
                timeout = setTimeout(function () { finish([shellPid]); }, 5000);
                agent.once('error', function () { finish([shellPid]); });
                agent.once('exit', function () { finish([shellPid]); });
                agent.once('message', function (message) {
                    var pids = message && message.consoleProcessList;
                    finish(Array.isArray(pids) && pids.length && pids.every(function (pid) {
                        return Number.isInteger(pid) && pid > 0;
                    }) ? pids : [shellPid]);
                });
            } catch (_) { finish([shellPid]); }
        });
    };
` + source.slice(b)
}

export function stageWindowsPty(directory, architecture) {
  const required = ['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty.dll', 'winpty-agent.exe', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
  for (const file of required) {
    const target = path.join(directory, 'prebuilds', `win32-${architecture}`, file)
    if (!fs.statSync(target).isFile() || fs.statSync(target).size === 0) throw new Error(`Missing Windows terminal dependency: ${target}`)
  }
  const agentPath = path.join(directory, 'lib', 'windowsPtyAgent.js')
  fs.writeFileSync(agentPath, patchWindowsPtyAgent(fs.readFileSync(agentPath, 'utf8')))
}
