import { describe, expect, it } from "vitest"
import { sandboxCommandEnv } from "./command-env"

describe("sandboxCommandEnv", () => {
  it("keeps every allowlisted variable", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      USERPROFILE: "C:\\Users\\user",
      SystemRoot: "C:\\Windows",
      windir: "C:\\Windows",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: "/tmp",
      TMP: "/tmp",
      COMSPEC: "C:\\Windows\\system32\\cmd.exe",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
      LANGUAGE: "en_US",
      // Windows PowerShell startup path/module resolution — none of these
      // are secrets, just standard per-machine system locations. Missing
      // them has been observed causing powershell.exe to hang indefinitely
      // on startup (before running any command) on some Windows CI images,
      // rather than merely running slowly.
      PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramData: "C:\\ProgramData",
      APPDATA: "C:\\Users\\user\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local",
      NUMBER_OF_PROCESSORS: "4",
      PROCESSOR_ARCHITECTURE: "AMD64",
    }
    expect(sandboxCommandEnv(source)).toEqual(source)
  })

  // The old implementation was a denylist of known secret-shaped names, which
  // missed anything that didn't match its exact-name/prefix/suffix patterns
  // (e.g. a `_KEY` suffix instead of `_SECRET`, or a name like `DB_PASS` that
  // isn't a recognized prefix at all). An allowlist can't miss a case like
  // this: anything not explicitly named is stripped, secret-shaped or not.
  it("strips every variable outside the allowlist, including previously-missed secret shapes", () => {
    const env = sandboxCommandEnv({
      PATH: "/usr/bin",
      FOO_SECRET_KEY: "leaked",
      DB_PASS: "leaked",
      PRIVATE_TOKEN: "leaked",
      SAFE_FLAG: "1",
      NODE_OPTIONS: "--require=malicious.js",
      PYTHONPATH: "/malicious",
      GIT_SSH_COMMAND: "malicious",
    })
    expect(env).toEqual({ PATH: "/usr/bin" })
  })

  it("omits an allowlisted key entirely when it is not set in the source", () => {
    expect(sandboxCommandEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" })
  })
})
