import { describe, expect, test } from "bun:test"
import { normalizeName, tokenize } from "../src/tokenizer"

const names = (input: string) => tokenize(input).commands.map((command) => command.name)
const argv = (input: string) => tokenize(input).commands.map((command) => command.argv)
const first = (input: string) => {
  const [command] = tokenize(input).commands
  if (!command) throw new Error(`no command in ${input}`)
  return command
}

describe("words and quoting", () => {
  test("splits plain words", () => {
    expect(argv("rm  -rf\t/data")).toEqual([["rm", "-rf", "/data"]])
  })

  test("removes quotes and escapes", () => {
    expect(argv(`echo 'a b' "c d" e\\ f "x\\"y" 'it'\\''s'`)).toEqual([["echo", "a b", "c d", "e f", 'x"y', "it's"]])
  })

  test("keeps backslash literal in double quotes unless it escapes a special char", () => {
    expect(argv(`echo "a\\nb" "\\$x"`)).toEqual([["echo", "a\\nb", "$x"]])
  })

  test("joins adjacent quoted parts into one word", () => {
    expect(names(`"r"'m' -rf /`)).toEqual(["rm"])
  })

  test("decodes ANSI-C quoting", () => {
    const command = first(`$'\\x72\\x6d' -rf $'\\057'`)
    expect(command.name).toBe("rm")
    expect(command.argv).toEqual(["rm", "-rf", "/"])
    expect(command.expanded).toEqual([false, false, false])
  })

  test("removes line continuations", () => {
    expect(argv("rm \\\n  -rf \\\n /")).toEqual([["rm", "-rf", "/"]])
  })

  test("treats # as a comment only at word start", () => {
    expect(argv("echo a#b # rm -rf /\nls")).toEqual([["echo", "a#b"], ["ls"]])
  })
})

describe("command names", () => {
  test.each([
    ["\\rm -rf /", "rm"],
    ["/usr/bin/rm -rf /", "rm"],
    ['"rm" -rf /', "rm"],
    ["'/bin/rm' -rf /", "rm"],
    ["./kubectl delete pod a", "kubectl"],
  ])("%s -> %s", (input, name) => {
    expect(names(input)).toEqual([name])
  })

  test("normalizeName strips leading backslashes and directories", () => {
    expect(normalizeName("\\\\/sbin/mkfs.ext4")).toBe("mkfs.ext4")
    expect(normalizeName("kubectl")).toBe("kubectl")
  })

  test("marks expanded words", () => {
    const command = first(`$CMD -rf "$DIR" '$X' ${"${HOME}"}/a *.log plain`)
    expect(command.expanded).toEqual([true, false, true, false, true, true, false])
  })

  test("marks unquoted bracket globs and brace expansions", () => {
    const command = first(`/bin/r[m] {rm,-rf,/} r{m,} {1..3} x[ ]y {} @{u} "{a,b}" \\[a] '[a]'`)
    expect(command.expanded).toEqual([true, true, true, true, false, false, false, false, false, false, false])
  })
})

