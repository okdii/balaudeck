import { useEffect, useState } from "react";
import { idleLockApi } from "./IdleLock";
import { Icon, type IconName } from "./Icon";
import { api } from "./api";
import { KnownHostsSection } from "./HostKeys";
import { updaterEnabled, storeBuild } from "./updater";
import {
  ACCENTS,
  AI_ANTHROPIC_MODELS,
  AI_ANTHROPIC_AUTO,
  PRIVACY_SECTIONS,
  TERM_SCHEMES,
  TMUX_SESSION_FALLBACK,
  defaultModelFor,
  getSettings,
  resolveFontSize,
  sanitizeTmuxSession,
  setSettings,
  type Accent,
  type AiProvider,
  type AiSettings,
  type Settings,
  type TermScheme,
  type ThemeMode,
} from "./settings";

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

type SectionId = "appearance" | "terminal" | "ai" | "privacy" | "security";

/** Sections in the rail. Everything terminal — look AND behaviour — lives under
 *  "Terminal", so e.g. font size is where you'd go looking for it rather than
 *  split across two panes. Every section keeps at least one row on every
 *  platform, so a platform-gated row never leaves a pane empty. */
const SECTIONS: { id: SectionId; label: string; icon: IconName }[] = [
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "ai", label: "AI Assistant", icon: "sparkles" },
  { id: "privacy", label: "Privacy", icon: "eyeOff" },
  { id: "security", label: "Security", icon: "lock" },
];

/** In-app Settings. Grouped into rail sections — it had grown to ten stacked
 *  blocks in one scrolling column. Every change applies live and persists per
 *  device. */
