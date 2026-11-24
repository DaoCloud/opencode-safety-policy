import { describe, expect, test } from "bun:test"
import { tokenize } from "../src/tokenizer"
import { newWalk, unwrap, unwrapScriptFile, type Atom, type ScriptFile } from "../src/unwrapper"

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
const marker = (input: string) => {
  const result = atoms(input).filter((atom) => atom.scriptFile)
  expect(result).toHaveLength(1)
  const atom = result[0]!
  return { scriptFile: atom.scriptFile, chdir: atom.chdir, ...view(atom) }
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

  test.each(["constructor x", "toString", "valueOf x", "__proto__ x"])("%s is not looked up on the prototype", (input) => {
    expect(only(input).wrapperChain).toEqual([])
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

  test.each([
    "command -v rm",
    "command -pV rm",
    "ionice -p 1",
    "doas -C /etc/doas.conf",
    "su",
    "exec",
    "eval",
    "xargs -0",
  ])(
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
    ["xargs -ia rm -rf a", ["rm", "-rf", "$XARGS_INPUT"], [false, false, true]],
    ["xargs --rep=@ --max-a 1 rm @", ["rm", "$XARGS_INPUT"], [false, true]],
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
    ["mysql <<<'drop database x'", [["mysql", "drop database x\n"]]],
    ["psql < dump.sql", [["psql", undefined]]],
    ["psql <<<x < dump.sql", [["psql", undefined]]],
    ["psql 2<<<x", [["psql", undefined]]],
  ])("%s", (input, expected) => {
    expect(stdin(input)).toEqual(expected)
  })

  test("flows through wrappers and remote shells", () => {
    expect(stdin("sudo -u postgres psql <<<'drop table x'")).toEqual([["psql", "drop table x\n"]])
    expect(atoms("ssh db psql <<<'drop table x'")[0]).toMatchObject({ name: "psql", isRemote: true, stdin: "drop table x\n" })
  })

  test("is replaced by a pipe inside a script", () => {
    expect(stdin("bash -c 'cat | psql' <<<x")).toEqual([
      ["cat", "x\n"],
      ["psql", undefined],
    ])
  })

  test("is not shared between separate commands", () => {
    expect(stdin("psql <<<x; psql")).toEqual([
      ["psql", "x\n"],
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
    ["{ cat; bash; } <<<'rm x'", ["bash -s"], false],
    ["{ cat; bash; } <<'EOF'\nrm x\nEOF", ["bash -s"], false],
    ["(bash) <<<'rm x'", ["bash -s"], false],
    ["if true; then bash; fi <<<'rm x'", ["bash -s"], false],
    ["while true; do bash; done <<<'rm x'", ["bash -s"], false],
    ["{ for i in a; { bash; }; } <<<'rm x'", ["bash -s"], false],
    ["{ echo $(bash); } <<<'rm x'", ["bash -s"], false],
    ["{ cat <(bash); } <<<'rm x'", ["bash -s"], false],
    ["time { bash; } <<<'rm x'", ["bash -s"], false],
    ["coproc bash <<<'rm x'", ["bash -s"], false],
  ])("%s runs stdin as a script", (input, wrapperChain, isRemote) => {
    const atom = atoms(input).find((atom) => atom.name === "rm")
    expect(atom).toMatchObject({ name: "rm", isRemote, wrapperChain })
    expect(atom?.stdin).toBeUndefined()
  })

  test("bash does not run stdin", () => {
    expect(only("bash").wrapperChain).toEqual([])
  })

  test("a script argument does not run stdin", () => {
    expect(atoms("bash script.sh <<<'rm x'").find((atom) => atom.name === "rm")).toBeUndefined()
  })
})

describe("script files on stdin", () => {
  test.each([
    ["bash < x.sh", ["bash -s"], false],
    ["sh -s a <x.sh", ["sh -s"], false],
    ["bash /dev/stdin < x.sh", ["bash -s"], false],
    ["sudo bash < x.sh", ["sudo", "bash -s"], false],
    ["sudo -s < x.sh", ["sudo -s"], false],
    ["su root < x.sh", ["su -s"], false],
    ["bash -c bash < x.sh", ["bash -c", "bash -s"], false],
    ["source /dev/stdin < x.sh", ["source"], false],
    ["{ cat; bash; } < x.sh", ["bash -s"], false],
    ["(bash) < x.sh", ["bash -s"], false],
    ["exec < x.sh; bash", ["bash -s"], false],
    ["command exec < x.sh; bash", ["bash -s"], false],
    ["exec -a n -- < x.sh; bash", ["bash -s"], false],
    ["time exec < x.sh; bash", ["bash -s"], false],
    ["eval 'exec < x.sh'; bash", ["bash -s"], false],
    [". /dev/stdin <<'EOF'\nexec < x.sh\nEOF\nbash", ["bash -s"], false],
    ["true | exec < x.sh; bash", ["bash -s"], false],
    ["bash <&3 < x.sh", ["bash -s"], false],
    ["bash <<<'rm y' < x.sh", ["bash -s"], false],
    ["ssh h < x.sh", ["ssh"], true],
    ["ssh h 'bash -s' < x.sh", ["ssh", "bash -s"], true],
    ["ssh h 'cat; sudo sh' < x.sh", ["ssh", "sudo", "sh -s"], true],
    ["kubectl exec -i p -- sh < x.sh", ["kubectl exec", "sh -s"], true],
    ["pdsh -w n1 < x.sh", ["pdsh"], true],
  ])("%s runs the local file as a script", (input, wrapperChain, isRemote) => {
    expect(marker(input)).toMatchObject({ scriptFile: { path: "x.sh" }, wrapperChain, isRemote })
  })

  test("the file is opened where the redirect is, the script runs where the wrapper changes to", () => {
    expect(marker("sudo -D /a bash < x.sh")).toMatchObject({ scriptFile: { path: "x.sh" }, chdir: ["/a"] })
    expect(marker("env -C /a bash -c 'sudo -D /b bash < x.sh'")).toMatchObject({
      scriptFile: { path: "x.sh", chdir: ["/a"] },
      chdir: ["/a", "/b"],
    })
  })

  test.each([
    "bash < /dev/null",
    "bash < /dev//null",
    "ssh h < /dev/null",
    "bash < x.sh < /dev/null",
    "bash < x.sh <<<''",
    "exec < /dev/null; bash",
  ])("%s runs an empty script", (input) => {
    expect(atoms(input).filter((atom) => atom.name === "bash" || atom.wrapperChain.length)).toEqual([])
  })

  test.each([
    ["ssh h 'bash < x.sh'", "bash"],
    ["ssh h 'exec < x.sh; bash'", "bash"],
    ["psql < dump.sql", "psql"],
  ])("%s does not read a local script", (input, name) => {
    const result = atoms(input)
    expect(result.filter((atom) => atom.scriptFile || atom.opaque)).toEqual([])
    expect(result.find((atom) => atom.name === name)).toBeDefined()
  })

  test.each(["bash < x.sh <&3", "parallel < jobs.txt", "bash < /dev/fd/3"])("%s is opaque", (input) => {
    expect(atoms(input).find((atom) => atom.opaque)).toMatchObject({ opaque: "piped-script" })
  })

  test("unwrapScriptFile walks the content in the context of the marker and shares the budgets", () => {
    const walk = newWalk()
    const [file] = unwrap(tokenize("ssh h 'sudo bash' < x.sh"), walk)
    const content = unwrapScriptFile("rm x; bash < y.sh", file!, walk)
    expect(content.map(view)).toEqual([
      { argv: ["rm", "x"], isRemote: true, targetHost: "h", wrapperChain: ["ssh", "sudo", "bash -s"] },
      { argv: ["bash"], isRemote: true, targetHost: "h", wrapperChain: ["ssh", "sudo", "bash -s"] },
    ])
    expect(walk.atoms).toHaveLength(3)
    walk.chars = 3
    expect(unwrapScriptFile("rm x", file!, walk)).toMatchObject([{ opaque: "too-long" }])
    expect(unwrapScriptFile("rm x", file!, walk)).toEqual([])
  })
})

describe("script arguments and interpreter code", () => {
  test.each<[string, ScriptFile, string[]]>([
    ["bash x.sh", { path: "x.sh", argument: true }, ["bash"]],
    ["sh -e x.sh a", { path: "x.sh", argument: true }, ["sh"]],
    ["bash -- -c", { path: "-c", argument: true }, ["bash"]],
    ["su root x.sh", { path: "x.sh", argument: true }, ["su"]],
    ["bash x.sh < y.sh", { path: "x.sh", argument: true, piped: { path: "y.sh" } }, ["bash"]],
    ["python3 < x.py", { path: "x.py", language: "python" }, ["python3"]],
    ["sudo python3 x.py", { path: "x.py", argument: true, language: "python" }, ["sudo", "python3"]],
    ["/usr/bin/python3.11 x.py", { path: "x.py", argument: true, language: "python" }, ["python3.11"]],
    ["perl -w x.pl", { path: "x.pl", argument: true, language: "perl" }, ["perl"]],
    ["ruby x.rb", { path: "x.rb", argument: true, language: "ruby" }, ["ruby"]],
    ["node x", { path: "x", argument: true, language: "node" }, ["node"]],
  ])("%s runs a local script", (input, scriptFile, wrapperChain) => {
    const atom = marker(input)
    expect(atom.scriptFile).toEqual(scriptFile)
    expect(atom).toMatchObject({ wrapperChain, isRemote: false })
  })

  test("the argument script is opened in the directory the wrapper changes to", () => {
    expect(marker("sudo -D /a python3 x.py")).toMatchObject({
      scriptFile: { path: "x.py", chdir: ["/a"] },
      chdir: ["/a"],
    })
  })

  test.each([
    "ssh h bash x.sh",
    "bash -s x.sh",
    "python3 -m pip install x.py",
    "python3 -V x.py",
    "python3 -",
    "source x.sh",
    "./run.sh",
  ])("%s does not read a local script", (input) => {
    expect(atoms(input).filter((atom) => atom.scriptFile || atom.opaque)).toEqual([])
  })

  test.each([
    [`python3 -c 'import os; os.system("rm -rf /x")'`, ["rm", "-rf", "/x"], ["python3 -c"], false],
    [`python3 -c 'import shutil; shutil.rmtree("/x")'`, ["rm", "-rf", "/x"], ["python3 -c"], false],
    ["perl -e 'system(qq{rm x})'", ["rm", "x"], ["perl -e"], false],
    [`ruby -e 'system("rm x")'`, ["rm", "x"], ["ruby -e"], false],
    [`node -e 'require("fs").rmSync("/x", {recursive: true})'`, ["rm", "-rf", "/x"], ["node -e"], false],
    [`echo 'import os; os.system("rm x")' | python3 -`, ["rm", "x"], ["python3"], false],
    ["python3 <<'EOF'\nimport os\nos.system('rm x')\nEOF", ["rm", "x"], ["python3"], false],
    [
      `bash -c 'python3 -c "import shutil; shutil.rmtree(\\"/x\\")"'`,
      ["rm", "-rf", "/x"],
      ["bash -c", "python3 -c"],
      false,
    ],
    [`ssh h "python3 -c 'import os; os.system(\\"rm x\\")'"`, ["rm", "x"], ["ssh", "python3 -c"], true],
  ])("%s prescans the code", (input, argv, wrapperChain, isRemote) => {
    expect(atoms(input).find((atom) => atom.prescan)).toMatchObject({ argv, wrapperChain, isRemote, prescan: true })
  })

  test.each([
    "python3 -c 'print(1)'",
    `python3 -c 'import os' -c 'os.system("rm x")'`,
    `python3 -V -c 'import os; os.system("rm x")'`,
  ])("%s yields no prescanned command", (input) => {
    expect(atoms(input).filter((atom) => atom.prescan)).toEqual([])
  })
})

describe("static pipe input", () => {
  const stdin = (input: string) => atoms(input).find((atom) => atom.name === "psql")?.stdin

  test.each([
    ["echo a  b | psql", "a b\n"],
    ["echo 'a  b' | psql", "a  b\n"],
    ["echo | psql", "\n"],
    ["echo -n a | psql", "a"],
    ["echo -neE a | psql", "a"],
    ["X=1 echo a | psql", "a\n"],
    ["echo $'a\\tb' | psql", "a\tb\n"],
    ["printf 'a\\tb\\\\' | psql", "a\tb\\"],
    ["printf '%s|' a b | psql", "a|b|"],
    ["printf '%s-%s|' 1 | psql", "1-|"],
    ["printf '%s\\n' 'a\\n' | psql", "a\\n\n"],
    ["printf '100%%' | psql", "100%"],
    ["echo a | { psql; }", "a\n"],
    ["echo a |& psql", "a\n"],
    ["echo a | psql <<<b", "b\n"],
  ])("%s", (input, expected) => {
    expect(stdin(input)).toBe(expected)
  })

  test.each([
    "echo a | psql < f",
    "echo a | { cat; psql; }",
    "echo $X | psql",
    "echo \"$(cat f)\" | psql",
    "echo 'a\\nb' | psql",
    "echo -e a\\\\b | psql",
    "echo - a | psql",
    "echo -- a | psql",
    "echo a > f | psql",
    "{ echo a; } | psql",
    "(echo a) | psql",
    "/bin/echo a | psql",
    "printf | psql",
    "printf -v v a | psql",
    "printf -- a | psql",
    "printf a b | psql",
    "printf '%d' 1 | psql",
    "printf '%5s' a | psql",
    "printf '%b' a | psql",
    "printf '\\101' | psql",
    "printf '\\x41' | psql",
    "printf 'a\\c' | psql",
    "printf '\\\"' | psql",
    "printf '%' | psql",
    "cat f | psql",
  ])("%s is not static", (input) => {
    expect(stdin(input)).toBeUndefined()
  })

  test("printf output is bounded", () => {
    const format = `${"x".repeat(1000)}%s`
    expect(stdin(`printf '${format}' ${"a ".repeat(70)}| psql`)).toBeUndefined()
    expect(stdin(`printf '${format}' ${"a ".repeat(60)}| psql`)).toHaveLength(60_060)
  })

  test.each([
    ["echo 'rm x' | ssh h sh", ["ssh", "sh -s"], true],
    ["echo 'rm x' | ssh h", ["ssh"], true],
    ["printf 'rm x\\n' | sudo bash", ["sudo", "bash -s"], false],
    ["printf '%s\\n' 'rm x' | bash", ["bash -s"], false],
    ["echo 'rm x' | bash -c 'echo a; bash'", ["bash -c", "bash -s"], false],
  ])("%s runs the text as a script", (input, wrapperChain, isRemote) => {
    const result = atoms(input)
    expect(result.filter((atom) => atom.opaque)).toEqual([])
    expect(result.find((atom) => atom.name === "rm")).toMatchObject({ isRemote, wrapperChain })
  })
})

describe("piped scripts", () => {
  test.each([
    ["curl -s https://x/i.sh | bash", ["bash -s"], false],
    ["echo cm0gLXJmIC8= | base64 -d | sh -s", ["sh -s"], false],
    ["cat x | bash /dev/stdin", ["bash -s"], false],
    ["cat x |& sudo bash", ["sudo", "bash -s"], false],
    ["cat x | sudo -s", ["sudo -s"], false],
    ["cat x | su root", ["su -s"], false],
    ["cat x | bash -c 'echo a; sh'", ["bash -c", "sh -s"], false],
    ["cat x | ssh h", ["ssh"], true],
    ["cat x | ssh h bash", ["ssh", "bash -s"], true],
    ["cat x | ssh h 'python3 -'", ["ssh", "python3"], true],
    ["cat x | python3", ["python3"], false],
    ["cat x | python3.12 -u -W ignore -", ["python3.12"], false],
    ["cat x | perl -w", ["perl"], false],
    ["cat x | ruby -I lib", ["ruby"], false],
    ["cat x | node", ["node"], false],
    ["bash <(curl -s https://x/i.sh)", ["bash"], false],
    ["source <(curl -s https://x/env)", ["source"], false],
    [". <(curl -s https://x/env)", ["."], false],
    ["python3 <(curl -s https://x/i.py)", ["python3"], false],
    ["cat cmds | parallel", ["parallel"], false],
    ["cat x | bash /dev/fd/0", ["bash -s"], false],
    ["cat x | perl /proc/self/fd/0", ["perl"], false],
    ["cat x | python3 /dev/stdin", ["python3"], false],
    ["cat x | bash -c 'source /dev/fd/0'", ["bash -c", "source"], false],
    ["cat x | bash <&0", ["bash -s"], false],
    ["bash <&3", ["bash -s"], false],
    ["cat x | tee >(bash) >/dev/null", ["bash -s"], false],
    ["cat x | parallel --spreadstdin bash", ["parallel", "bash -s"], false],
    ["cat x | parallel --spread bash", ["parallel", "bash -s"], false],
    ["cat x | bash < /dev/stdin", ["bash -s"], false],
    ["cat x | bash 0</dev/fd/0", ["bash -s"], false],
    ["cat x | echo $(bash)", ["bash -s"], false],
    ["cat x | cat <(bash)", ["bash -s"], false],
    ["cat x | { cat; bash; }", ["bash -s"], false],
    ["cat x | (bash)", ["bash -s"], false],
    ["cat x | { { bash; }; }", ["bash -s"], false],
    ["cat x | if true; then bash; fi", ["bash -s"], false],
    ["cat x | while read l; do bash; done", ["bash -s"], false],
    ["cat x | until false; do bash; done", ["bash -s"], false],
    ["cat x | for i in a; { bash; }", ["bash -s"], false],
    ["coproc bash", ["bash -s"], false],
    ["time coproc bash", ["bash -s"], false],
    ["{ cat x | bash; } < /dev/null", ["bash -s"], false],
    ["{ cat x | bash; } <<<'rm x'", ["bash -s"], false],
    ["while read u; do cat $u | sh; done < urls", ["sh -s"], false],
    ["{ cat x | echo $(bash); } < /dev/null", ["bash -s"], false],
    ["a | { cat x | { bash; }; } < /dev/null", ["bash -s"], false],
    ["cat x | { cat; } <<< $(bash)", ["bash -s"], false],
    ["cat x | while false; do :; done > `bash`", ["bash -s"], false],
    ["cat x | { cat; } <<EOF\n$(bash)\nEOF", ["bash -s"], false],
  ])("%s is opaque", (input, wrapperChain, isRemote) => {
    const atom = atoms(input).find((atom) => atom.opaque)
    expect(atom).toMatchObject({ opaque: "piped-script", isRemote, wrapperChain })
  })

  test.each([
    "cat x | bash script.sh",
    "cat x | bash -c 'rm y'",
    "cat x | grep y | sh <<<'ls'",
    "cat x | xargs sh",
    "echo '{}' | python3 -m json.tool",
    "cat x | python3 -c 'print(1)'",
    "cat x | python3 x.py",
    "cat x | python3 --version",
    "cat x | perl -ne 'print'",
    "cat x | perl -lane 'print'",
    "cat x | perl -MO=Deparse x.pl",
    "cat x | ruby -e 1",
    "cat x | node -e 1",
    "cat x | node app.js",
    "bash < x.sh",
    "source ./env.sh",
    "cat x | grep y; bash",
    "bash <&0",
    "cat x | bash <&-",
    "ls | tee >(grep x)",
    "cat x | grep $(whoami)",
    "cat x | { cat; }; bash",
    "cat x | { bash; } < f",
    "cat x | (cd /tmp && tar xz)",
    "(echo a; echo b) | sort",
    "git log | while read c; do echo $c; done",
    "for f in *; do echo $f; done; bash",
    "cat x | { { bash; } < /dev/null; }",
    "cat x | (bash) < f",
    "cat x | { :; } <<< $(echo a)",
    "coproc cat <<< a",
  ])("%s is not opaque", (input) => {
    expect(atoms(input).filter((atom) => atom.opaque)).toEqual([])
  })
})

describe("find -exec", () => {
  test("keeps find and unwraps every -exec action", () => {
    const result = atoms("find . -name '*.o' -exec rm -f {} + -ok sh -c 'rm -rf /etc' \\; -delete")
    expect(result.map(view)).toEqual([
      { argv: ["find", ".", "-name", "*.o", "-exec", "rm", "-f", "{}", "+", "-ok", "sh", "-c", "rm -rf /etc", ";", "-delete"], isRemote: false, targetHost: undefined, wrapperChain: [] },
      { argv: ["rm", "-f", "$FIND_PATH"], isRemote: false, targetHost: undefined, wrapperChain: ["find -exec"] },
      { argv: ["rm", "-rf", "/etc"], isRemote: false, targetHost: undefined, wrapperChain: ["find -ok", "sh -c"] },
    ])
    expect(result[1]?.expanded).toEqual([false, false, true])
  })

  test("runs -execdir in the directory of each file", () => {
    const [, atom] = atoms("find / -execdir mv {} {}.bak \\;")
    expect(atom).toMatchObject({ argv: ["mv", "$FIND_PATH", "$FIND_PATH.bak"], expanded: [false, true, true], chdir: [null] })
  })

  test.each(["find . -name x", "find . -exec", "find . -exec ;"])("%s has no inner command", (input) => {
    expect(only(input).wrapperChain).toEqual([])
  })
})

describe("remote fan-out", () => {
  test.each([
    ["ansible all -m shell -a 'rm -rf /data'", "all", ["ansible -m shell"]],
    ["ansible web -i hosts -b -f 5 -m ansible.builtin.command -a 'rm -rf /data'", "web", ["ansible -m ansible.builtin.command"]],
    ["ansible all -a 'rm -rf /data'", "all", ["ansible -m command"]],
    ["ansible -m raw --args='rm -rf /data' db", "db", ["ansible -m raw"]],
    ["pdsh -w n[1-3] -l root rm -rf /data", "n[1-3]", ["pdsh"]],
    ["pdsh -R ssh -w n1 'rm -rf /data'", "n1", ["pdsh"]],
    ["pssh -H n1 -l root -i 'rm -rf /data'", "n1", ["pssh"]],
    ["parallel-ssh -h hosts.txt -t 0 rm -rf /data", "*", ["parallel-ssh"]],
    ["clush -w n[1-3] -b 'rm -rf /data'", "n[1-3]", ["clush"]],
    ["clush -g gpu rm -rf /data", "@gpu", ["clush"]],
    ["clush -m sudo -O fanout=32 -E 'h' -w n1 rm -rf /data", "n1", ["clush"]],
    ["pdsh -P gpu -j 1234 -F genders -I 5 -T 1 rm -rf /data", "*", ["pdsh"]],
    [`ansible all -m shell -a '{"cmd": "rm -rf /data"}'`, "all", ["ansible -m shell"]],
    [`ansible all -a '{"argv": ["rm", "-rf", "/data"]}'`, "all", ["ansible -m command"]],
    [`ansible all -a 'rm -rf /data creates=/x'`, "all", ["ansible -m command"]],
    [`ansible all -m shell -a 'echo\\x20a;rm\\x20-rf\\x20/data\\x20#\\='`, "all", ["ansible -m shell"]],
    ["ansible all --module-n shell --arg 'rm -rf /data'", "all", ["ansible -m shell"]],
    ["clush --mod sudo -w n1 rm -rf /data", "n1", ["clush"]],
    ["pssh --us root -H n1 rm -rf /data", "n1", ["pssh"]],
  ])("%s", (input, targetHost, wrapperChain) => {
    expect(atoms(input).map(view)).toContainEqual({ argv: ["rm", "-rf", "/data"], isRemote: true, targetHost, wrapperChain })
  })

  test("ansible runs the command in chdir with stdin", () => {
    expect(atoms(`ansible all -a '{"_raw_params": "rm -rf data", "chdir": "/"}'`)[0]?.chdir).toEqual(["/"])
    expect(atoms(`ansible all -a 'rm -rf data chdir="/srv"'`)[0]).toMatchObject({ argv: ["rm", "-rf", "data"], chdir: ["/srv"] })
    for (const input of [
      `ansible all -m shell -a '{"cmd": "bash", "stdin": "rm -rf /data"}'`,
      `ansible all -m shell -a 'bash stdin=rm\\x20-rf\\x20/data'`,
    ]) {
      expect(atoms(input).at(-1)).toMatchObject({
        argv: ["rm", "-rf", "/data"],
        wrapperChain: ["ansible -m shell", "sh -c", "bash -s"],
      })
    }
  })

  test.each([
    "ansible all -m shell -a '{{ cmd }} /data'",
    "ansible all -a 'rm -rf /e{# x #}tc'",
    `ansible all -a '{"cmd": "rm", "x": NaN}'`,
    `ansible all -a '{"cmd": {"__ansible_unsafe": "rm -rf /data"}}'`,
    `ansible all -a '{"cmd": "\\u007b{ x }}"}'`,
    "ansible all -m shell -a 'import os executable=/usr/bin/python3'",
    "ansible all -a 'rm -rf \\N{SOLIDUS}data'",
    `ansible all -a 'rm "x'`,
  ])("%s is opaque", (input) => {
    const result = atoms(input)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ opaque: "dynamic-args", isRemote: true, targetHost: "all" })
  })

  test.each([
    ["pdsh -w n1 <<'EOF'\nrm x\nEOF", ["pdsh"]],
    ["clush -w n1 <<<'rm x'", ["clush"]],
  ])("%s runs stdin as a script", (input, wrapperChain) => {
    expect(only(input)).toMatchObject({ argv: ["rm", "x"], isRemote: true, wrapperChain })
  })

  test.each([
    "ansible all -m ping",
    "ansible all -m file -a 'path=/x state=absent'",
    `ansible all -a '{"chdir": "/"}'`,
    "clush -w n1 -c /etc/hosts",
    "clush -w n1 --rcopy /x",
    "pdsh -w n1",
    "pssh -H n1",
  ])("%s is not unwrapped", (input) => {
    expect(only(input).wrapperChain).toEqual([])
  })
})