describe("lists and pipelines", () => {
  test("records the connector before each command", () => {
    const commands = tokenize("a; b && c || d | e & f |& g\nh").commands
    expect(commands.map((command) => command.name)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"])
    expect(commands.map((command) => command.connector)).toEqual([undefined, ";", "&&", "||", "|", "&", "|", ";"])
  })

  test("keeps the list operator across a following newline", () => {
    expect(tokenize("a &&\n  b").commands[1]?.connector).toBe("&&")
  })

  test("does not split operators inside quotes", () => {
    expect(argv(`echo "a; b && c | d" 'e || f'`)).toEqual([["echo", "a; b && c | d", "e || f"]])
  })

  test("keeps the pipeline upstream text", () => {
    const commands = tokenize(`echo "docker stop app" | ssh node1 sh`).commands
    expect(commands[0]?.argv).toEqual(["echo", "docker stop app"])
    expect(commands[1]?.connector).toBe("|")
    expect(commands[1]?.argv).toEqual(["ssh", "node1", "sh"])
  })
})

describe("redirects", () => {
  test("parses redirect operators and fd prefixes", () => {
    const command = first("cat < in > out 2>&1 >> log &>/dev/null 3<>rw >|clobber")
    expect(command.argv).toEqual(["cat"])
    expect(command.redirects).toEqual([
      { op: "<", target: "in" },
      { op: ">", target: "out" },
      { fd: 2, op: ">&", target: "1" },
      { op: ">>", target: "log" },
      { op: "&>", target: "/dev/null" },
      { fd: 3, op: "<>", target: "rw" },
      { op: ">|", target: "clobber" },
    ])
  })

  test("only treats an unquoted all-digit word as an fd", () => {
    const command = first(`echo a2>b "2">c`)
    expect(command.argv).toEqual(["echo", "a2", "2"])
    expect(command.redirects).toEqual([
      { op: ">", target: "b" },
      { op: ">", target: "c" },
    ])
  })

  test("keeps redirect-only commands", () => {
    expect(tokenize("> /etc/passwd").commands).toMatchObject([{ name: "", argv: [], redirects: [{ op: ">" }] }])
  })

  test("captures here-strings", () => {
    const command = first(`ssh node1 bash <<< "rm -rf /data"`)
    expect(command.redirects).toEqual([{ op: "<<<", target: "rm -rf /data", body: "rm -rf /data" }])
  })
})

describe("heredocs", () => {
  test("captures a quoted heredoc body", () => {
    const commands = tokenize("ssh node1 'bash -s' <<'EOF'\nrm -rf /tmp/a\n$(not run)\nEOF\necho done").commands
    expect(commands.map((command) => command.name)).toEqual(["ssh", "echo"])
    expect(commands[0]?.argv).toEqual(["ssh", "node1", "bash -s"])
    expect(commands[0]?.redirects).toEqual([{ op: "<<", target: "EOF", body: "rm -rf /tmp/a\n$(not run)\n" }])
    expect(commands[0]?.substitutions).toEqual([])
  })

  test("strips leading tabs for <<-", () => {
    const command = first("cat <<-END\n\tline\n\tEND\n")
    expect(command.redirects[0]?.body).toBe("line\n")
  })

  test("extracts substitutions from an unquoted heredoc body", () => {
    const command = first("cat <<EOF\nx $(rm -rf /) `reboot`\nEOF")
    expect(command.substitutions.map((script) => script.commands[0]?.name)).toEqual(["rm", "reboot"])
  })

  test("reads bodies after the whole line, in order, across a pipeline", () => {
    const commands = tokenize("cat <<A | ssh h sh <<B\na\nA\nb\nB\nls").commands
    expect(commands.map((command) => command.redirects[0]?.body)).toEqual(["a\n", "b\n", undefined])
  })

  test("uses the rest of the input when the delimiter is missing", () => {
    expect(first("cat <<EOF\nrm -rf /").redirects[0]?.body).toBe("rm -rf /\n")
  })
})

describe("substitutions", () => {
  test("extracts $(...) and backticks", () => {
    const command = first("echo $(rm -rf /) `reboot` \"x $(kubectl delete ns a) y\" '$(no)'")
    expect(command.name).toBe("echo")
    expect(command.substitutions.map((script) => script.commands[0]?.name)).toEqual(["rm", "reboot", "kubectl"])
    expect(command.argv[3]).toBe("x $(kubectl delete ns a) y")
  })

  test("handles nesting and parentheses inside", () => {
    const command = first(`echo $(echo $(rm -rf "/a)") ; (ls))`)
    const [outer] = command.substitutions
    expect(outer?.commands.map((item) => item.name)).toEqual(["echo", "ls"])
    expect(outer?.commands[0]?.substitutions[0]?.commands[0]?.argv).toEqual(["rm", "-rf", "/a)"])
  })

  test("extracts process substitutions", () => {
    const command = first("diff <(rm -rf /) >(reboot)")
    expect(command.substitutions.map((script) => script.commands[0]?.name)).toEqual(["rm", "reboot"])
  })

  test("extracts substitutions from assignments and redirect targets", () => {
    const commands = tokenize("X=$(rm -rf /) ; echo > $(reboot)").commands
    expect(commands[0]).toMatchObject({ name: "", assignments: ["X=$(rm -rf /)"] })
    expect(commands[0]?.substitutions[0]?.commands[0]?.name).toBe("rm")
    expect(commands[1]?.substitutions[0]?.commands[0]?.name).toBe("reboot")
  })

  test("does not treat arithmetic as a substitution", () => {
    const script = tokenize("echo $((1 + (2 * 3))); (( i++ ))")
    expect(script.opaque).toBeUndefined()
    expect(script.commands.map((command) => command.argv)).toEqual([["echo", "$((1 + (2 * 3)))"]])
    expect(script.commands[0]?.substitutions).toEqual([])
  })
})

describe("assignments", () => {
  test("separates leading assignments from the command", () => {
    const command = first(`A=1 B="x y" C+=z rm -rf / D=2`)
    expect(command.assignments).toEqual(["A=1", "B=x y", "C+=z"])
    expect(command.name).toBe("rm")
    expect(command.argv).toEqual(["rm", "-rf", "/", "D=2"])
  })

  test("does not treat a quoted name as an assignment", () => {
    expect(tokenize(`"A=1" ls`).commands[0]?.argv).toEqual(["A=1", "ls"])
  })

  test("reads array assignments", () => {
    const command = first("A=(1 'b c') rm x")
    expect(command.assignments).toEqual(["A=(1 'b c')"])
    expect(command.name).toBe("rm")
  })
})

describe("compound commands", () => {
  test.each([
    ["if true; then rm -rf /; else reboot; fi", ["true", "rm", "reboot"]],
    ["(cd /; rm -rf etc)", ["cd", "rm"]],
    ["{ rm a; } > log", ["rm", ""]],
    ["for f in *; do rm $f; done", ["for", "rm"]],
    ["while read x; do kubectl delete pod $x; done < list", ["read", "kubectl", ""]],
    ["! rm a", ["rm"]],
  ])("%s", (input, expected) => {
    const script = tokenize(input)
    expect(script.opaque).toBeUndefined()
    expect(script.commands.map((command) => command.name)).toEqual(expected)
  })

  test("does not treat quoted keywords as keywords", () => {
    expect(names(`"if" a`)).toEqual(["if"])
  })

  test("flags function definitions but still parses the body", () => {
    for (const input of ["f() { rm -rf /; }; f", "function f { rm -rf /; }; f", "function f() { rm -rf /; }"]) {
      const script = tokenize(input)
      expect(script.opaque).toBe("function-definition")
      expect(script.commands.map((command) => command.name)).toContain("rm")
    }
  })
})

describe("opaque results", () => {
  test.each([
    [`echo "abc`, "unterminated-quote"],
    ["echo 'abc", "unterminated-quote"],
    ["echo $(rm -rf /", "unterminated-substitution"],
    ["echo `rm -rf /", "unterminated-substitution"],
    ["echo a)", "invalid-syntax"],
    ["(echo a", "invalid-syntax"],
    ["echo >", "invalid-syntax"],
    ["echo (a)", "invalid-syntax"],
    ["case $x in a) rm -rf /;; esac", "unsupported-syntax"],
    ["echo ${x:-$(rm -rf /)}", "unsupported-syntax"],
    ["echo $(( $(rm -rf /) ))", "unsupported-syntax"],
  ])("%s -> %s", (input, reason) => {
    expect(tokenize(input).opaque).toBe(reason as never)
  })

  test("keeps commands parsed before the failure", () => {
    const script = tokenize(`rm -rf / ; echo "abc`)
    expect(script.opaque).toBe("unterminated-quote")
    expect(script.commands[0]?.argv).toEqual(["rm", "-rf", "/"])
  })

  test("keeps the current command when a nested substitution fails", () => {
    const script = tokenize(`rm -rf / $(echo "x`)
    expect(script.opaque).toBe("unterminated-quote")
    expect(script.commands[0]?.argv).toEqual(["rm", "-rf", "/"])
  })

  test("limits nesting depth", () => {
    const deep = "$(".repeat(40) + "rm" + ")".repeat(40)
    expect(tokenize(`echo ${deep}`).opaque).toBe("too-deep")
  })

  test("limits input length", () => {
    expect(tokenize("a".repeat(64 * 1024 + 1))).toEqual({ commands: [], opaque: "too-long" })
  })

  test("never throws", () => {
    const pieces = ["a", " ", "'", '"', "\\", "$", "(", ")", "`", "{", "}", "<", ">", "|", "&", ";", "\n", "#", "=", "<<", "EOF"]
    let seed = 1
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
    for (let i = 0; i < 2000; i++) {
      const input = Array.from({ length: 1 + Math.floor(random() * 20) }, () => pieces[Math.floor(random() * pieces.length)]).join("")
      expect(() => tokenize(input)).not.toThrow()
    }
  })
})
