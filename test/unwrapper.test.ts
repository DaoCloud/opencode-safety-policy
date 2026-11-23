import { describe, expect, test } from "bun:test"
import { tokenize } from "../src/tokenizer"
import { unwrap, type Atom } from "../src/unwrapper"

const atoms = (input: string) => unwrap(tokenize(input))
const view = (atom: Atom) => ({
  argv: atom.argv,
  isRemote: atom.isRemote,
  targetHost: atom.targetHost,
  wrapperChain: atom.wrapperChain,
})
const only = (input: string) => {
  const result = atoms(input)
  expect(result).toHaveLength(1)
  return view(result[0]!)
}

describe("plain commands", () => {
  test("produce a local atom", () => {
    expect(only("rm -rf /data")).toEqual({ argv: ["rm", "-rf", "/data"], isRemote: false, targetHost: undefined, wrapperChain: [] })
  })

  test("keep the tokenized command for redirects", () => {
    const [atom] = atoms("> /etc/passwd")
    expect(atom?.name).toBe("")
    expect(atom?.command.redirects).toEqual([{ op: ">", target: "/etc/passwd" }])
  })

  test("include commands from substitutions", () => {
    expect(atoms("echo $(sudo rm -rf /)").map((atom) => [atom.name, atom.wrapperChain])).toEqual([
      ["rm", ["sudo"]],
      ["echo", []],
    ])
  })
})

describe("local wrappers", () => {
  test.each([
    ["sudo -u root -E rm -rf /", ["rm", "-rf", "/"], ["sudo"]],
    ["sudo -Eu root -- rm x", ["rm", "x"], ["sudo"]],
    ["sudo --user=root --chdir /tmp rm x", ["rm", "x"], ["sudo"]],
    ["env -i -u HOME -C /tmp rm x", ["rm", "x"], ["env"]],
    ["env --unset=HOME - rm x", ["rm", "x"], ["env"]],
    ["timeout -s KILL 5 rm -rf /", ["rm", "-rf", "/"], ["timeout"]],
    ["timeout --kill-after=1 10s nohup rm x", ["rm", "x"], ["timeout", "nohup"]],
    ["nohup -- rm x", ["rm", "x"], ["nohup"]],
    ["sshpass -p secret -v rm x", ["rm", "x"], ["sshpass"]],
    ["/usr/bin/sudo \\env rm x", ["rm", "x"], ["sudo", "env"]],
  ])("%s", (input, argv, wrapperChain) => {
    expect(only(input)).toMatchObject({ argv, isRemote: false, wrapperChain })
  })

  test("collect environment assignments", () => {
    const [atom] = atoms("A=1 sudo B=2 env C=3 rm x")
    expect(atom?.assignments).toEqual(["A=1", "B=2", "C=3"])
  })

  test("map sudo -e to sudoedit", () => {
    expect(only("sudo -e /etc/hosts").argv).toEqual(["sudoedit", "/etc/hosts"])
  })

  test("split env -S strings", () => {
    expect(only("env -S 'rm -rf' /data")).toMatchObject({ argv: ["rm", "-rf", "/data"], wrapperChain: ["env"] })
  })

  test.each(["sudo -v", "sudo -l", "env", "timeout 5", "nohup", "sshpass -p x"])("%s without a command stays as is", (input) => {
    expect(only(input).wrapperChain).toEqual([])
  })

  test("keeps dynamic inner command names", () => {
    const [atom] = atoms("sudo $CMD -rf /")
    expect(atom?.argv).toEqual(["$CMD", "-rf", "/"])
    expect(atom?.expanded[0]).toBe(true)
  })
})

