import { t } from "./i18n.js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
let mounted;
export function retainTerminal() { return mounted?.element.isConnected ? mounted.element : null; }
export function mountTerminal(runId, element) {
  if (mounted?.element === element) { mounted.fit.fit(); return; }
  closeTerminalView();
  if (!element) return;
  const terminal = new Terminal({ fontFamily: "ui-monospace, monospace", fontSize: 12, cursorBlink: true, scrollback: 5000, theme: { background: "#211d2a", foreground: "#f5f1fa" } });
  const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element); fit.fit();
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal/${runId}`);
  const resize = () => { fit.fit(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows })); };
  socket.onopen = resize;
  socket.onmessage = event => { const data = JSON.parse(event.data); if (data.reset) terminal.reset(); if (data.data) terminal.write(data.data); if (data.error) terminal.writeln(`\r\n${data.error}`); if (data.exited) terminal.writeln("\r\n" + t("Terminal exited. Return control to Studio to continue.")); };
  socket.onerror = () => terminal.writeln("\r\n" + t("Terminal view disconnected. Reopen this tab to reconnect; the process stays running."));
  terminal.onData(text => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", text })); });
  const observer = new ResizeObserver(resize); observer.observe(element);
  mounted = { element, terminal, socket, observer, fit }; terminal.focus();
}
export function closeTerminalView() { if (mounted) { mounted.observer.disconnect(); mounted.socket.close(); mounted.terminal.dispose(); mounted = null; } }