describe("more local wrappers", () => {
  test.each([
    ["chroot /mnt rm x", ["chroot"]],
    ["chroot --userspec=1:1 /mnt rm x", ["chroot"]],
    ["flock /tmp/l rm x", ["flock"]],
    ["flock -w 5 -E 1 -n /tmp/l rm x", ["flock"]],
    ["flock -s /tmp/l -c 'rm x'", ["flock -c"]],
    ["flock /tmp/l --command 'rm x'", ["flock -c"]],
    ["watch -n 1 rm x", ["watch"]],
    ["watch -d -n1 -- 'rm x'", ["watch"]],
    ["watch -x rm x", ["watch"]],
  ])("%s", (input, wrapperChain) => {
    expect(only(input)).toMatchObject({ argv: ["rm", "x"], isRemote: false, wrapperChain })
  })

  test("chroot runs in the new root unless told to skip", () => {
    expect(atoms("chroot /mnt rm x")[0]?.chdir).toEqual(["/"])
    expect(atoms("chroot --skip-chdir /mnt rm x")[0]?.chdir).toBeUndefined()
  })

  test("chroot without a command runs a shell on stdin", () => {
    expect(only("chroot /mnt <<<'rm x'")).toMatchObject({ argv: ["rm", "x"], wrapperChain: ["chroot -s"] })
  })

  test("watch runs its arguments through sh -c unless -x is given", () => {
    expect(atoms("watch echo 'a; rm x'").map((atom) => atom.argv)).toEqual([["echo", "a"], ["rm", "x"]])
    expect(only("watch -x echo 'a; rm x'").argv).toEqual(["echo", "a; rm x"])
  })

  test.each(["flock 9", "flock /tmp/l", "chroot /mnt", "watch", "watch -n 1"])("%s is not unwrapped", (input) => {
    expect(only(input).wrapperChain).toEqual([])
  })
})

