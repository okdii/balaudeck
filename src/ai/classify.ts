// Shell-command safety classifier for the SSH agent tool.
//
// Auto-run is opt-in and only for commands we can recognise as read-only; every
// other command is approval-gated. The approval gate — not this allowlist — is
// the real safety net: classifying arbitrary shell is inherently imperfect, so
// we err hard toward "write" (approve). Over-approving is safe; auto-running a
// write is the failure mode we avoid.

import type { ToolRisk } from "./tool";

const write = (reason: string): ToolRisk => ({ level: "write", reason });
const read: ToolRisk = { level: "read" };

/** Base commands considered read-only (informational). Anything not here is
 *  approval-gated. Powerful/dual-use tools (sed, awk, perl, python, xargs, tee,
 *  dd, curl, wget, nc, ssh, mount, ping, …) are deliberately absent. */
const READ_CMDS = new Set<string>([
  "ls", "l", "ll", "la", "dir", "vdir", "cat", "tac", "bat", "batcat", "head", "tail",
  "less", "more", "zless", "zcat", "zmore", "pwd", "whoami", "id", "groups", "logname",
  "hostname", "hostnamectl", "uname", "arch", "nproc", "uptime", "date", "cal", "ncal",
  "env", "printenv", "echo", "printf", "seq", "which", "type", "command", "whereis",
  "df", "du", "free", "vmstat", "iostat", "mpstat", "sar", "lsblk", "blkid", "lsof",
  "findmnt", "ps", "top", "htop", "atop", "pgrep", "pidof", "pstree", "jobs", "w", "who",
  "users", "last", "lastlog", "ss", "netstat", "route", "arp", "dig", "nslookup", "host",
  "getent", "stat", "file", "wc", "sort", "uniq", "comm", "cut", "join", "paste", "column",
  "fold", "nl", "tr", "grep", "egrep", "fgrep", "rg", "ag", "ack", "zgrep", "find", "fd",
  "tree", "realpath", "readlink", "dirname", "basename", "cksum", "md5sum", "sha1sum",
  "sha256sum", "sha512sum", "b2sum", "dmesg", "lscpu", "lsusb", "lspci", "lsmod", "tty",
  "locale", "cksum", "strings", "od", "hexdump", "xxd", "diff", "cmp", "git", "docker",
  "podman", "systemctl", "journalctl", "kubectl", "sysctl", "ip",
]);

const GIT_READ = new Set([
  "status", "log", "diff", "show", "branch", "remote", "describe", "rev-parse", "blame",
  "tag", "shortlog", "ls-files", "ls-tree", "cat-file", "reflog", "whatchanged", "grep",
  "count-objects", "config", "for-each-ref", "symbolic-ref", "rev-list",
]);
const DOCKER_READ = new Set([
  "ps", "images", "logs", "inspect", "stats", "version", "info", "top", "port", "history",
  "diff",
]);
const SYSTEMCTL_READ = new Set([
  "status", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files",
  "list-timers", "list-sockets", "list-dependencies", "show", "cat", "get-default",
  "show-environment",
]);
const KUBECTL_READ = new Set([
  "get", "describe", "logs", "top", "version", "cluster-info", "api-resources",
  "api-versions", "explain",
]);
const IP_WRITE_SUBS = new Set(["add", "del", "delete", "set", "change", "replace", "flush"]);

function classifySegment(seg: string): ToolRisk {
  const tokens = seg.split(/\s+/).filter(Boolean);
  let i = 0;
  // Skip leading `VAR=val` assignments and an `env VAR=val` prefix.
  const isAssign = (t: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);
  while (i < tokens.length && isAssign(tokens[i])) i++;
  if (i < tokens.length && tokens[i] === "env") {
    i++;
    while (i < tokens.length && isAssign(tokens[i])) i++;
  }
  if (i >= tokens.length) return read;

  let cmd = tokens[i];
  cmd = cmd.split("/").pop() || cmd; // /usr/bin/ls -> ls
  const rest = tokens.slice(i + 1);
  const sub = () => rest.find((a) => !a.startsWith("-"));

  if (cmd === "sudo" || cmd === "doas" || cmd === "su") return write(`elevates privileges (${cmd})`);
  if (!READ_CMDS.has(cmd)) return write(`'${cmd}' isn't a known read-only command`);

  if (cmd === "find" &&
    rest.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"].includes(a)))
    return write("find can run or delete");
  if (cmd === "git") {
    const s = sub();
    if (!s || !GIT_READ.has(s)) return write(`git ${s ?? ""}`.trim());
    if (s === "config" &&
      !rest.some((a) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(a)))
      return write("git config can write");
  }
  if ((cmd === "docker" || cmd === "podman") && (!sub() || !DOCKER_READ.has(sub()!)))
    return write(`${cmd} ${sub() ?? ""}`.trim());
  if (cmd === "systemctl" && (!sub() || !SYSTEMCTL_READ.has(sub()!)))
    return write(`systemctl ${sub() ?? ""}`.trim());
  if (cmd === "kubectl" && (!sub() || !KUBECTL_READ.has(sub()!)))
    return write(`kubectl ${sub() ?? ""}`.trim());
  if (cmd === "journalctl" &&
    rest.some((a) => a.startsWith("--vacuum") || a === "--rotate" || a === "--flush"))
    return write("journalctl rotates/vacuums logs");
  if (cmd === "sysctl" && (rest.includes("-w") || rest.some((a) => a.includes("="))))
    return write("sysctl -w changes kernel params");
  if (cmd === "ip" && rest.some((a) => IP_WRITE_SUBS.has(a))) return write("ip modifies networking");

  return read;
}

/** Classify a shell command as read-only (auto-runnable) or write (approve). */
export function classifyCommand(raw: string): ToolRisk {
  const cmd = raw.trim();
  if (!cmd) return read;
  // Command substitution / process substitution / output redirects can hide or
  // perform writes — always approve. (Yes, this approve-gates harmless
  // `... 2>/dev/null`; over-approving is the safe direction.)
  if (/\$\(|`|>|<\(|>\(/.test(cmd)) return write("uses redirection or command substitution");
  // A backgrounding `&` (but not the `&&` operator, which we split on below).
  if (/(^|[^&])&\s*$/.test(cmd)) return write("runs in the background");
  const segments = cmd.split(/\|\||&&|;|\||\n/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const r = classifySegment(seg);
    if (r.level === "write") return r;
  }
  return read;
}
