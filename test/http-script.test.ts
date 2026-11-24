import { describe, expect, test } from "bun:test"
import {
  curlConfigArgs,
  endpointMatcher,
  extractHttp,
  isReadOnlyQuery,
  parseEndpoint,
  parseUrl,
  type HttpExtraction,
  type HttpSources,
} from "../src/http-extractor"
import { scanCode, scanHttp, type Language } from "../src/script-scanner"
import { tokenize } from "../src/tokenizer"

const FILES: Record<string, string> = {
  "boot.json": '{"Boot":{"BootSourceOverrideTarget":"Pxe"}}',
  "post.cfg": '# comment\nurl = "https://bmc/redfish/v1/Systems/1"\nrequest PATCH\n--data-raw "{\\"a\\":1}"\n',
  "loop.cfg": "-K loop.cfg\n",
  "urls.txt": "https://a/x\n\n https://b/y \n",
  "wgetrc": "method = DELETE\nOutput_Document = -\n",
}
const SOURCES: HttpSources = { stdin: "", read: (file) => FILES[file] }

/** Extracts the requests of a command line, with `$` words marked as expanded like the tokenizer does. */
function extract(line: string, sources: HttpSources = SOURCES): HttpExtraction | undefined {
  const command = tokenize(line).commands[0]!
  return extractHttp(command.argv, command.expanded, sources)
}

const methods = (line: string, sources?: HttpSources) => extract(line, sources)?.requests.map((request) => request.method)
const bodies = (line: string, sources?: HttpSources) => extract(line, sources)?.requests.map((request) => request.body)

