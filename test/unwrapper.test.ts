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

  test.each([
    [`"$(go env GOPATH)/bin/sudo" rm x`, ["sudo"]],
    ["$PREFIX/bin/env rm x", ["env"]],
    ["$SUDO rm x", []],
    ["$(echo /usr/bin/sudo) rm x", []],
    ["sud[o] rm x", []],
  ])("unwraps %s only when the basename is literal", (input, chain) => {
    expect(atoms(input).at(-1)?.wrapperChain).toEqual(chain)
  })

  test.each([
    ["nice -n 10 rm x", ["rm", "x"], ["nice"]],
    ["nice -10 rm x", ["rm", "x"], ["nice"]],
    ["command -p -- rm x", ["rm", "x"], ["command"]],
    ["builtin cd /", ["cd", "/"], ["builtin"]],
    ["exec -a name rm x", ["rm", "x"], ["exec"]],
    ["time -f %e rm x", ["rm", "x"], ["time"]],
    ["stdbuf -o L -eL rm x", ["rm", "x"], ["stdbuf"]],
    ["ionice -c 3 rm x", ["rm", "x"], ["ionice"]],
    ["setsid -f rm x", ["rm", "x"], ["setsid"]],
    ["doas -u root rm x", ["rm", "x"], ["doas"]],
    ["su -c 'rm -rf /'", ["rm", "-rf", "/"], ["su -c"]],
    ["su - root -s /bin/sh -c 'rm x'", ["rm", "x"], ["su -c"]],
    ["su root -- -c 'rm x'", ["rm", "x"], ["su -c"]],
    ["runuser -l app --command='rm x'", ["rm", "x"], ["runuser -c"]],
    ["runuser -u app -- rm x", ["rm", "x"], ["runuser"]],
    ["eval 'rm -rf /'", ["rm", "-rf", "/"], ["eval"]],
    ["nice sudo time rm x", ["rm", "x"], ["nice", "sudo", "time"]],
  ])("%s", (input, argv, wrapperChain) => {
    expect(only(input)).toMatchObject({ argv, isRemote: false, wrapperChain })
  })

  test.each(["command -v rm", "command -pV rm", "ionice -p 1", "doas -C /etc/doas.conf", "su", "su root script.sh", "exec", "eval", "xargs -0"])(
    "%s does not unwrap a command",
    (input) => {
      expect(only(input).wrapperChain).toEqual([])
    },
  )
})

describe("xargs", () => {
  test.each([
    ["xargs rm -rf", ["rm", "-rf", "$XARGS_INPUT"], [false, false, true]],
    ["xargs -0 -n1 -P 4 rm", ["rm", "$XARGS_INPUT"], [false, true]],
    ["xargs -eif rm -rf", ["rm", "-rf", "$XARGS_INPUT"], [false, false, true]],
    ["xargs -I {} rm {}/x", ["rm", "$XARGS_INPUT/x"], [false, true]],
    ["xargs -i rm {}", ["rm", "$XARGS_INPUT"], [false, true]],
    ["xargs -0i@ rm @", ["rm", "$XARGS_INPUT"], [false, true]],
    ["xargs --replace=@ rm -- @", ["rm", "--", "$XARGS_INPUT"], [false, false, true]],
  ])("%s", (input, argv, expanded) => {
    const [atom] = atoms(input)
    expect(atom).toMatchObject({ argv, expanded, wrapperChain: ["xargs"] })
  })

  test("applies to the right side of a pipe", () => {
    expect(atoms("find / -name x | xargs rm -rf").map((atom) => atom.argv)).toEqual([
      ["find", "/", "-name", "x"],
      ["rm", "-rf", "$XARGS_INPUT"],
    ])
  })
})

describe("stdin", () => {
  const stdin = (input: string) => atoms(input).map((atom) => [atom.name, atom.stdin])

  test.each([
    ["psql <<SQL\nDROP TABLE x\nSQL", [["psql", "DROP TABLE x\n"]]],
    ["psql <<-'SQL'\n\tDROP TABLE x\n\tSQL", [["psql", "DROP TABLE x\n"]]],
    ["mysql <<<'drop database x'", [["mysql", "drop database x"]]],
    ["psql < dump.sql", [["psql", undefined]]],
    ["psql <<<x < dump.sql", [["psql", undefined]]],
    ["psql 2<<<x", [["psql", undefined]]],
  ])("%s", (input, expected) => {
    expect(stdin(input)).toEqual(expected)
  })

  test("flows through wrappers and remote shells", () => {
    expect(stdin("sudo -u postgres psql <<<'drop table x'")).toEqual([["psql", "drop table x"]])
    expect(atoms("ssh db psql <<<'drop table x'")[0]).toMatchObject({ name: "psql", isRemote: true, stdin: "drop table x" })
  })

  test("is replaced by a pipe inside a script", () => {
    expect(stdin("bash -c 'cat | psql' <<<x")).toEqual([
      ["cat", "x"],
      ["psql", undefined],
    ])
  })

  test("is not shared between separate commands", () => {
    expect(stdin("psql <<<x; psql")).toEqual([
      ["psql", "x"],
      ["psql", undefined],
    ])
  })

  test.each([
    ["bash <<EOF\nrm -rf /\nEOF", ["bash -s"], false],
    ["sh -s arg <<<'rm x'", ["sh -s"], false],
    ["bash - <<<'rm x'", ["bash -s"], false],
    ["bash /dev/stdin <<<'rm x'", ["bash -s"], false],
    ["su root <<<'rm x'", ["su -s"], false],
    ["sudo -u root -i <<<'rm x'", ["sudo -s"], false],
    ["ssh -T h <<'EOF'\nrm x\nEOF", ["ssh"], true],
    ["ssh h bash <<<'rm x'", ["ssh", "bash -s"], true],
    ["kubectl exec -i p -- sh <<<'rm x'", ["kubectl exec", "sh -s"], true],
  ])("%s runs stdin as a script", (input, wrapperChain, isRemote) => {
    const [atom] = atoms(input)
    expect(atom).toMatchObject({ name: "rm", isRemote, wrapperChain })
    expect(atom?.stdin).toBeUndefined()
  })

  test.each(["bash script.sh <<<'rm x'", "ssh h <hosts.txt", "bash"])("%s does not run stdin", (input) => {
    expect(only(input).wrapperChain).toEqual([])
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

describe("chdir", () => {
  test.each([
    ["env -C / rm x", ["/"]],
    ["sudo -D /tmp env --chdir=.. rm x", ["/tmp", ".."]],
    ["sudo -iu root rm x", [null]],
    ["sudo -i <<<'rm x'", [null]],
    ["su - -c 'rm x'", [null]],
    ["su -lc 'rm x'", [null]],
    ["runuser -l app -c 'rm x'", [null]],
  ])("%s", (input, chdir) => {
    expect(atoms(input)[0]?.chdir).toEqual(chdir)
  })

  test("other wrappers keep the directory", () => {
    expect(atoms("su root -c 'rm x'")[0]?.chdir).toBeUndefined()
    expect(atoms("sudo -u root rm x")[0]?.chdir).toBeUndefined()
  })
})