describe("shell -c", () => {
  test.each([
    ["bash -c 'rm -rf /data'", [["rm", "-rf", "/data"]], ["bash -c"]],
    [`sh -lc "kubectl delete ns a"`, [["kubectl", "delete", "ns", "a"]], ["sh -c"]],
    ["bash -o pipefail -c 'ls | rm y' arg0", [["ls"], ["rm", "y"]], ["bash -c"]],
    ["zsh --rcfile /x -c 'reboot'", [["reboot"]], ["zsh -c"]],
    ["sudo bash -c \"sh -c 'rm a'\"", [["rm", "a"]], ["sudo", "bash -c", "sh -c"]],
    ["bash -c -- 'rm x'", [["rm", "x"]], ["bash -c"]],
    ["dash -c - 'rm x'", [["rm", "x"]], ["dash -c"]],
  ])("%s", (input, argv, wrapperChain) => {
    const result = atoms(input)
    expect(result.map((atom) => atom.argv)).toEqual(argv)
    for (const atom of result) expect(atom.wrapperChain).toEqual(wrapperChain)
  })

  test.each(["bash script.sh", "bash -c", "sh -s", "bash -- -c"])("%s is not unwrapped", (input) => {
    expect(only(input).wrapperChain).toEqual([])
  })
})

describe("ssh", () => {
  test("extracts the remote command and host", () => {
    expect(only(`ssh root@node1 "kubectl delete pod foo"`)).toEqual({
      argv: ["kubectl", "delete", "pod", "foo"],
      isRemote: true,
      targetHost: "node1",
      wrapperChain: ["ssh"],
    })
  })

  test.each([
    "ssh -i key -p 22 -o StrictHostKeyChecking=no -J jump node1 rm -rf /data",
    "ssh -p22 -tt -l root node1 rm -rf /data",
    "ssh node1 -l root -- rm -rf /data",
    "ssh -- node1 rm -rf /data",
    "ssh ssh://admin@node1:2222 rm -rf /data",
  ])("%s", (input) => {
    expect(only(input)).toMatchObject({ argv: ["rm", "-rf", "/data"], isRemote: true, targetHost: "node1" })
  })

  test("joins remote arguments and re-parses them like the remote shell", () => {
    expect(atoms("ssh node1 echo a ';' rm -rf /").map((atom) => atom.argv)).toEqual([["echo", "a"], ["rm", "-rf", "/"]])
  })

  test("unwraps nested quotes and shells", () => {
    expect(only(`ssh node1 "sudo bash -c 'rm -rf /data/*'"`)).toEqual({
      argv: ["rm", "-rf", "/data/*"],
      isRemote: true,
      targetHost: "node1",
      wrapperChain: ["ssh", "sudo", "bash -c"],
    })
  })

  test("follows jump hosts", () => {
    expect(only("ssh jump ssh -p 2 admin@node2 reboot")).toMatchObject({ targetHost: "node2", wrapperChain: ["ssh", "ssh"] })
  })

  test("parses substitutions on the remote side", () => {
    expect(atoms("ssh h 'echo $(reboot)'").map((atom) => [atom.name, atom.isRemote])).toEqual([
      ["reboot", true],
      ["echo", true],
    ])
  })

  test("keeps remote redirects on the remote command", () => {
    const [atom] = atoms("ssh h 'cat > /etc/hosts'")
    expect(atom?.isRemote).toBe(true)
    expect(atom?.command.redirects).toEqual([{ op: ">", target: "/etc/hosts" }])
  })

  test("extracts local ProxyCommand and LocalCommand", () => {
    const result = atoms(`ssh -o ProxyCommand="kubectl delete ns prod" -oLocalCommand=reboot node1 ls`)
    expect(result.map(view)).toEqual([
      { argv: ["kubectl", "delete", "ns", "prod"], isRemote: false, targetHost: undefined, wrapperChain: ["ssh -o ProxyCommand"] },
      { argv: ["reboot"], isRemote: false, targetHost: undefined, wrapperChain: ["ssh -o LocalCommand"] },
      { argv: ["ls"], isRemote: true, targetHost: "node1", wrapperChain: ["ssh"] },
    ])
  })

  test("uses RemoteCommand when no command is given", () => {
    expect(only(`ssh -o "RemoteCommand reboot" node1`)).toMatchObject({ argv: ["reboot"], isRemote: true, targetHost: "node1" })
  })

  test("without a remote command stays local", () => {
    expect(only("ssh -t node1")).toMatchObject({ argv: ["ssh", "-t", "node1"], isRemote: false, wrapperChain: [] })
  })

  test("through sshpass", () => {
    expect(only(`sshpass -p pw ssh -o X=y sw1 "nv config apply"`)).toEqual({
      argv: ["nv", "config", "apply"],
      isRemote: true,
      targetHost: "sw1",
      wrapperChain: ["sshpass", "ssh"],
    })
  })
})

