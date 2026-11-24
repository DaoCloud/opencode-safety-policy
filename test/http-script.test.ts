import { describe, expect, test } from "bun:test"
import { scanCode, type Language } from "../src/script-scanner"

describe("script scanner", () => {
  test.each<[Language, string, string]>([
    ["python", `import os; os.system("rm -rf /data")`, "rm -rf /data"],
    ["python", `subprocess.run(["rm", "-rf", "/data"], check=True)`, "rm -rf /data"],
    ["python", `os.execv("/bin/rm", ["rm", "-rf", "/data"])`, "/bin/rm rm -rf /data"],
    ["python", `os.system("rm -rf /d\\x61ta")`, "rm -rf /data"],
    ["python", `os.system(r"rm -rf /d\\x61ta")`, "rm -rf /d\\x61ta"],
    ["python", `os.system("""rm -rf /data""")`, "rm -rf /data"],
    ["perl", `system("rm -rf /data")`, "rm -rf /data"],
    ["perl", "system qw(rm -rf /data)", "rm -rf /data"],
    ["perl", "`rm -rf /data`", "rm -rf /data"],
    ["perl", "my $x = qx{rm -rf {a,b}}", "rm -rf {a,b}"],
    ["perl", `my $n = $#a; system("ls")`, "ls"],
    ["ruby", `system("rm", "-rf", "/data")`, "rm -rf /data"],
    ["ruby", "%x(rm -rf /data)", "rm -rf /data"],
    ["ruby", "system(*%w[rm -rf /data])", "rm -rf /data"],
    ["ruby", `Open3.capture2("kubectl delete ns prod")`, "kubectl delete ns prod"],
    ["node", `require("child_process").execSync("rm -rf /data")`, "rm -rf /data"],
    ["node", "const cp = require('child_process'); cp.execFileSync('rm', ['-rf', '/data'])", "rm -rf /data"],
    ["node", "require('child_process').execSync(`rm -rf /data`)", "rm -rf /data"],
  ])("%s code %s calling a process API runs %s", (language, code, command) => {
    expect(scanCode(code, language)).toContain(command)
  })

  test.each<[Language, string, string]>([
    ["python", `shutil.rmtree("/data")`, "rm -rf /data"],
    ["python", "from shutil import rmtree; rmtree('/data')", "rm -rf /data"],
    ["python", `os.remove("/etc/passwd")`, "rm /etc/passwd"],
    ["python", `shutil.rmtree("/my data")`, "rm -rf '/my data'"],
    ["perl", `File::Path::rmtree("/data")`, "rm -rf /data"],
    ["perl", `unlink "/etc/passwd"`, "rm /etc/passwd"],
    ["ruby", `FileUtils.rm_rf("/data")`, "rm -rf /data"],
    ["node", `fs.rmSync("/data", { recursive: true })`, "rm -rf /data"],
    ["node", `require("fs").promises.rm("/data")`, "rm -rf /data"],
    ["node", `fsp.unlink("/etc/passwd")`, "rm /etc/passwd"],
  ])("%s code %s deletes like %s", (language, code, command) => {
    expect(scanCode(code, language)).toEqual([command])
  })

  test.each<[Language, string, string]>([
    ["python", `os.system(f"rm -rf {d} /etc")`, "rm -rf ${v} /etc"],
    ["python", `os.system(f"echo {{x}} {d['k']}")`, "echo {x} ${v}"],
    ["ruby", `system("rm -rf #{dir} /etc")`, "rm -rf ${v} /etc"],
    ["ruby", "%x(rm -rf #{d})", "rm -rf ${v}"],
    ["ruby", "system('rm #{dir}')", "rm #{dir}"],
    ["node", "require('child_process').execSync(`rm -rf ${o.dir} /etc`)", "rm -rf ${v} /etc"],
  ])("%s code %s interpolates a variable: %s", (language, code, command) => {
    expect(scanCode(code, language)).toContain(command)
  })

  test.each<[Language, string]>([
    ["python", `print("rm -rf /data")`],
    ["python", `# os.system("rm -rf /data")\nprint(1)`],
    ["python", "shutil.rmtree(path)"],
    ["perl", "print q(rm -rf /data)"],
    ["ruby", `x = 10 % 3; puts "rm -rf /data"`],
    ["node", `console.log("rm -rf /data")`],
    ["node", `/* fs.rmSync("/data") */ console.log(1)`],
  ])("%s code %s runs nothing", (language, code) => {
    expect(scanCode(code, language)).toEqual([])
  })
})
