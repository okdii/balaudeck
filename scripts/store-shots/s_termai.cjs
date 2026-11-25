// Terminal AI: a plain-words request becomes a command at the prompt (not run),
// with a one-line explanation; the ask bar is open again for the next one.
module.exports = async (page, opts = {}) => {
  await page.evaluate(() => {
    const prev = window.__mockHook;
    window.__mockHook = (cmd, a) => {
      if (cmd === "ai_complete") return { content: [{ type: "text", text: "sudo du -ah /var/log | sort -rh | head -n 10\n# Lists the 10 biggest files and folders under /var/log, largest first." }], stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 40 } };
      if (cmd === "ssh_write" && typeof a.data === "string" && a.data.startsWith("\x05\x15")) {
        const bytes = Array.from(new TextEncoder().encode(a.data.slice(2)));
        setTimeout(() => window.__mock.emit("ssh://data/ssh1", bytes), 0);
        return null;
      }
      return prev ? prev(cmd, a) : undefined;
    };
  });
  await require("./s_ssh.cjs")(page, opts);
  const openAsk = async () => {
    if (opts.mobile) await page.getByRole("button", { name: "Ask AI for a command" }).click();
    else {
      await page.locator(".xterm").first().click();
      await page.keyboard.press("Meta+i");
    }
    await page.waitForTimeout(400);
  };
  await openAsk();
  const input = page.locator(".term-ai-bar input, .term-ai-bar textarea").first();
  await input.fill("find the 10 biggest log files");
  await input.press("Enter");
  await page.waitForTimeout(1200);
  await openAsk();
  await input.fill(opts.mobile ? "what is using port 443?" : "which process is listening on port 443?");
  await page.waitForTimeout(300);
};
