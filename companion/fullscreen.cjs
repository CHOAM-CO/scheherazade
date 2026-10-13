'use strict'

// Foreground bounds are physical pixels on Windows; compare with the monitor
// returned by user32, never Electron's DIP work area (200% DPI matters here).
function coversMonitor(rect, monitor) {
  return !!rect && !!monitor && ['left', 'top', 'right', 'bottom'].every(k => Number.isFinite(rect[k]) && Number.isFinite(monitor[k])) &&
    Math.abs(rect.left - monitor.left) <= 1 && Math.abs(rect.top - monitor.top) <= 1 &&
    Math.abs(rect.right - monitor.right) <= 1 && Math.abs(rect.bottom - monitor.bottom) <= 1
}
function createFullscreenProbe({ platform = process.platform, BrowserWindow, log }) {
  if (platform !== 'win32') return () => ({ fullscreen: !!BrowserWindow.getFocusedWindow()?.isFullScreen(), known: false })
  try {
    const koffi = require('koffi')
    const user = koffi.load('user32.dll')
    const RECT = koffi.struct('SeraCompanionRect', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
    const INFO = koffi.struct('SeraCompanionMonitor', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' })
    const foreground = user.func('void * __stdcall GetForegroundWindow()')
    const desktop = user.func('void * __stdcall GetDesktopWindow()')
    const shellWindow = user.func('void * __stdcall GetShellWindow()')
    const getRect = user.func('bool __stdcall GetWindowRect(void *, _Out_ SeraCompanionRect *)')
    const monitorFromWindow = user.func('void * __stdcall MonitorFromWindow(void *, uint32)')
    const getMonitor = user.func('bool __stdcall GetMonitorInfoW(void *, _Inout_ SeraCompanionMonitor *)')
    return () => {
      const hwnd = foreground()
      if (!hwnd) return { fullscreen: false, known: false }
      if (hwnd === desktop() || hwnd === shellWindow()) return { fullscreen: false, known: true }
      const rect = {}, info = { cbSize: koffi.sizeof(INFO) }
      if (!getRect(hwnd, rect) || !getMonitor(monitorFromWindow(hwnd, 2), info)) return { fullscreen: false, known: false }
      return { fullscreen: coversMonitor(rect, info.rcMonitor), known: true }
    }
  } catch (e) {
    log(`companion: foreground detection unavailable; proactive disabled (${e.message})`)
    return () => ({ fullscreen: false, known: false })
  }
}
module.exports = { coversMonitor, createFullscreenProbe }
