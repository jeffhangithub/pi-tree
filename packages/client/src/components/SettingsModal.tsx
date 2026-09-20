import { useEffect, useState } from "react";
import { X, Loader2, Save, Check, Info, Server, GitBranch, BookOpen, Zap, AlertCircle, KeyRound, Languages } from "lucide-react";
import { fetchModels, fetchSettings, saveSettings, fetchDictPrompt, saveDictPrompt, testModelConnection, REPLY_LANGUAGES, REPLY_LANGUAGE_LABELS, type ReplyLanguage } from "../api";
import type { ModelInfo, ProviderInfo, SettingsInfo } from "../api";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { getBranchesCollapsed, setBranchesCollapsed as saveBranchesCollapsed } from "../utils/preferences";
import "./SettingsModal.css";

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [branchesCollapsed, setBranchesCollapsed] = useState(getBranchesCollapsed);

  // Model selection state
  const [readingModel, setReadingModel] = useState("");
  const [lookupModel, setLookupModel] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [testState, setTestState] = useState<
    Record<string, { status: "testing" | "ok" | "error"; message: string }>
  >({});

  // Provider / API key state (GET/PUT /api/settings)
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [provider, setProvider] = useState("");
  const [customProvider, setCustomProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [replyLanguage, setReplyLanguage] = useState<ReplyLanguage>("follow");

  // Dictionary prompt state
  const [dictPrompt, setDictPrompt] = useState("");
  const [dictPromptLoading, setDictPromptLoading] = useState(true);
  const [dictPromptSaving, setDictPromptSaving] = useState(false);
  const [dictPromptCustom, setDictPromptCustom] = useState(false);
  const [dictPromptDefault, setDictPromptDefault] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const [modelsData, settingsData] = await Promise.all([
          fetchModels(),
          fetchSettings(),
        ]);
        setModels(modelsData.models);
        setProviders(modelsData.providers ?? []);
        setSettings(settingsData);
        setProvider(settingsData.provider || "deepseek");
        setBaseUrl(settingsData.baseUrl ?? "");
        setReadingModel(settingsData.readingModel || modelsData.currentModel || "");
        setLookupModel(settingsData.lookupModel || "");
        setReplyLanguage(settingsData.replyLanguage ?? "follow");
        // Load dictionary prompt template
        try {
          const promptData = await fetchDictPrompt();
          setDictPrompt(promptData.template);
          setDictPromptCustom(promptData.isCustom);
          setDictPromptDefault(promptData.defaultTemplate);
        } catch {
          // Non-critical — dict prompt is optional
        }
        setDictPromptLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load configuration");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);

    const effectiveProvider = (provider === "__custom__" ? customProvider : provider).trim();
    if (!effectiveProvider) {
      setError("Please select a provider");
      setSaving(false);
      return;
    }
    if (!readingModel) {
      setError("Please select a reading model");
      setSaving(false);
      return;
    }

    try {
      // API key: explicit Clear → ""; typed value → save; blank → echo the
      // current masked value so the server keeps the stored key.
      const apiKeyToSend = clearKey
        ? ""
        : apiKey.trim()
          ? apiKey.trim()
          : settings?.apiKeyMasked
            ? settings.apiKeyMasked
            : undefined;

      const update: Parameters<typeof saveSettings>[0] = {
        provider: effectiveProvider,
        readingModel,
        lookupModel: lookupModel || readingModel,
        replyLanguage,
      };
      if (apiKeyToSend !== undefined) update.apiKey = apiKeyToSend;
      if (baseUrl.trim() !== (settings?.baseUrl ?? "")) {
        update.baseUrl = baseUrl.trim();
      }

      const result = await saveSettings(update);
      setSettings(result.settings);
      setProvider(result.settings.provider || "deepseek");
      setBaseUrl(result.settings.baseUrl ?? "");
      setApiKey("");
      setClearKey(false);
      setReadingModel(result.settings.readingModel);
      setLookupModel(result.settings.lookupModel);
      setReplyLanguage(result.settings.replyLanguage ?? "follow");

      // Refresh the model list so the new provider's models appear.
      const modelsData = await fetchModels();
      setModels(modelsData.models);
      setProviders(modelsData.providers ?? []);

      setSuccess(true);
      setTimeout(() => setSuccess(false), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Group models by provider for the dropdown
  const modelsByProvider = models.reduce<Record<string, ModelInfo[]>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});

  // Provider dropdown candidates: SDK built-ins ∪ models.json providers ∪
  // the currently selected one (so a custom provider stays selectable).
  const providerOptions = [
    ...new Set([
      ...(settings?.builtInProviders ?? []),
      ...(settings?.providers.map((p) => p.name) ?? []),
      ...(provider && provider !== "__custom__" ? [provider] : []),
    ]),
  ].sort();

  const handleTestConnection = async (id: string, model: string) => {
    if (!model) return;
    setTestState((s) => ({ ...s, [id]: { status: "testing", message: "" } }));
    const result = await testModelConnection(model);
    setTestState((s) => ({
      ...s,
      [id]: result.ok
        ? {
            status: "ok",
            message: `Connected${result.latencyMs != null ? ` · ${(result.latencyMs / 1000).toFixed(1)}s` : ""}`,
          }
        : { status: "error", message: result.error || "Connection failed" },
    }));
  };

  const renderModelSelect = (
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    helpText: string,
  ) => {
    const test = testState[id];
    return (
      <div className="form-group">
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            // A test result is only valid for the model it ran against
            setTestState((s) => {
              const rest = { ...s };
              delete rest[id];
              return rest;
            });
          }}
        >
          {!value && <option value="">Select a model…</option>}
          {Object.entries(modelsByProvider).map(([provider, pModels]) => (
            <optgroup key={provider} label={provider}>
              {pModels.map((m) => (
                <option key={`${m.provider}-${m.id}`} value={m.id}>
                  {m.name}{m.reasoning ? " ✦" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <div className="model-test-row">
          <p className="form-help">{helpText}</p>
          <div className="model-test-controls">
            {test?.status === "ok" && (
              <span className="test-result test-result-ok" title={test.message}>
                <Check size={12} /> {test.message}
              </span>
            )}
            {test?.status === "error" && (
              <span className="test-result test-result-error" title={test.message}>
                <AlertCircle size={12} /> {test.message}
              </span>
            )}
            <button
              type="button"
              className="test-connection-btn"
              disabled={!value || test?.status === "testing"}
              onClick={() => handleTestConnection(id, value)}
            >
              {test?.status === "testing" ? (
                <><Loader2 size={12} className="spinner" /> Testing…</>
              ) : (
                <><Zap size={12} /> Test Connection</>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <button className="settings-close" onClick={onClose} aria-label="Close settings">
          <X size={16} />
        </button>

        <div className="settings-header">
          <h2>Settings</h2>
          <p>Appearance and default AI model.</p>
        </div>

        {/* ── Appearance section (client-only, no loading gate) ── */}
        <div className="settings-section">
          <h3 className="settings-section-title">Theme</h3>
          <ThemeSwitcher variant="grid" />
        </div>

        <div className="settings-divider" />

        {/* ── Chat section ── */}
        <div className="settings-section">
          <h3 className="settings-section-title">
            <GitBranch size={16} />
            Branch Previews
          </h3>
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <p>When collapsed, branch previews show only the header. When expanded, a preview of the conversation is shown inline.</p>
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={!branchesCollapsed}
                onChange={() => {
                  const next = !branchesCollapsed;
                  setBranchesCollapsed(next);
                  saveBranchesCollapsed(next);
                }}
              />
              <span className="toggle-slider" />
              <span className="toggle-label">{branchesCollapsed ? "Collapsed" : "Expanded"}</span>
            </label>
          </div>
        </div>

        <div className="settings-divider" />

        {/* ── Dictionary prompt section ── */}
        <div className="settings-section">
          <h3 className="settings-section-title">
            <BookOpen size={16} />
            Dictionary Prompt
          </h3>
          <div className="form-group">
            <label htmlFor="dict-prompt-template">Lookup prompt template</label>
            <textarea
              id="dict-prompt-template"
              value={dictPrompt}
              onChange={(e) => setDictPrompt(e.target.value)}
              rows={8}
              disabled={dictPromptLoading}
            />
            <p className="form-help">
              Placeholders: <code>{"{{term}}"}</code>, <code>{"{{context}}"}</code>, <code>{"{{bookTitle}}"}</code>, <code>{"{{#context}}...{{/context}}"}</code> (conditional block).
            </p>
            <div className="dict-prompt-actions">
              {(dictPromptCustom || dictPrompt.trim() !== dictPromptDefault.trim()) && (
                <button
                  type="button"
                  className="reset-link"
                  onClick={async () => {
                    try {
                      setDictPromptSaving(true);
                      const result = await saveDictPrompt('global', null);
                      setDictPrompt(result.defaultTemplate);
                      setDictPromptCustom(result.isCustom);
                      setDictPromptDefault(result.defaultTemplate);
                    } finally {
                      setDictPromptSaving(false);
                    }
                  }}
                  disabled={dictPromptSaving}
                >
                  Reset to Default
                </button>
              )}
              <button
                type="button"
                className="save-prompt-btn"
                disabled={dictPromptSaving || dictPromptLoading}
                onClick={async () => {
                  try {
                    setDictPromptSaving(true);
                    // If content matches default, save null to remove the override file
                    const templateToSave = dictPrompt.trim() === dictPromptDefault.trim() ? null : dictPrompt.trim();
                    const result = await saveDictPrompt('global', templateToSave);
                    setDictPromptCustom(result.isCustom);
                    setDictPromptDefault(result.defaultTemplate);
                  } catch {
                    // Could add error state here
                  } finally {
                    setDictPromptSaving(false);
                  }
                }}
              >
                {dictPromptSaving ? (
                  <><Loader2 size={12} className="spinner" /> Saving…</>
                ) : (
                  <><Save size={12} /> Save Prompt</>
                )}
              </button>
            </div>
          </div>
        </div>

        <div className="settings-divider" />

        <h3 className="settings-section-title">Model & Provider</h3>

        {loading ? (
          <div className="settings-loading">
            <Loader2 size={32} className="spinner" />
            <p>Loading available models…</p>
          </div>
        ) : (
          <form onSubmit={handleSave} className="settings-form">
            {error && (
              <div className="settings-error-alert">
                <Info size={16} />
                <span>{error}</span>
              </div>
            )}

            {success && (
              <div className="settings-success-alert">
                <Check size={16} />
                <span>Configuration saved. New sessions will use it.</span>
              </div>
            )}

            {/* ── Provider & API Key ── */}
            <div className="settings-subsection">
              <h4 className="settings-subsection-title">
                <KeyRound size={14} />
                Provider & API Key
              </h4>

              <div className="form-group">
                <label htmlFor="settings-provider">Provider</label>
                <select
                  id="settings-provider"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                >
                  {!provider && <option value="">Select a provider…</option>}
                  {providerOptions.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                  <option value="__custom__">Custom…</option>
                </select>
                <p className="form-help">
                  The provider your API key belongs to. Defaults to DeepSeek.
                </p>
              </div>

              {provider === "__custom__" && (
                <div className="form-group">
                  <label htmlFor="settings-provider-custom">Provider name</label>
                  <input
                    id="settings-provider-custom"
                    type="text"
                    value={customProvider}
                    onChange={(e) => setCustomProvider(e.target.value)}
                    placeholder="my-provider"
                  />
                </div>
              )}

              <div className="form-group">
                <label htmlFor="settings-api-key">API Key</label>
                <div className="api-key-row">
                  <input
                    id="settings-api-key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      if (e.target.value) setClearKey(false);
                    }}
                    placeholder={settings?.apiKeyMasked || "sk-…"}
                    autoComplete="off"
                  />
                  {settings?.apiKeyMasked && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        setApiKey("");
                        setClearKey(true);
                      }}
                      title="Remove the stored API key"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p className="form-help">
                  {settings?.apiKeyMasked
                    ? `Stored key: ${settings.apiKeyMasked}. Leave blank to keep it, or type a new key.`
                    : "Leave blank to keep the current key, or type a new one."}
                </p>
              </div>

              <div className="form-group">
                <label htmlFor="settings-base-url">Base URL</label>
                <input
                  id="settings-base-url"
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.deepseek.com"
                />
                <p className="form-help">
                  Optional — leave blank to use the provider's built-in default.
                </p>
              </div>
            </div>

            {/* ── Reply language ── */}
            <div className="settings-subsection">
              <h4 className="settings-subsection-title">
                <Languages size={14} />
                Reply Language
              </h4>

              <div className="form-group">
                <label htmlFor="settings-reply-language">Reply language</label>
                <select
                  id="settings-reply-language"
                  value={replyLanguage}
                  onChange={(e) => setReplyLanguage(e.target.value as ReplyLanguage)}
                >
                  {REPLY_LANGUAGES.map((lang) => (
                    <option key={lang} value={lang}>
                      {REPLY_LANGUAGE_LABELS[lang]}
                    </option>
                  ))}
                </select>
                <p className="form-help">
                  Language for AI replies in reading sessions. You can always
                  ask for another language explicitly, and individual sessions
                  can override this from the reading view header.
                </p>
              </div>
            </div>

            {models.length === 0 && (
              <div className="settings-info-box">
                <Info size={16} />
                <p>
                  <strong>No models listed yet.</strong> Fill in your provider and
                  API key above and save — the model list refreshes automatically.
                </p>
              </div>
            )}

            {renderModelSelect(
              "settings-reading-model",
              "Reading Model",
              readingModel,
              setReadingModel,
              "Used for conversations, reading sessions, and analysis.",
            )}

            {renderModelSelect(
              "settings-lookup-model",
              "Lookup Model",
              lookupModel,
              setLookupModel,
              "Used for quick dictionary lookups. Defaults to the reading model if not set.",
            )}

            {/* Provider info */}
            {providers.length > 0 && (
              <div className="settings-provider-info">
                <Server size={14} />
                <div>
                  <span className="settings-provider-label">Providers</span>
                  <div className="settings-provider-list">
                    {providers.map((p) => (
                      <span key={p.name} className="settings-provider-chip">
                        {p.name}
                        <span className="settings-provider-source">{p.source}</span>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="settings-info-box">
              <Info size={16} />
              <p>
                This sets the default model for new sessions. Individual sessions can override the model
                via the model picker in the chat input. Additional providers can be added through the
                Provider & API Key section above.
              </p>
            </div>

            <div className="settings-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 size={16} className="spinner" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Save size={16} />
                    Save
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