export function SettingsModal({
  onClose,
  privacy,
  onPrivacyChange,
  isDesktop,
}: {
  onClose: () => void;
  privacy: boolean;
  onPrivacyChange: (v: boolean) => void;
  /** Gates the desktop-only rows (local shell picker, self-updater). */
  isDesktop: boolean;
}) {
  const [s, setS] = useState<Settings>(getSettings());
  const [tab, setTab] = useState<SectionId>("appearance");
  // Shells actually installed here, for the Local terminal picker (desktop).
  const [shells, setShells] = useState<{ path: string; label: string }[]>([]);
  const update = (patch: Partial<Settings>) => {
    setSettings(patch);
    setS(getSettings());
  };
  const updateAi = (patch: Partial<AiSettings>) => update({ ai: { ...s.ai, ...patch } });

  // AI API key entry: the user pastes their own key (never returned to the UI);
  // we only track whether one is stored for the current provider.
  const [keyInput, setKeyInput] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const aiProvider = s.ai.provider;
  useEffect(() => {
    setKeyInput("");
    api.aiKeyExists(aiProvider).then(setKeySaved).catch(() => setKeySaved(false));
  }, [aiProvider]);
  const saveKey = async () => {
    const k = keyInput.trim();
    if (!k) return;
    setKeyBusy(true);
    try {
      await api.aiKeySave(aiProvider, k);
      setKeySaved(true);
      setKeyInput("");
    } finally {
      setKeyBusy(false);
    }
  };
  const clearKey = async () => {
    setKeyBusy(true);
    try {
      await api.aiKeySave(aiProvider, null);
      setKeySaved(false);
      setKeyInput("");
    } finally {
      setKeyBusy(false);
    }
  };

  // Claude model picker: fetched from Anthropic's /v1/models with the saved key,
  // so new Claude releases appear without a BalauDeck update.
  const [claudeModels, setClaudeModels] = useState<{ id: string; label: string }[]>([]);
  const [claudeLatest, setClaudeLatest] = useState("");
  const [claudeErr, setClaudeErr] = useState("");
  const [claudeBusy, setClaudeBusy] = useState(false);
  const loadClaude = (refresh = false) => {
    setClaudeErr("");
    setClaudeBusy(true);
    api
      .aiAnthropicModels(refresh)
      .then((r) => {
        setClaudeModels(r.models.map((m) => ({ id: m.id, label: m.display_name })));
        setClaudeLatest(r.latest);
      })
      .catch((e) => {
        setClaudeModels([]);
        setClaudeLatest("");
        setClaudeErr(String(e));
      })
      .finally(() => setClaudeBusy(false));
  };
  useEffect(() => {
    if (s.ai.provider === "anthropic" && keySaved) loadClaude();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.ai.provider, keySaved]);
  const claudeOptions = claudeModels.length ? claudeModels : AI_ANTHROPIC_MODELS;
  const claudeLatestLabel =
    claudeModels.find((m) => m.id === claudeLatest)?.label ?? claudeLatest;

  // Ollama installed-model picker (local, keyless). Fetched from the server's
  // /api/tags; falls back to a text field if Ollama isn't reachable.
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaErr, setOllamaErr] = useState("");
  const loadOllama = () => {
    setOllamaErr("");
    api
      .aiOllamaModels(s.ai.ollamaBaseUrl)
      .then(setOllamaModels)
      .catch((e) => {
        setOllamaModels([]);
        setOllamaErr(String(e));
      });
  };
  useEffect(() => {
    if (s.ai.provider === "ollama") loadOllama();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.ai.provider, s.ai.ollamaBaseUrl]);

  // Store builds are sandboxed and can't open a PTY at all (see local.rs), so
  // there is no local shell to pick.
  const localAvailable = isDesktop && !storeBuild;

  useEffect(() => {
    if (localAvailable) api.listShells().then(setShells).catch(() => {});
  }, [localAvailable]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const auto = !(s.termFontSize >= 10 && s.termFontSize <= 40);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h3>Settings</h3>
          <button className="icon settings-close" title="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-rail" aria-label="Settings sections">
            {SECTIONS.map((sec) => (
              <button
                key={sec.id}
                className={tab === sec.id ? "on" : ""}
                aria-current={tab === sec.id ? "page" : undefined}
                onClick={() => setTab(sec.id)}
              >
                <Icon name={sec.icon} size={15} /> {sec.label}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
            {/* Appearance ------------------------------------------------- */}
            {tab === "appearance" && (
              <>
                <div className="settings-label">Theme</div>
                <div className="seg solid" role="group" aria-label="Theme">
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      className={s.theme === t.id ? "on" : ""}
                      onClick={() => update({ theme: t.id })}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                <div className="settings-label">Accent</div>
                <div className="swatch-row" role="group" aria-label="Accent colour">
                  {ACCENTS.map((a: { id: Accent; label: string; swatch: string }) => (
                    <button
                      key={a.id}
                      className={"swatch" + (s.accent === a.id ? " active" : "")}
                      title={a.label}
                      aria-label={a.label}
                      style={{ background: a.swatch }}
                      onClick={() => update({ accent: a.id })}
                    />
                  ))}
                </div>
              </>
            )}

            {/* Terminal --------------------------------------------------- */}
            {tab === "terminal" && (
              <>
                <div className="settings-label">
                  Font size{" "}
                  <small>{auto ? `Auto · ${resolveFontSize(s)}px` : `${s.termFontSize}px`}</small>
                </div>
                <div className="fontsize-row">
                  <button
                    className={"pill-toggle" + (auto ? " on" : "")}
                    onClick={() => update({ termFontSize: 0 })}
                  >
                    Auto
                  </button>
                  <input
                    type="range"
                    min={10}
                    max={40}
                    step={1}
                    value={auto ? resolveFontSize(s) : s.termFontSize}
                    onChange={(e) => update({ termFontSize: Number(e.target.value) })}
                  />
                </div>

                <div className="settings-label">Colour scheme</div>
                <div className="scheme-grid" role="group" aria-label="Terminal colour scheme">
                  {TERM_SCHEMES.map(
                    (sc: { id: TermScheme; label: string; theme: Record<string, string> }) => (
                      <button
                        key={sc.id}
                        className={"scheme-card" + (s.termScheme === sc.id ? " active" : "")}
                        onClick={() => update({ termScheme: sc.id })}
                      >
                        <span className="scheme-preview" style={{ background: sc.theme.background }}>
                          {["green", "yellow", "blue", "magenta", "cyan"].map((k) => (
                            <i key={k} style={{ background: sc.theme[k] }} />
                          ))}
                        </span>
                        <span className="scheme-name">{sc.label}</span>
                      </button>
                    ),
                  )}
                </div>

                <div className="settings-label">Copy &amp; paste</div>
                <button
                  className={"pill-toggle" + (s.copyOnSelect ? " on" : "")}
                  onClick={() => update({ copyOnSelect: !s.copyOnSelect })}
                >
                  Copy on select · {s.copyOnSelect ? "On" : "Off"}
                </button>
                <p className="settings-hint">
                  When on, selecting text with the mouse copies it straight away.
                  Paste is always ⌘V (Ctrl+Shift+V on Windows/Linux) or the
                  terminal's right-click menu; ⌘C / Ctrl+Shift+C also copy, and
                  plain Ctrl+C still sends an interrupt.
                </p>

                {/* Local shell — desktop only, and not in the sandboxed store
                    build, where local terminals don't exist at all. */}
                {localAvailable && (
                  <>
                    <div className="settings-label">Local shell</div>
                    <select
                      value={s.localShell}
                      onChange={(e) => update({ localShell: e.target.value })}
                      aria-label="Shell for new Local terminals"
                    >
                      <option value="">Auto (system default)</option>
                      {shells.map((sh) => (
                        <option key={sh.path} value={sh.path}>
                          {sh.label}
                        </option>
                      ))}
                    </select>
                    <p className="settings-hint">
                      Which shell new Local terminals open. Auto uses your login shell
                      ($SHELL) on macOS/Linux and PowerShell on Windows. Only shells
                      found on this machine are listed; already-open terminals keep the
                      shell they started with.
                    </p>
                  </>
                )}

                <div className="settings-label">Default tmux session</div>
                <input
                  value={s.tmuxSession}
                  onChange={(e) => update({ tmuxSession: sanitizeTmuxSession(e.target.value) })}
                  placeholder={TMUX_SESSION_FALLBACK}
                  aria-label="Default tmux session name"
                />
                <p className="settings-hint">
                  Used by SSH connections with “Persist with tmux” whose own name is
                  blank. Set something unique (e.g. your username) — otherwise everyone
                  on the same server defaults to “{TMUX_SESSION_FALLBACK}” and attaches
                  to each other’s session. A connection’s own tmux session name still
                  overrides this. Letters, numbers, - and _ only; applies to new
                  connections.
                </p>
              </>
            )}

            {/* AI Assistant ---------------------------------------------- */}
            {tab === "ai" && (
              <>
                <div className="settings-label">AI assistant</div>
                <div className="fontsize-row">
                  <button
                    className={"pill-toggle" + (s.ai.enabled ? " on" : "")}
                    onClick={() => updateAi({ enabled: !s.ai.enabled })}
                  >
                    Enable AI assistant · {s.ai.enabled ? "On" : "Off"}
                  </button>
                </div>
                <p className="settings-hint">
                  Adds an AI button (✦) to the pane header of local terminals, connected SSH
                  sessions and connected SQL databases. It opens a chat that can inspect the
                  server or database for you. Read-only commands run automatically; anything that
                  changes state asks for your approval first. Your API key is stored in the
                  OS keychain and only leaves your machine to reach the provider you choose.
                </p>

                <div className="settings-label">Provider</div>
                <div className="seg solid" role="group" aria-label="AI provider">
                  {(["anthropic", "openai", "ollama"] as AiProvider[]).map((p) => (
                    <button
                      key={p}
                      className={s.ai.provider === p ? "on" : ""}
                      onClick={() => updateAi({ provider: p, model: defaultModelFor(p) })}
                    >
                      {p === "anthropic"
                        ? "Claude"
                        : p === "openai"
                          ? "OpenAI-compatible"
                          : "Ollama (local)"}
                    </button>
                  ))}
                </div>

                {/* Ollama server first, so the model picker can query it. */}
                {s.ai.provider === "ollama" && (
                  <>
                    <div className="settings-label">Ollama server</div>
                    <input
                      value={s.ai.ollamaBaseUrl}
                      onChange={(e) => updateAi({ ollamaBaseUrl: e.target.value })}
                      placeholder="http://localhost:11434/v1"
                      aria-label="Ollama base URL"
                      spellCheck={false}
                    />
                  </>
                )}

                <div className="settings-label">
                  Model{" "}
                  {s.ai.provider === "anthropic" && keySaved && (
                    <button
                      className="icon"
                      onClick={() => loadClaude(true)}
                      disabled={claudeBusy}
                      title="Refresh Claude models"
                      style={{ verticalAlign: "middle" }}
                    >
                      <Icon name="refresh" size={12} />
                    </button>
                  )}
                  {s.ai.provider === "ollama" && (
                    <button
                      className="icon"
                      onClick={loadOllama}
                      title="Refresh installed models"
                      style={{ verticalAlign: "middle" }}
                    >
                      <Icon name="refresh" size={12} />
                    </button>
                  )}
                </div>
                {s.ai.provider === "anthropic" ? (
                  <>
                    <select
                      value={s.ai.model}
                      onChange={(e) => updateAi({ model: e.target.value })}
                      aria-label="Claude model"
                    >
                      <option value={AI_ANTHROPIC_AUTO}>
                        Latest (auto){claudeLatestLabel ? ` — ${claudeLatestLabel}` : ""}
                      </option>
                      {s.ai.model !== AI_ANTHROPIC_AUTO &&
                        !claudeOptions.some((m) => m.id === s.ai.model) && (
                          <option value={s.ai.model}>{s.ai.model}</option>
                        )}
                      {claudeOptions.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <p className="settings-hint">
                      {!keySaved
                        ? "Save your API key below to load the full list of Claude models."
                        : claudeErr
                          ? `Couldn't load the model list (${claudeErr}). Showing the built-in list.`
                          : "Latest (auto) always uses Claude's newest model, so a new release is picked up without updating BalauDeck."}
                    </p>
                  </>
                ) : s.ai.provider === "ollama" && ollamaModels.length > 0 ? (
                  <select
                    value={s.ai.model}
                    onChange={(e) => updateAi({ model: e.target.value })}
                    aria-label="Ollama model"
                  >
                    {(ollamaModels.includes(s.ai.model)
                      ? ollamaModels
                      : [s.ai.model, ...ollamaModels]
                    ).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={s.ai.model}
                    onChange={(e) => updateAi({ model: e.target.value })}
                    placeholder={s.ai.provider === "ollama" ? "llama3.1" : "gpt-4o"}
                    aria-label="Model id"
                    spellCheck={false}
                  />
                )}

                {s.ai.provider === "ollama" && (
                  <p className="settings-hint">
                    {ollamaErr
                      ? "Couldn't reach Ollama — is it running? Start it with `ollama serve`, then Refresh. You can also type a model name manually."
                      : "Runs entirely on this Mac — no API key, no per-token cost. Tool use (running commands/SQL) needs a tool-capable model such as llama3.1, qwen2.5, or mistral-nemo."}
                  </p>
                )}

                {s.ai.provider === "openai" && (
                  <>
                    <div className="settings-label">API base URL</div>
                    <input
                      value={s.ai.openaiBaseUrl}
                      onChange={(e) => updateAi({ openaiBaseUrl: e.target.value })}
                      placeholder="https://api.openai.com/v1"
                      aria-label="OpenAI-compatible base URL"
                      spellCheck={false}
                    />
                    <p className="settings-hint">
                      Any OpenAI-compatible endpoint — OpenAI, Azure OpenAI, or a
                      self-hosted server.
                    </p>
                  </>
                )}

                {s.ai.provider !== "ollama" && (
                  <>
                <div className="settings-label">
                  API key {keySaved && <small>· saved in keychain</small>}
                </div>
                <div className="form-row">
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder={
                      keySaved
                        ? "•••••••• — paste a new key to replace"
                        : s.ai.provider === "anthropic"
                          ? "sk-ant-…"
                          : "sk-…"
                    }
                    aria-label="API key"
                    autoComplete="off"
                    spellCheck={false}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveKey();
                    }}
                  />
                  <button onClick={saveKey} disabled={keyBusy || !keyInput.trim()}>
                    Save
                  </button>
                  {keySaved && (
                    <button className="ghost" onClick={clearKey} disabled={keyBusy}>
                      Clear
                    </button>
                  )}
                </div>
                <p className="settings-hint">
                  Paste your own {s.ai.provider === "anthropic" ? "Anthropic" : "provider"}{" "}
                  API key. It’s written straight to the OS keychain — never shown again or
                  sent anywhere except{" "}
                  {s.ai.provider === "anthropic" ? "api.anthropic.com" : "the base URL above"}.
                </p>
                  </>
                )}

                <div className="settings-label">Command autonomy</div>
                <div className="fontsize-row">
                  <button
                    className={"pill-toggle" + (s.ai.autoRunReadOnly ? " on" : "")}
                    onClick={() => updateAi({ autoRunReadOnly: !s.ai.autoRunReadOnly })}
                  >
                    Auto-run read-only commands · {s.ai.autoRunReadOnly ? "On" : "Off"}
                  </button>
                </div>
                <p className="settings-hint">
                  When on, commands the assistant classifies as read-only (ls, cat, df, ps,
                  systemctl status, …) run without asking; anything that could change the
                  server always needs your approval. Turn off to approve every command.
                </p>
              </>
            )}

            {/* Privacy ---------------------------------------------------- */}
            {tab === "privacy" && (
              <>
                <div className="settings-label">Blur sensitive info</div>
                <div className="fontsize-row">
                  <button
                    className={"pill-toggle" + (privacy ? " on" : "")}
                    onClick={() => onPrivacyChange(!privacy)}
                  >
                    Blur sensitive info · {privacy ? "On" : "Off"}
                  </button>
                </div>
                <p className="settings-hint">
                  Blurs sensitive info for screen-sharing. Toggle with ⌘/Ctrl+⇧+. or the
                  eye in the top bar; hover any blurred item to reveal it. Visual only —
                  not encryption.
                </p>
                <div className="privacy-opts">
                  {PRIVACY_SECTIONS.map((sec) => (
                    <label key={sec.id} className="privacy-opt check-row" title={sec.hint}>
                      <input
                        type="checkbox"
                        checked={s.privacy[sec.id]}
                        onChange={() =>
                          update({ privacy: { ...s.privacy, [sec.id]: !s.privacy[sec.id] } })
                        }
                      />
                      <span className="privacy-opt-label">{sec.label}</span>
                      <span className="privacy-opt-hint">{sec.hint}</span>
                    </label>
                  ))}
                </div>

                <div className="settings-label">Blur text patterns</div>
                <textarea
                  className="privacy-patterns"
                  rows={2}
                  spellCheck={false}
                  placeholder="*.*.*.*"
                  value={s.privacyPatterns.join("\n")}
                  onChange={(e) => update({ privacyPatterns: e.target.value.split("\n") })}
                />
                <p className="settings-hint">
                  One glob per line. <code>*</code> matches a word/number segment — e.g.{" "}
                  <code>*.*.*.*</code> blurs IP addresses. Matches blur wherever they
                  appear as a label, even in shown sections.
                </p>
              </>
            )}

            {/* Security --------------------------------------------------- */}
            {tab === "security" && (
              <>
                <div className="settings-label">App lock</div>
                <div className="fontsize-row">
                  <button
                    className={"pill-toggle" + (s.appLock ? " on" : "")}
                    onClick={() => update({ appLock: !s.appLock })}
                  >
                    Biometric app lock · {s.appLock ? "On" : "Off"}
                  </button>
                </div>
                <p className="settings-hint">
                  Require Face ID / fingerprint / device PIN to open the app on mobile.
                  Off by default; desktop is unaffected. Takes effect on next launch.
                </p>

                {isDesktop && <IdleLockSettings minutes={s.idleLockMinutes} onMinutes={(m) => update({ idleLockMinutes: m })} />}

                <div className="settings-label">SSH host keys</div>
                <div className="fontsize-row">
                  <button
                    className={"pill-toggle" + (s.askNewHosts ? " on" : "")}
                    onClick={() => update({ askNewHosts: !s.askNewHosts })}
                  >
                    Ask before trusting new hosts · {s.askNewHosts ? "On" : "Off"}
                  </button>
                </div>
                <p className="settings-hint">
                  On: the first connect to a server shows its fingerprint and waits for
                  you to accept. Off: it is pinned automatically (trust on first use). A
                  key that <b>changes</b> is always refused.
                </p>

                <KnownHostsSection />

                {/* Updates — desktop direct-download builds only. */}
                {updaterEnabled && isDesktop && (
                  <>
                    <div className="settings-label">Updates</div>
                    <div className="fontsize-row">
                      <button
                        className={"pill-toggle" + (s.autoUpdate ? " on" : "")}
                        onClick={() => update({ autoUpdate: !s.autoUpdate })}
                      >
                        Check for updates on launch · {s.autoUpdate ? "On" : "Off"}
                      </button>
                    </div>
                    <p className="settings-hint">
                      On launch, quietly check GitHub for a newer release and show an
                      “Update” button in the top bar. It never installs on its own — you
                      choose when to download. You can always check manually in About.
                    </p>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        <div className="form-row end">
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function IdleLockSettings({ minutes, onMinutes }: { minutes: number; onMinutes: (m: number) => void }) {
  const [osOk, setOsOk] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  const [pinEdit, setPinEdit] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    idleLockApi.osAvailable().then(setOsOk);
    idleLockApi.pinExists().then(setHasPin);
  }, []);
  const canLock = osOk || hasPin;
  async function savePin() {
    setMsg("");
    try {
      await idleLockApi.pinSet(pinEdit || null);
      setHasPin(!!pinEdit);
      setPinEdit(null);
      setMsg(pinEdit ? "PIN saved." : "PIN removed.");
    } catch (e) {
      setMsg(String(e));
    }
  }
  return (
    <>
      <div className="settings-label">Idle lock (desktop)</div>
      <div className="fontsize-row">
        {[0, 5, 15, 30, 60].map((m) => (
          <button
            key={m}
            className={"pill-toggle" + (minutes === m ? " on" : "")}
            disabled={m > 0 && !canLock}
            onClick={() => onMinutes(m)}
          >
            {m === 0 ? "Off" : `${m} min`}
          </button>
        ))}
      </div>
      <div className="fontsize-row">
        {pinEdit === null ? (
          <>
            <button className="pill-toggle" onClick={() => setPinEdit("")}>
              {hasPin ? "Change PIN" : "Set a PIN"}
            </button>
            {hasPin && (
              <button
                className="pill-toggle"
                onClick={async () => {
                  await idleLockApi.pinSet(null);
                  setHasPin(false);
                  if (!osOk) onMinutes(0);
                  setMsg("PIN removed.");
                }}
              >
                Remove PIN
              </button>
            )}
          </>
        ) : (
          <form
            className="idle-lock-pin"
            onSubmit={(e) => {
              e.preventDefault();
              savePin();
            }}
          >
            <input
              type="password"
              autoFocus
              placeholder="New PIN (4+ characters)"
              value={pinEdit}
              onChange={(e) => setPinEdit(e.target.value)}
              autoComplete="new-password"
            />
            <button type="submit" className="primary" disabled={pinEdit.length < 4}>
              Save
            </button>
            <button type="button" className="ghost" onClick={() => setPinEdit(null)}>
              Cancel
            </button>
          </form>
        )}
      </div>
      <p className="settings-hint">
        Covers the app after this long without mouse or keyboard input — connections, exports and
        transfers keep running underneath. Unlock with{" "}
        {osOk ? "Touch ID or your login password" : "your PIN"}
        {osOk && hasPin ? ", or your PIN" : ""}. The PIN is stored as a hash in the system keychain.
        {!canLock && " Set a PIN first to turn it on."}
        {msg && <b> {msg}</b>}
      </p>
    </>
  );
}