describe("http extractor", () => {
  test.each<[string, (string | undefined)[] | undefined]>([
    ["curl https://bmc/x", ["GET"]],
    ["curl -X DELETE https://bmc/x", ["DELETE"]],
    ["curl -sXpost https://bmc/x", ["POST"]],
    ["curl --request=PUT https://bmc/x", ["PUT"]],
    ["curl --req PATCH https://bmc/x", ["PATCH"]],
    ["curl -d a=1 https://bmc/x", ["POST"]],
    ["curl -G -d a=1 https://bmc/x", ["GET"]],
    ["curl -I https://bmc/x", ["HEAD"]],
    ["curl -T boot.json https://bmc/x", ["PUT"]],
    ["curl --json {} https://bmc/x", ["POST"]],
    ["curl -F f=@boot.json https://bmc/x", ["POST"]],
    ["curl --expand-request PUT https://bmc/x", ["PUT"]],
    ["curl -I https://bmc/a -: -d x https://bmc/b https://bmc/c", ["HEAD", "POST", "POST"]],
    ['curl -X "$M" https://bmc/x', [undefined]],
    ["curl --expand-request {{m}} https://bmc/x", [undefined]],
    ["curl $OPTS https://bmc/x", [undefined, undefined]],
    ["curl --$OPT https://bmc/x", [undefined]],
    ["curl -X 'P OST' https://bmc/x", [undefined]],
    ["curl $BMC/redfish/v1/Systems", ["GET"]],
    ["curl -- -X https://bmc/x", ["GET", "GET"]],
    ["wget https://bmc/x", ["GET"]],
    ["wget --method=DELETE https://bmc/x", ["DELETE"]],
    ["wget --post-data a=1 https://bmc/x", ["POST"]],
    ["wget -e method=put https://bmc/x", ["PUT"]],
    ["wget --config wgetrc https://bmc/x", ["DELETE"]],
    ['wget -e "$CMD" https://bmc/x', [undefined]],
    ["http bmc/x", ["POST"]],
    ["http -I bmc/x", ["GET"]],
    ["http --ignore-stdin bmc/x a==1 X-H:v", ["GET"]],
    ["http -I bmc/x a=1", ["POST"]],
    ["http -I delete bmc/x", ["DELETE"]],
    ["http -I -P all get bmc/x", ["GET"]],
    ["http -I $M bmc/x", [undefined, undefined]],
    ["https -I --offline put bmc/x", []],
    ["ls -X POST https://bmc/x", undefined],
  ])("%s sends %j", (line, expected) => {
    expect(methods(line)).toEqual(expected)
  })

  test.each<[string, (string | undefined)[]]>([
    ["curl -d a=1 --data-raw @b -d @boot.json https://bmc/x", ['a=1&@b&{"Boot":{"BootSourceOverrideTarget":"Pxe"}}']],
    ["curl -d @missing.json https://bmc/x", [undefined]],
    ['curl -d "$BODY" https://bmc/x', [undefined]],
    ["curl --data-urlencode name@boot.json https://bmc/x", ['{"Boot":{"BootSourceOverrideTarget":"Pxe"}}']],
    ["curl -F 'file=<boot.json;type=application/json' https://bmc/x", ['{"Boot":{"BootSourceOverrideTarget":"Pxe"}}']],
    ["curl -T - https://bmc/x", ["stdin text"]],
    ["curl -d @- https://bmc/x", ["stdin text"]],
    ["http -I bmc/x Boot:=@boot.json", ['Boot={"Boot":{"BootSourceOverrideTarget":"Pxe"}}']],
    ["http bmc/x a=1", ["a=1&stdin text"]],
    ["http -I bmc/x 'a\\=b:c'", [""]],
    ["wget --body-file boot.json --method PATCH https://bmc/x", ['{"Boot":{"BootSourceOverrideTarget":"Pxe"}}']],
  ])("%s sends the body %j", (line, expected) => {
    expect(bodies(line, { ...SOURCES, stdin: "stdin text" })).toEqual(expected)
  })

  test("a body from an unknown stdin or a remote file is unknown", () => {
    expect(bodies("curl -d @- https://bmc/x", {})).toEqual([undefined])
    expect(bodies("curl -d @boot.json https://bmc/x", { stdin: "" })).toEqual([undefined])
  })

  test("curl -K files are expanded in place", () => {
    expect(extract("curl -K post.cfg")?.requests).toEqual([
      {
        urls: ["https://bmc/redfish/v1/Systems/1"],
        method: "PATCH",
        host: "bmc",
        path: "/redfish/v1/Systems/1",
        body: '{"a":1}',
      },
    ])
    expect(curlConfigArgs('silent\n  header: "X-A: \\"b\\"\\t"\n-o out # x\n/ c\n*c\n')).toEqual([
      "--silent",
      "--header",
      'X-A: "b"\t',
      "-o",
      "out",
    ])
  })

  test.each([
    ["curl -K missing.cfg https://bmc/x", "curl 配置文件（-K missing.cfg）无法读取"],
    ["curl -K loop.cfg https://bmc/x", "curl 配置文件（-K loop.cfg）无法读取"],
    ["curl -K $CFG https://bmc/x", "curl 配置文件（-K $CFG）无法读取"],
    ["wget --config=missing https://bmc/x", "wget 配置文件（--config missing）无法读取"],
  ])("%s is opaque", (line, opaque) => {
    expect(extract(line)?.opaque).toBe(opaque)
  })

  test("wget -i reads a URL list, or adds an unknown URL", () => {
    const urls = (line: string) => extract(line)?.requests.map((request) => request.urls[0])
    expect(urls("wget -i urls.txt")).toEqual(["https://a/x", "https://b/y"])
    expect(urls("wget -i missing.txt")).toEqual([""])
  })

  test.each([
    ["curl -o out https://bmc/x", true],
    ["curl -o /dev/null -D - https://bmc/x", false],
    ["curl -O https://bmc/x", true],
    ["curl -so $F https://bmc/x", true],
    ["curl -c jar https://bmc/x", true],
    ["curl -w '%{output}x' https://bmc/x", false],
    ["curl -w '%output{f}x' https://bmc/x", true],
    ["wget https://bmc/x", true],
    ["wget -qO- https://bmc/x", false],
    ["wget --spider https://bmc/x", false],
    ["wget -O - -o log https://bmc/x", true],
    ["wget -e output_document=- https://bmc/x", false],
    ["http -I bmc/x", false],
    ["http -I -d bmc/x", true],
    ["http -I --session=s bmc/x", true],
  ])("%s writes local files: %p", (line, writes) => {
    expect(!!extract(line)?.writes).toBe(writes)
  })

  test("isReadOnlyQuery only accepts known GET / HEAD of Redfish or UFM paths without local writes", () => {
    const readOnly = (line: string) => isReadOnlyQuery(extract(line))
    expect(readOnly("curl -sk https://bmc/redfish/v1/Systems")).toBe(true)
    expect(readOnly("curl -I https://ufm/ufmRestV2/resources/systems")).toBe(true)
    expect(readOnly("curl -sk https://bmc/api")).toBe(false)
    expect(readOnly("curl -X POST https://bmc/redfish/v1/Systems")).toBe(false)
    expect(readOnly("curl -o x https://bmc/redfish/v1/Systems")).toBe(false)
    expect(readOnly("curl -K x.cfg https://bmc/redfish/v1/Systems")).toBe(false)
    expect(readOnly("curl -sk")).toBe(false)
  })
})

