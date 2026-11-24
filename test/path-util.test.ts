import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { dirLinks, effectiveCwd, expandPathArgs, linkAlias, resolveCanonicalPath } from "../src/path-util"

let root = ""
let home = ""
// `/etc` and `/var` link to `/private/...` on macOS.
const ETC = realpathSync("/etc")
const VAR = realpathSync("/var")

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "ocsp-path-")))
  home = path.join(root, "home")
  mkdirSync(path.join(root, "real/sub"), { recursive: true })
  mkdirSync(path.join(home, ".config/opencode"), { recursive: true })
  writeFileSync(path.join(root, "file"), "")
  symlinkSync(path.join(root, "real"), path.join(root, "link"))
  symlinkSync(path.join(root, "real/sub"), path.join(root, "sublink"))
  symlinkSync(path.join(root, "loop"), path.join(root, "loop"))
  symlinkSync("real/sub", path.join(root, "rel"))
  symlinkSync("rel", path.join(root, "chain"))
  symlinkSync(path.join(home, ".config/opencode"), path.join(root, "oc"))
  mkdirSync(path.join(root, "top/usr/bin"), { recursive: true })
  symlinkSync("usr/bin", path.join(root, "top/bin"))
  symlinkSync("usr", path.join(root, "top/u"))
  symlinkSync("/", path.join(root, "top/up"))
  symlinkSync("self", path.join(root, "top/self"))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("resolveCanonicalPath", () => {
  test.each([
    ["link/x/y", "real/x/y"],
    ["link/sub", "real/sub"],
    ["./real/", "real"],
    ["real/sub/../../file", "file"],
    ["sublink/../z", "real/z"],
    ["rel/../x", "real/x"],
    ["chain/../../file", "file"],
    ["missing/../c", "c"],
    ["missing/../link/x", "real/x"],
    ["file/x", "file/x"],
    ["loop/x", "loop/x"],
    ["*", "*"],
    ["real/sub/../*", "real/*"],
  ])("%s", (input, expected) => {
    expect(resolveCanonicalPath(input, root, home)).toBe(path.join(root, expected))
  })

  test("resolves absolute paths regardless of base", () => {
    expect(resolveCanonicalPath(path.join(root, "link"), "/nowhere", home)).toBe(path.join(root, "real"))
  })

  test.each([
    ["/", "/"],
    ["..", "/"],
    ["../../etc", ETC],
  ])("%s from / is %s", (input, expected) => {
    expect(resolveCanonicalPath(input, "/", home)).toBe(expected)
  })

  test("expands the home directory", () => {
    expect(resolveCanonicalPath("~", "/", home)).toBe(home)
    expect(resolveCanonicalPath("~/.config/opencode/opencode.json", "/", home)).toBe(
      path.join(home, ".config/opencode/opencode.json"),
    )
    expect(resolveCanonicalPath("~other/x", root, home)).toBe(path.join(root, "~other/x"))
  })

  test("handles very long paths", () => {
    const long = "a/".repeat(5000) + "b"
    expect(resolveCanonicalPath(long, root, home)).toBe(path.join(root, long))
  })
})

describe("effectiveCwd", () => {
  test("defaults to the location directory", () => {
    expect(effectiveCwd(undefined, path.join(root, "link"), home)).toBe(path.join(root, "real"))
  })

  test.each([
    ["sub", "real/sub"],
    ["..", ""],
    ["/", "/"],
    ["~", "home"],
  ])("resolves workdir %s", (workdir, expected) => {
    const result = effectiveCwd(workdir, path.join(root, "link"), home)
    expect(result).toBe(expected === "/" ? "/" : path.join(root, expected))
  })
})