describe("container exec", () => {
  test.each([
    ["kubectl -n prod exec -it api-0 -c app -- rm -rf /data", "api-0", ["kubectl exec"]],
    ["kubectl --kubeconfig /k exec deploy/x --container=c -- rm -rf /data", "deploy/x", ["kubectl exec"]],
    ["kubectl exec api-0 rm -rf /data", "api-0", ["kubectl exec"]],
    ["docker exec -it -u root web rm -rf /data", "web", ["docker exec"]],
    ["docker -H tcp://h:2375 container exec -e A=1 web rm -rf /data", "web", ["docker exec"]],
  ])("%s", (input, targetHost, wrapperChain) => {
    expect(only(input)).toEqual({ argv: ["rm", "-rf", "/data"], isRemote: true, targetHost, wrapperChain })
  })

  test("unwraps shells inside containers", () => {
    expect(only("kubectl exec pod -- sh -c 'rm -rf /x'")).toMatchObject({
      argv: ["rm", "-rf", "/x"],
      wrapperChain: ["kubectl exec", "sh -c"],
    })
  })

  test.each(["kubectl get pods", "kubectl exec pod", "docker ps", "docker exec web"])("%s is not unwrapped", (input) => {
    expect(only(input).wrapperChain).toEqual([])
  })
})

describe("opaque and limits", () => {
  test("reports a top-level opaque script with the commands parsed so far", () => {
    const result = atoms(`rm -rf / ; echo "x`)
    expect(result.map((atom) => [atom.name, atom.opaque])).toEqual([
      ["", "unterminated-quote"],
      ["rm", undefined],
      ["echo", undefined],
    ])
  })

  test("reports an opaque remote script in the remote context", () => {
    const [atom] = atoms(`ssh h 'echo "x'`)
    expect(atom).toMatchObject({ opaque: "unterminated-quote", isRemote: true, targetHost: "h", wrapperChain: ["ssh"] })
  })

  test("allows eight wrapper layers", () => {
    expect(only("sudo ".repeat(8) + "rm x")).toMatchObject({ argv: ["rm", "x"] })
  })

  test("marks a ninth wrapper layer as too deep", () => {
    const [atom] = atoms("sudo ".repeat(9) + "rm x")
    expect(atom).toMatchObject({ name: "sudo", opaque: "too-deep" })
    expect(atom?.wrapperChain).toHaveLength(8)
  })

  const nest = (levels: number, wrap: (inner: string) => string, inner: string) => {
    let input = inner
    for (let i = 0; i < levels; i++) input = wrap(input)
    return input
  }

  test("stops after too many atoms", () => {
    const result = atoms(nest(11, (s) => `ssh h "$(${s})" "$(${s})"`, "rm x"))
    expect(result).toHaveLength(10_001)
    expect(result.at(-1)).toMatchObject({ name: "", opaque: "too-long" })
  })

  test("stops after re-tokenizing too much text", () => {
    const result = atoms(nest(8, (s) => `bash -c "$(${s})"`, "echo " + "a".repeat(50_000)))
    expect(result.length).toBeLessThan(100)
    expect(result.at(-1)).toMatchObject({ opaque: "too-long", wrapperChain: expect.arrayContaining(["bash -c"]) })
  })
})