describe("long option abbreviations", () => {
  test.each([
    ["sudo --chd / --us root rm x", ["sudo"]],
    ["env --uns=HOME --spl 'rm x'", ["env"]],
    ["timeout --sig KILL --k 1 5 rm x", ["timeout"]],
    ["nice --adj 5 rm x", ["nice"]],
    ["time --out f rm x", ["time"]],
    ["stdbuf --out L rm x", ["stdbuf"]],
    ["ionice --cl 3 rm x", ["ionice"]],
    ["su --comm 'rm x'", ["su -c"]],
    ["runuser --us app -- rm x", ["runuser"]],
    ["chroot --user=1:1 /mnt rm x", ["chroot"]],
    ["flock --wai 5 /tmp/l rm x", ["flock"]],
    ["watch --int 1 rm x", ["watch"]],
    // An optional value is only taken when attached, so `n` is the value of -d.
    ["watch -dn rm x", ["watch"]],
  ])("%s", (input, wrapperChain) => {
    expect(only(input)).toMatchObject({ argv: ["rm", "x"], isRemote: false, wrapperChain })
  })

  test("flock matches -c after the lock file exactly", () => {
    expect(only("flock /tmp/l --comm 'rm x'").argv).toEqual(["--comm", "rm x"])
  })
})

describe("parallel", () => {
  const argvs = (input: string) => atoms(input).map((atom) => atom.argv)

  test.each([
    ["parallel rm -rf ::: /etc /tmp", [["rm", "-rf", "/etc"], ["rm", "-rf", "/tmp"]]],
    ["parallel -j4 'rm -rf {}' ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel --jobs 2 rm {.}.bak {/} {//} {/.} ::: /a/b.txt", [["rm", "/a/b.bak", "b.txt", "/a", "b"]]],
    ["parallel -I @ rm @/x ::: a", [["rm", "a/x"]]],
    ["parallel ::: 'rm -rf /etc' ls", [["rm", "-rf", "/etc"], ["ls"]]],
    ["parallel rm <<<'/etc'", [["rm", "/etc"]]],
    ["parallel <<<'rm -rf /etc'", [["rm", "-rf", "/etc"]]],
    ["parallel rm ::: 'a b'", [["rm", "a b"]]],
    ["parallel --halt-on-error 1 --tag-string x rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel --arg-sep ,, rm -rf ,, /etc", [["rm", "-rf", "/etc"]]],
    ["parallel --arg-sep ,, echo ::: ,, a", [["echo", ":::", "a"]]],
    ["parallel -ki sh rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel --replace=@ rm @/x ::: a", [["rm", "a/x"]]],
    ["parallel -l rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel -l -2 rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel -e -- rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    // Getopt::Long: unique prefixes, case-insensitive long names and the + prefix.
    ["parallel --halt-on 1 --colse , rm -rf ::: /etc", [["rm", "-rf", "$PARALLEL_INPUT"]]],
    ["parallel +halt 1 --J 2 rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel --HALT 1 rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel --REPLACE=@ rm @/x ::: a", [["rm", "a/x"]]],
    ["parallel --Q 'rm -rf' ::: /etc", [["rm -rf", "/etc"]]],
    // A bundled -l takes only a leading number, the rest is another cluster.
    ["parallel -lj 2 rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel -l1j 2 rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel -l1q rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel -lI X rm X ::: /etc", [["rm", "/etc"]]],
    ["parallel -l 1_0 rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel -l2 echo ::: a", [["echo", "a"]]],
    // An optional string takes a lone - but not an option.
    ["parallel -e - rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel -i +halt 1 rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel --replace +j 2 rm -rf ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel -i - echo - ::: a", [["echo", "a"]]],
    // Perl treats "" and "0" as false, so -i keeps {}.
    ["parallel -i '' rm -rf {} ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel --replace= rm -rf {} ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel -i0 rm -rf {} ::: /etc", [["rm", "-rf", "/etc"]]],
    ["parallel 'rm -rf {= $_=\"/etc\" =} {}' ::: a", [["rm", "-rf", "$PARALLEL_INPUT", "a"]]],
    ["parallel -I @ 'echo @ {=2 uc =}' ::: a", [["echo", "a", "$PARALLEL_INPUT"]]],
    // A perl expression is the shortest {= =}, so an unmatched {= stays text.
    ["parallel 'echo {=; rm a; {==}' ::: x", [["echo", "{="], ["rm", "a"], ["$PARALLEL_INPUT"]]],
    ["parallel echo '{={==}=}' ::: a", [["echo", "{=$PARALLEL_INPUT=}"]]],
    ["parallel rm {-1} '{1 /}' '{-1 //}' ::: /x/y", [["rm", "/x/y", "y", "/x"]]],
    // -I and -i rename only {} and its positional form.
    ["parallel -I XX rm XX {//} {1} ::: /x/y", [["rm", "/x/y", "/x", "{1}"]]],
    ["parallel -I / rm {//} / ::: /x/y", [["rm", "/x", "/x/y"]]],
    ["parallel -i XX -i 0 rm {} XX ::: a", [["rm", "a", "XX"]]],
    ["parallel -I XX -i YY rm XX YY {} ::: a", [["rm", "a", "a", "{}"]]],
    ["parallel echo {#} {%} ::: a b", [["echo", "1", "$PARALLEL_INPUT"], ["echo", "2", "$PARALLEL_INPUT"]]],
    // A replacement string in the first word leaves the values unquoted; -q quotes whole words.
    ["parallel {} ::: 'rm -rf /etc'", [["rm", "-rf", "/etc"]]],
    ["parallel 'echo{}' ::: ' a; ls'", [["echo", "a"], ["ls"]]],
    ["parallel 'echo x{}' ::: 'a; ls'", [["echo", "xa; ls"]]],
    ["parallel -q echo 'x{}y' z ::: 'a b'", [["echo", "xa by", "z"]]],
    ["parallel -q echo '' {2} '{= 1 =}' ::: a", [["echo", "", "", "$PARALLEL_INPUT"]]],
    // Quoting leaves only [-_.+/a-zA-Z0-9] bare, so a quoted value is never an assignment, and an empty value is ''.
    ["parallel -q e=1 '{}' rm ::: X=1", [["e=1", "X=1", "rm"]]],
    ["parallel echo {/} ::: /", [["echo", ""]]],
    // A job has one value, which positions other than 1, 0, -1 and -2 do not name.
    ["parallel echo A{-2} B{-3} C{0} D{-0} E{00} F{01} G{2} ::: v", [["echo", "Av", "B", "Cv", "D", "E", "Fv", "G"]]],
    ["parallel -n1 rm ::: a", [["rm", "a"]]],
    // Replacement strings do not span words, and their spaces are ASCII.
    ["parallel echo {1 '}' ::: a", [["echo", "{1", "}", "a"]]],
    ["parallel $'echo {1\\u00a0}' ::: a", [["echo", "{1\u00a0}", "a"]]],
    ["parallel -I 'A B' echo A B ::: a", [["echo", "A", "B", "a"]]],
    // Values are lines, and {//} is File::Basename's dirname.
    ["parallel rm -rf ::: $'/etc\\nx' $'a\\n'", [["rm", "-rf", "/etc"], ["rm", "-rf", "x"], ["rm", "-rf", "a"], ["rm", "-rf", ""]]],
    ["parallel 'rm -rf /{}' <<< $'\\nfoo'", [["rm", "-rf", "/"], ["rm", "-rf", "/foo"]]],
    [
      "parallel echo {} {//} ::: /x/ x/ a//b/ // ''",
      [["echo", "/x/", "/"], ["echo", "x/", "."], ["echo", "a//b/", "a"], ["echo", "//", "/"], ["echo", "", "."]],
    ],
  ])("%s", (input, expected) => {
    expect(argvs(input)).toEqual(expected)
    for (const atom of atoms(input)) expect(atom.wrapperChain[0]).toBe("parallel")
  })

  test("uses a variable operand for unknown input", () => {
    const [, atom] = atoms("cat list | parallel rm -rf")
    expect(atom).toMatchObject({ argv: ["rm", "-rf", "$PARALLEL_INPUT"], expanded: [false, false, true] })
    expect(atoms("parallel rm {} :::: list.txt")[0]).toMatchObject({ argv: ["rm", "$PARALLEL_INPUT"], expanded: [false, true] })
    expect(atoms(`cat list | parallel "rm '{}'"`)[1]).toMatchObject({ argv: ["rm", "$PARALLEL_INPUT"], expanded: [false, true] })
    expect(atoms("echo '$PARALLEL_INPUT'")[0]?.expanded).toEqual([false, false])
  })

  test("falls back to a variable operand for many values", () => {
    const values = Array.from({ length: 65 }, (_, i) => `v${i}`).join(" ")
    expect(argvs(`parallel rm ::: ${values}`)).toEqual([["rm", "$PARALLEL_INPUT"]])
  })

  test("runs no job for empty stdin", () => {
    expect(argvs("parallel rm <<EOF\nEOF")).toEqual([["parallel", "rm"]])
  })

  test("refuses to render too long jobs", () => {
    const values = Array.from({ length: 64 }, (_, i) => `${"v".repeat(300)}${i}`).join(" ")
    expect(atoms(`parallel echo ${"{} ".repeat(2000)}::: ${values}`)[0]?.opaque).toBe("too-long")
  })

  test.each([
    "parallel -C , rm {2} ::: a,b",
    "parallel --csv rm {2} ::: a,b",
    "parallel -d , rm <<<'a,b'",
    "parallel -0 rm <<<a",
    "parallel --trim lr rm ::: ' a '",
  ])("%s splits the values", (input) => {
    expect(argvs(input)).toEqual([["rm", "$PARALLEL_INPUT"]])
  })

  // Each value at every position, positions past a single value, and all values at once.
  test.each([
    ["parallel -n2 rm ::: a b", [["rm", "a"], ["rm", "b"], ["rm", "a", "b"]]],
    ["parallel -kX rm ::: a b", [["rm", "a"], ["rm", "b"], ["rm", "a", "b"]]],
    ["parallel -m rm ::: a b", [["rm", "a"], ["rm", "b"], ["rm", "a", "b"]]],
    ["parallel --xargs rm ::: a b", [["rm", "a"], ["rm", "b"], ["rm", "a", "b"]]],
    ["parallel -L 1 rm ::: 'a ' b", [["rm", "a "], ["rm", "b"], ["rm", "a ", "b"]]],
    [
      "parallel rm {1} {2} ::: a ::: b",
      [["rm", "a", "a"], ["rm", "b", "b"], ["rm", "a"], ["rm", "b"], ["rm", "a", "b", "a", "b"]],
    ],
    ["parallel -N2 'rm /{3}' ::: a b", [["rm", "/a"], ["rm", "/b"], ["rm", "/"], ["rm", "/a", "b"]]],
    ["parallel -N2 'rm {1}{2}' ::: a b", [["rm", "aa"], ["rm", "bb"], ["rm", "a"], ["rm", "b"], ["rm", "a", "ba", "b"]]],
    // `-N` overrides `-n`, a blank count is unset, and other Perl expressions may be anything, 0 included.
    ["parallel -N2 -n1 'rm {2}' ::: a", [["rm", "a"], ["rm"]]],
    ["parallel -n2 -N '' 'rm {2}' ::: a", [["rm"]]],
    ["parallel -n ' ' rm ::: a", [["rm", "a"]]],
    ["parallel -n 1+1 rm ::: a", [["rm", "a"], ["rm"]]],
    ["parallel -L 0 rm ::: a", [["rm", "a"], ["rm"]]],
    ["parallel -N0 'rm /{}' ::: a", [["rm", "/"]]],
    ["parallel -N0 echo ::: a", [["echo"]]],
  ])("%s groups the values", (input, expected) => {
    expect(argvs(input)).toEqual(expected)
  })

  test("runs on remote hosts with -S", () => {
    expect(only("parallel -S n1 rm -rf ::: /data")).toEqual({
      argv: ["rm", "-rf", "/data"],
      isRemote: true,
      targetHost: "n1",
      wrapperChain: ["parallel"],
    })
    expect(only("parallel -S : rm ::: x").isRemote).toBe(false)
    expect(only("parallel -lS n1 rm ::: x")).toMatchObject({ isRemote: true, targetHost: "n1" })
  })

  test("runs in the --wd directory", () => {
    expect(atoms("parallel --wd /srv rm x ::: a")[0]?.chdir).toEqual(["/srv"])
    expect(atoms("parallel --work-dir ... rm x ::: a")[0]?.chdir).toEqual([null])
    expect(atoms("parallel --wd {//} rm {/} ::: /etc/ssh")[0]?.chdir).toEqual([null])
    expect(atoms("parallel -I XX --wd /XX rm x ::: a")[0]?.chdir).toEqual([null])
  })

  test.each([
    "parallel -I '' rm ::: a",
    "parallel -I 'X(.)' 'rm X1' ::: a",
    "parallel -i '(a)' rm ::: a",
    "parallel --header : rm {d} ::: d a",
    "parallel echo '{=' '$_' '=}' ::: a",
    "parallel -n2 ::: rm '-rf /etc'",
    "parallel -a cmds.txt",
    "parallel :::: cmds.txt",
    "parallel --bnr B 'B -rf /etc' ::: /bin/rm",
    "parallel --basenam B 'B -rf /etc' ::: /bin/rm",
    "parallel --rpl '{r} s/.*/rm/' '{r} -rf /etc' ::: a",
    "parallel --plus '{+/} -rf /etc' ::: a",
    "parallel --parens ,, rm ::: a",
    "parallel --seqreplace N rm N ::: a",
  ])("%s has dynamic replacement strings or commands", (input) => {
    expect(atoms(input)).toMatchObject([{ opaque: "dynamic-args", wrapperChain: ["parallel"] }])
  })

  test.each(["parallel", "parallel --version"])("%s is not unwrapped", (input) => {
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

  test.each(["bash -c", "sh -s"])("%s is not unwrapped", (input) => {
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
    ["nerdctl -n k8s.io exec -it -w /x web rm -rf /data", "web", ["nerdctl exec"]],
    ["podman --remote exec -it -u root web rm -rf /data", "web", ["podman exec"]],
    ["podman exec -l rm -rf /data", "(selected)", ["podman exec"]],
    ["podman exec --url unix:///s -it web rm -rf /data", "web", ["podman exec"]],
    ["crictl -r unix:///run/containerd/containerd.sock exec -it 3f2a rm -rf /data", "3f2a", ["crictl exec"]],
    ["crictl exec -i --timeout 5 3f2a rm -rf /data", "3f2a", ["crictl exec"]],
    // Filters select the containers, so there is no container argument.
    ["crictl exec --name nginx rm -rf /data", "(selected)", ["crictl exec"]],
    ["crictl exec -it -p web-0 rm -rf /data", "(selected)", ["crictl exec"]],
    ["crictl exec -l rm -rf /data", "(selected)", ["crictl exec"]],
    ["crictl exec -itl rm -rf /data", "(selected)", ["crictl exec"]],
    ["crictl exec --last=2 rm -rf /data", "(selected)", ["crictl exec"]],
    ["nerdctl exec -n k8s.io -it web rm -rf /data", "web", ["nerdctl exec"]],
    ["nerdctl exec --namespace k8s.io web rm -rf /data", "web", ["nerdctl exec"]],
    ["podman exec --cidfile /x rm -rf /data", "(selected)", ["podman exec"]],
    ["podman exec --cidfile=/x rm -rf /data", "(selected)", ["podman exec"]],
  ])("%s", (input, targetHost, wrapperChain) => {
    expect(only(input)).toEqual({ argv: ["rm", "-rf", "/data"], isRemote: true, targetHost, wrapperChain })
  })

  test("unwraps shells inside containers", () => {
    expect(only("kubectl exec pod -- sh -c 'rm -rf /x'")).toMatchObject({
      argv: ["rm", "-rf", "/x"],
      wrapperChain: ["kubectl exec", "sh -c"],
    })
  })

  test.each(["kubectl get pods", "kubectl exec pod", "docker ps", "docker exec web", "crictl ps", "nerdctl exec web"])("%s is not unwrapped", (input) => {
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

  test("nested scripts share one brace expansion budget", () => {
    const half = "bash -c 'echo {1..32}{1..16}'"
    expect(atoms(`${half}; ${half}`).some((atom) => atom.opaque)).toBe(false)
    expect(atoms(`${half}; ${half}; ${half}`)[2]).toMatchObject({ opaque: "too-long", wrapperChain: ["bash -c"] })
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