describe("expandPathArgs", () => {
  const expand = (command: string, cwd = "/") => {
    const argv = command.split(" ")
    return expandPathArgs(argv, argv.map((arg) => /[$`*?]/.test(arg)), cwd, home)
  }

  test.each([
    ["rm -rf etc", `rm -rf ${ETC}`],
    ["/bin/rm -rf ./etc/../usr", `/bin/rm -rf ${path.join(ETC, "../usr")}`],
    ["rm -rf *", "rm -rf /*"],
    ["rm -r -- -f", "rm -r -- /-f"],
    ["rmdir --ignore-fail-on-non-empty boot", "rmdir --ignore-fail-on-non-empty /boot"],
    ["shred -n 3 -u -s 1K disk", "shred -n 3 -u -s 1K /disk"],
    ["chmod -R 777 .", "chmod -R 777 /"],
    ["chmod -w etc", `chmod -w ${ETC}`],
    ["chmod --reference=a b", "chmod --reference=a /b"],
    ["chmod --ref a b", "chmod --ref a /b"],
    ["chown -R root:root etc", `chown -R root:root ${ETC}`],
    ["chown --from root:root wheel var", `chown --from root:root wheel ${VAR}`],
    ["chgrp -R wheel var", `chgrp -R wheel ${VAR}`],
    ["mv -t dst a", "mv -t /dst /a"],
    ["cp -f --target-directory=dst a", "cp -f --target-directory=/dst /a"],
    ["mv --targ=dst a", "mv --targ=/dst /a"],
    ["cp -tdst a", "cp -t/dst /a"],
    ["truncate -s 0 log", "truncate -s 0 /log"],
    ["tee -a out", "tee -a /out"],
    ["sudoedit -u root hosts", "sudoedit -u root /hosts"],
    ["dd if=zero of=sda bs=1M", "dd if=/zero of=/sda bs=1M"],
    ["find . -delete", "find / -delete"],
    ["find -L -D tree etc usr -name x", `find -L -D tree ${ETC} /usr -name x`],
    ["ls etc", "ls etc"],
  ])("%s", (input, expected) => {
    expect(expand(input).argv.join(" ")).toBe(expected)
  })

  test("collects the canonical paths", () => {
    expect(expand("mv -t dst a b").paths).toEqual(["/dst", "/a", "/b"])
    expect(expand("dd if=zero of=sda").paths).toEqual(["/zero", "/sda"])
    expect(expand("ls etc").paths).toEqual([])
  })

  test("resolves against the working directory and follows symlinks", () => {
    expect(expand("rm -rf ../link/sub ../oc", path.join(root, "real")).paths).toEqual([
      path.join(root, "real/sub"),
      path.join(home, ".config/opencode"),
    ])
    expect(expand("rm -rf ~/.config", root).paths).toEqual([path.join(home, ".config")])
  })

  test("keeps dynamic arguments", () => {
    expect(expand("rm -rf $DIR/x `pwd` etc")).toMatchObject({ argv: ["rm", "-rf", "$DIR/x", "`pwd`", ETC], paths: [ETC] })
  })

  test("adds the arguments under a symlink to their target", () => {
    const top = path.join(root, "top")
    const links = dirLinks(top)
    const run = (command: string) => {
      const argv = command.split(" ")
      return expandPathArgs(argv, argv.map(() => false), top, home, links)
    }
    expect(run("rm -rf bin/x usr")).toEqual({
      argv: ["rm", "-rf", `${top}/usr/bin/x`, `${top}/usr`],
      paths: [`${top}/usr/bin/x`, `${top}/usr`],
      aliased: ["rm", "-rf", `${top}/bin/x`, `${top}/u`],
    })
    expect(run("dd of=bin/sda").aliased).toEqual(["dd", `of=${top}/bin/sda`])
    expect(run("rm -rf self").aliased).toBeUndefined()
  })
})

describe("dirLinks", () => {
  test("lists the symlinks in a directory, longest target first, without loops or links to /", () => {
    const top = path.join(root, "top")
    expect(dirLinks(top)).toEqual([
      [`${top}/bin`, `${top}/usr/bin`],
      [`${top}/u`, `${top}/usr`],
    ])
  })

  test("is empty for a missing directory", () => {
    expect(dirLinks(path.join(root, "missing"))).toEqual([])
  })
})

describe("linkAlias", () => {
  const links = [
    ["/bin", "/usr/bin"],
    ["/etc", "/private/etc"],
  ] as const

  test.each([
    ["/usr/bin", "/bin"],
    ["/usr/bin/", "/bin/"],
    ["/usr/bin/*", "/bin/*"],
    ["/private/etc/hosts", "/etc/hosts"],
  ])("%s is %s", (input, expected) => {
    expect(linkAlias(input, links)).toBe(expected)
  })

  test.each(["/usr", "/usr/binx", "/etc", "/opt/usr/bin"])("%s has no alias", (input) => {
    expect(linkAlias(input, links)).toBeUndefined()
  })
})