describe("http urls", () => {
  test.each<[string, string[], string | undefined, string | undefined]>([
    ["https://BMC./a//b/../c", ["https://BMC./a//b/../c", "https://bmc/a/c"], "bmc", "/a/c"],
    ["bmc:8443/r%65dfish", ["bmc:8443/r%65dfish", "http://bmc:8443/redfish"], "bmc", "/redfish"],
    ["http://167772161/x", ["http://167772161/x", "http://10.0.0.1/x"], "10.0.0.1", "/x"],
    ["http://[::FFFF:10.0.0.1]/x", ["http://[::FFFF:10.0.0.1]/x", "http://[::ffff:a00:1]/x"], "::ffff:a00:1", "/x"],
    ["/redfish/v1/./Systems?x", ["/redfish/v1/./Systems?x", "/redfish/v1/Systems?x"], undefined, "/redfish/v1/Systems"],
    ["http://$(cat h)/x", ["http://$(cat h)/x"], undefined, undefined],
  ])("%s", (raw, urls, host, path) => {
    const parsed = parseUrl(raw)
    expect([parsed.urls, parsed.host, parsed.path]).toEqual([urls, host, path])
  })
})

describe("protected endpoints", () => {
  test.each(["10.0.0.1", "10.0.0.0/8", "fd00::/8", "::ffff:10.0.0.1", "bmc.lab", "BMC-1.Lab.", "0.0.0.0/0"])(
    "accepts %s",
    (entry) => {
      expect(parseEndpoint(entry)).toBeDefined()
    },
  )

  const invalid = ["10.0.0.1:80", "10.0.0.0/33", "fd00::/129", "bmc.lab/24", "a b"]
  test.each([...invalid, "[fd00::1]", "u@bmc", "http://bmc", "1.0.0.0/x"])("rejects %s", (entry) => {
    expect(parseEndpoint(entry)).toBeUndefined()
  })

  test("matches hosts by CIDR, by IPv4-mapped IPv6 and by literal name", () => {
    const matcher = endpointMatcher({ bmcCidrs: ["10.0.0.0/8", "fd00::/8"], ufmHosts: ["ufm.lab"], nicoHosts: [] })!
    const hosts = ["10.1.2.3", "11.0.0.1", "::ffff:a00:1", "fd12::1", "fe80::1", "ufm.lab", "x.ufm.lab", "ufm"]
    expect(hosts.filter(matcher)).toEqual(["10.1.2.3", "::ffff:a00:1", "fd12::1", "ufm.lab"])
    expect(endpointMatcher({ bmcCidrs: [] })).toBeUndefined()
    expect(endpointMatcher(undefined)).toBeUndefined()
  })
})

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

describe("http scanner", () => {
  const scan = (language: Language, code: string) =>
    scanHttp(code, language).map((request) => [request.method, request.urls[0], request.host])

  test.each<[Language, string, (string | undefined)[][]]>([
    ["python", `requests.post("https://bmc/redfish/v1/x", json=b)`, [["POST", "https://bmc/redfish/v1/x", "bmc"]]],
    ["python", `requests.get("https://bmc/redfish/v1/x")`, [["GET", "https://bmc/redfish/v1/x", "bmc"]]],
    ["python", `requests.patch(url, json=b); u = "/redfish/v1/x"`, [[undefined, "/redfish/v1/x", undefined]]],
    ["python", `requests.request("PUT", "https://bmc/x")`, [[undefined, "https://bmc/x", "bmc"]]],
    ["python", `requests.get(f"https://{bmc}/Actions/x")`, [[undefined, "https://${v}/Actions/x", "${v}"]]],
    ["python", `c = http.client.HTTPSConnection("10.0.0.5:443")`, [["GET", "10.0.0.5:443", "10.0.0.5"]]],
    ["python", `ip = "fd00::5"`, [["GET", "fd00::5", "fd00::5"]]],
    ["python", `# requests.post("https://bmc/x")\nprint("a b://c")`, []],
    ["ruby", `Net::HTTP::Post.new(URI("https://bmc/x"))`, [[undefined, "https://bmc/x", "bmc"]]],
    ["perl", `$ua->delete("https://bmc/x")`, [["DELETE", "https://bmc/x", "bmc"]]],
    ["node", `fetch("https://bmc/x", { method: "PATCH" })`, [[undefined, "https://bmc/x", "bmc"]]],
    ["node", "axios.put(`https://${h}/x`, b)", [[undefined, "https://${v}/x", "${v}"]]],
  ])("%s code %s requests %j", (language, code, expected) => {
    expect(scan(language, code)).toEqual(expected)
  })

  test("the body is the whole code", () => {
    const code = `requests.patch("https://bmc/redfish/v1/Systems/1", json={"BootSourceOverrideTarget": "Pxe"})`
    expect(scanHttp(code, "python").map((request) => request.body)).toEqual([code])
  })
})
