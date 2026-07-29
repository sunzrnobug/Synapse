import { Buffer } from "node:buffer"
import { vi } from "vitest"

type Listener = (...args: unknown[]) => void
type EventTargetMock = ReturnType<typeof createEventTarget>
type TrayMock = EventTargetMock & {
  setToolTip: ReturnType<typeof vi.fn>
  setContextMenu: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

const windowByWebContents = new WeakMap<object, object>()

function createEventTarget() {
  const listeners = new Map<string, Listener[]>()
  return {
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    }),
  }
}

function createBrowserWindowMock() {
  const events = createEventTarget()
  const webContents = {
    ...createEventTarget(),
    send: vi.fn(),
    openDevTools: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  }
  const win = {
    ...events,
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    webContents,
    once: vi.fn((event: string, listener: Listener) => events.on(event, listener)),
    show: vi.fn(),
    showInactive: vi.fn(),
    hide: vi.fn(),
    isVisible: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    focus: vi.fn(),
    setOpacity: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setFocusable: vi.fn(),
    setBounds: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 100, height: 100 })),
    destroy: vi.fn(),
  }
  windowByWebContents.set(webContents, win)
  return win
}

export const contextBridge = { exposeInMainWorld: vi.fn() }
export const ipcRenderer = { invoke: vi.fn(), on: vi.fn() }
export const ipcMain = { handle: vi.fn(), on: vi.fn() }
export const app = {
  whenReady: vi.fn(() => Promise.resolve()),
  getAppPath: vi.fn(() => "/app"),
  getPath: vi.fn((name: string) => `/mock-${name}`),
  getVersion: vi.fn(() => "0.0.0"),
  getFileIcon: vi.fn(() => Promise.resolve({ isEmpty: () => true, toDataURL: () => "" })),
  isPackaged: false,
  on: vi.fn(),
  quit: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
}
export const BrowserWindow = Object.assign(vi.fn(createBrowserWindowMock), {
  getAllWindows: vi.fn(() => []),
  getFocusedWindow: vi.fn(() => undefined),
  fromWebContents: vi.fn((webContents: object) => windowByWebContents.get(webContents) ?? null),
})
export const session = { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } }
export const screen = {
  getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
  getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
  getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
  getDisplayMatching: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
}
export const nativeImage = {
  createEmpty: vi.fn(() => ({ isEmpty: vi.fn(() => true) })),
  createFromPath: vi.fn(() => ({ isEmpty: vi.fn(() => false) })),
  createFromDataURL: vi.fn((value: string) => ({ dataUrl: value })),
}
export const Notification = Object.assign(
  vi.fn(() => ({ show: vi.fn() })),
  { isSupported: vi.fn(() => true) }
)
export const Menu = {
  buildFromTemplate: vi.fn((template: unknown) => ({
    popup: vi.fn(),
    template,
  })),
}
export const Tray = vi.fn(function (this: TrayMock) {
  Object.assign(this, createEventTarget(), {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    destroy: vi.fn(),
  })
})
export const protocol = {
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn(),
}
export const net = { fetch: vi.fn() }
export const shell = {
  openExternal: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(() => Promise.resolve("")),
}
export const dialog = {
  showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
  showSaveDialog: vi.fn(() => Promise.resolve({ canceled: true })),
}
export const safeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString("utf-8")),
}
export const clipboard = {
  readText: vi.fn(() => ""),
  writeText: vi.fn(),
  readImage: vi.fn(() => ({
    isEmpty: vi.fn(() => true),
    getSize: vi.fn(() => ({ width: 0, height: 0 })),
    toDataURL: vi.fn(() => ""),
  })),
  writeImage: vi.fn(),
}
export const desktopCapturer = {
  getSources: vi.fn(() => Promise.resolve([])),
}
export const globalShortcut = {
  register: vi.fn(() => true),
  unregister: vi.fn(),
  isRegistered: vi.fn(() => false),
}
export const nativeTheme = {
  shouldUseDarkColors: false,
  on: vi.fn(),
}
export const utilityProcess = {
  // Real production forking (Critical #1's plugin-process-host.ts) is never
  // exercised in unit tests — every test injects its own fake
  // `forkProcess`/`ChildProcessHandle` — this only needs to exist so the
  // module-level `import { utilityProcess } from "electron"` resolves.
  fork: vi.fn(() => ({
    ...createEventTarget(),
    postMessage: vi.fn(),
    kill: vi.fn(() => true),
    pid: 1,
  })),
}

export default {
  contextBridge,
  ipcRenderer,
  ipcMain,
  app,
  BrowserWindow,
  session,
  screen,
  nativeImage,
  Notification,
  Menu,
  Tray,
  protocol,
  net,
  shell,
  dialog,
  nativeTheme,
  safeStorage,
  clipboard,
  desktopCapturer,
  globalShortcut,
  utilityProcess,
}
