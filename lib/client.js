window.__ModuleLoader__.load({
	id: "@mars-sea/dsh-river-provider",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var __riverClient = (function(exports, react) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	// src/client.tsx
	/**
	* The browser half of the settings page.
	*
	* This bundle runs INSIDE the web client, not in the Host: it may only touch
	* what the client's own module graph exposes (`react`, the locale service, the
	* slot registry, and the Remote gateway). Everything it displays is fetched
	* through the `river` Remote namespace, which is why no key or model list is
	* ever computed here.
	*
	* Two faces are registered:
	*
	* - `settings.models.provider-card` — the river card in Settings → Models,
	*   replacing the "edit cordis.patch.yml" placeholder the kernel shows for a
	*   provider whose layout it does not know.
	* - `settings.section` — a page holding the account list, routing rules and the
	*   per-model capacity table, which do not fit in a provider row.
	*
	* @module dsh-river-provider/client
	*/
	const REMOTE_NAMESPACE = "river";
	const REMOTE_SERVICE = "riverAccounts";
	const REMOTE_PACKAGE = "@mars-sea/dsh-river-provider";
	var WireError = class extends TypeError {};
	function record(value, field) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WireError(`invalid ${field}`);
		return value;
	}
	function text(source, key, field) {
		const value = source[key];
		if (typeof value !== "string") throw new WireError(`invalid ${field}`);
		return value;
	}
	function count(source, key, field) {
		const value = source[key];
		if (typeof value !== "number" || !Number.isFinite(value)) throw new WireError(`invalid ${field}`);
		return value;
	}
	function flag(source, key, field) {
		const value = source[key];
		if (typeof value !== "boolean") throw new WireError(`invalid ${field}`);
		return value;
	}
	function labels(source, key, field) {
		const value = source[key];
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new WireError(`invalid ${field}`);
		return value;
	}
	function effortMap(source, key, field) {
		const value = source[key];
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WireError(`invalid ${field}`);
		const result = {};
		for (const [name, entry] of Object.entries(value)) {
			if (typeof entry !== "string") throw new WireError(`invalid ${field}`);
			result[name] = entry;
		}
		return result;
	}
	const STATUSES = /* @__PURE__ */ new Set([
		"ready",
		"cooldown",
		"disabled",
		"unconfigured"
	]);
	/** Parse the untrusted `river/state` result. */
	function parseSnapshot(value) {
		const source = record(value, "snapshot");
		const accounts = source.accounts;
		const models = source.models;
		const rules = source.modelAccountRules;
		if (!Array.isArray(accounts)) throw new WireError("invalid accounts");
		if (!Array.isArray(models)) throw new WireError("invalid models");
		if (!Array.isArray(rules)) throw new WireError("invalid modelAccountRules");
		const defaults = record(source.defaults, "defaults");
		return {
			provider: text(source, "provider", "provider"),
			apiBase: text(source, "apiBase", "apiBase"),
			accounts: accounts.map((entry) => {
				const account = record(entry, "account");
				const status = text(account, "status", "account.status");
				if (!STATUSES.has(status)) throw new WireError("invalid account.status");
				return {
					id: text(account, "id", "account.id"),
					label: text(account, "label", "account.label"),
					ref: text(account, "ref", "account.ref"),
					configured: flag(account, "configured", "account.configured"),
					active: flag(account, "active", "account.active"),
					status,
					reason: text(account, "reason", "account.reason"),
					cooldownUntil: count(account, "cooldownUntil", "account.cooldownUntil")
				};
			}),
			models: models.map((entry) => {
				const model = record(entry, "model");
				const price = record(model.price, "model.price");
				return {
					id: text(model, "id", "model.id"),
					name: text(model, "name", "model.name"),
					contextWindow: count(model, "contextWindow", "model.contextWindow"),
					maxOutputTokens: count(model, "maxOutputTokens", "model.maxOutputTokens"),
					vision: flag(model, "vision", "model.vision"),
					efforts: labels(model, "efforts", "model.efforts"),
					defaultEffort: text(model, "defaultEffort", "model.defaultEffort"),
					visible: flag(model, "visible", "model.visible"),
					price: {
						input: count(price, "input", "model.price.input"),
						cachedInput: count(price, "cachedInput", "model.price.cachedInput"),
						output: count(price, "output", "model.price.output")
					}
				};
			}),
			defaults: {
				contextWindowLimit: count(defaults, "contextWindowLimit", "defaults.contextWindowLimit"),
				maxOutputTokens: count(defaults, "maxOutputTokens", "defaults.maxOutputTokens"),
				activeAccount: text(defaults, "activeAccount", "defaults.activeAccount"),
				defaultReasoningEffort: effortMap(defaults, "defaultReasoningEffort", "defaults.defaultReasoningEffort")
			},
			modelAccountRules: rules.map((entry) => {
				const rule = record(entry, "rule");
				return {
					models: labels(rule, "models", "rule.models"),
					account: text(rule, "account", "rule.account")
				};
			}),
			ui: { showSettingsSection: flag(record(source.ui, "ui"), "showSettingsSection", "ui.showSettingsSection") }
		};
	}
	function parseEditOutcome(value) {
		const source = record(value, "edit outcome");
		if (!flag(source, "ok", "ok")) return {
			ok: false,
			error: text(source, "error", "error")
		};
		return {
			ok: true,
			snapshot: parseSnapshot(source.snapshot)
		};
	}
	function parseCredentialOutcome(value) {
		const source = record(value, "credential outcome");
		if (!flag(source, "ok", "ok")) return {
			ok: false,
			error: text(source, "error", "error")
		};
		return { ok: true };
	}
	/** The strict codec shape every descriptor here declares. */
	function codec(typeSymbol, parse) {
		return {
			mode: "strict",
			typeSymbol,
			create: () => ({ parse })
		};
	}
	/**
	* One invocation descriptor.
	*
	* The Gateway validates `parameters` against the arguments the carrier sends, so
	* a method that takes an edit declares exactly one wire field named `edit`; the
	* Client calls `river.edit({ field, value })` and the carrier wraps it.
	*/
	function descriptor(method, typeSymbol, resultParse, parameter) {
		return {
			id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
			service: REMOTE_SERVICE,
			namespace: REMOTE_NAMESPACE,
			method,
			invocation: { kind: "direct" },
			parameters: parameter === void 0 ? [] : [{
				name: parameter.name,
				wire: parameter.name,
				source: "json",
				codec: codec(`${typeSymbol}Input`, parameter.parse)
			}],
			result: codec(typeSymbol, resultParse)
		};
	}
	function remoteDescriptors() {
		return [
			descriptor("state", `${REMOTE_PACKAGE}#RiverSnapshot`, parseSnapshot),
			descriptor("refresh", `${REMOTE_PACKAGE}#RiverSnapshot`, parseSnapshot),
			descriptor("edit", `${REMOTE_PACKAGE}#RiverEditOutcome`, parseEditOutcome, {
				name: "edit",
				parse: (value) => {
					const source = record(value, "edit");
					if (typeof source.field !== "string") throw new WireError("invalid edit.field");
					return {
						field: source.field,
						value: source.value
					};
				}
			}),
			descriptor("setAccountKey", `${REMOTE_PACKAGE}#RiverCredentialOutcome`, parseCredentialOutcome, {
				name: "target",
				parse: (value) => {
					const source = record(value, "target");
					return {
						ref: text(source, "ref", "target.ref"),
						key: text(source, "key", "target.key")
					};
				}
			})
		];
	}
	const INITIAL = {
		status: "idle",
		error: "",
		notice: "",
		noticeOk: true,
		saving: false
	};
	/** One shared store, so the card and the page show the same numbers. */
	var RiverStore = class {
		listeners = /* @__PURE__ */ new Set();
		current = INITIAL;
		generation = 0;
		inFlight = false;
		remote;
		disposed = false;
		attach(remote) {
			this.remote = remote;
			this.refresh();
		}
		detach() {
			this.disposed = true;
			this.remote = void 0;
			this.listeners.clear();
		}
		subscribe(listener) {
			this.listeners.add(listener);
			return () => this.listeners.delete(listener);
		}
		state() {
			return this.current;
		}
		publish(next) {
			if (this.disposed) return;
			this.current = next;
			for (const listener of this.listeners) listener();
		}
		message(error) {
			if (error instanceof Error) return error.message;
			return String(error);
		}
		/** Fetch the snapshot; concurrent calls collapse onto the newest request. */
		async refresh() {
			const remote = this.remote;
			if (remote === void 0 || this.inFlight) return;
			const generation = ++this.generation;
			this.inFlight = true;
			this.publish({
				...this.current,
				status: "loading",
				error: ""
			});
			try {
				const response = await remote.state();
				if (this.disposed || generation !== this.generation) return;
				if (response.ok && response.value !== void 0) this.publish({
					...this.current,
					status: "ready",
					snapshot: response.value,
					error: ""
				});
				else this.publish({
					...this.current,
					status: "error",
					error: response.error?.message ?? "the host did not answer"
				});
			} catch (error) {
				if (this.disposed || generation !== this.generation) return;
				this.publish({
					...this.current,
					status: "error",
					error: this.message(error)
				});
			} finally {
				if (generation === this.generation) this.inFlight = false;
			}
		}
		/** Write one setting. The Host answers with the state after the write. */
		async edit(field, value) {
			return this.write(async (remote) => remote.edit({
				field,
				value
			}));
		}
		/** Store one account's key. */
		async setAccountKey(ref, key) {
			return this.write(async (remote) => remote.setAccountKey({
				ref,
				key
			}));
		}
		async write(call) {
			const remote = this.remote;
			if (remote === void 0) return false;
			this.publish({
				...this.current,
				saving: true,
				notice: "",
				noticeOk: true
			});
			try {
				const response = await call(remote);
				if (this.disposed) return false;
				if (!response.ok || response.value === void 0) {
					this.publish({
						...this.current,
						saving: false,
						noticeOk: false,
						notice: response.error?.message ?? "the host refused the write"
					});
					return false;
				}
				if (!response.value.ok) {
					this.publish({
						...this.current,
						saving: false,
						noticeOk: false,
						notice: response.value.error ?? "the host refused the write"
					});
					return false;
				}
				this.publish({
					...this.current,
					saving: false,
					noticeOk: true,
					notice: "",
					...response.value.snapshot === void 0 ? {} : {
						snapshot: response.value.snapshot,
						status: "ready"
					}
				});
				if (response.value.snapshot === void 0) await this.refresh();
				return true;
			} catch (error) {
				if (!this.disposed) this.publish({
					...this.current,
					saving: false,
					noticeOk: false,
					notice: this.message(error)
				});
				return false;
			}
		}
	};
	const store = new RiverStore();
	/** Subscribe a component to the store, with React's tearing-safe snapshot. */
	function useRiver() {
		const [, force] = (0, react.useState)(0);
		(0, react.useEffect)(() => {
			let active = true;
			const unsubscribe = store.subscribe(() => {
				if (active) force((value) => value + 1);
			});
			return () => {
				active = false;
				unsubscribe();
			};
		}, []);
		return store.state();
	}
	/** 1048576 → "1M" — the unit a capacity row is scanned in. */
	function compact(value) {
		if (value >= 1048576) return `${million(value / 1048576)}M`;
		if (value >= 1024) return `${Math.round(value / 1024)}K`;
		return String(value);
	}
	function million(value) {
		return Number.isInteger(value) ? String(value) : value.toFixed(1);
	}
	/** A UTC time as the viewer's clock, in the 24-hour form a cooldown needs. */
	function clock(epoch) {
		const date = new Date(epoch);
		if (Number.isNaN(date.getTime())) return "";
		const pad = (value) => String(value).padStart(2, "0");
		return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	}
	const CSS_ID = "dsh-river-provider:card";
	const CSS = `
.rv-card { display: flex; flex-direction: column; gap: 14px; font-size: 13px; }
.rv-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.rv-title { font-weight: 600; font-size: 14px; }
.rv-sub { color: var(--dsh-text-secondary, #8b8b8b); font-size: 12px; }
.rv-row { display: flex; gap: 10px; align-items: flex-start; }
.rv-field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 0; min-width: 0; }
.rv-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsh-text-secondary, #8b8b8b); }
.rv-input, .rv-select { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; font: inherit;
  border: 1px solid var(--dsh-border, #3a3a3a); background: var(--dsh-input-background, #1f1f1f);
  color: var(--dsh-text, #e6e6e6); }
.rv-input:disabled, .rv-select:disabled { opacity: .55; }
.rv-hint { margin: 0; font-size: 11.5px; color: var(--dsh-text-secondary, #8b8b8b); }
.rv-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.rv-table th { text-align: left; font-weight: 500; color: var(--dsh-text-secondary, #8b8b8b); padding: 4px 6px; }
.rv-table td { padding: 4px 6px; border-top: 1px solid var(--dsh-border, #2e2e2e); vertical-align: middle; }
.rv-table td.rv-num { text-align: right; font-variant-numeric: tabular-nums; }
.rv-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px;
  font-size: 11px; line-height: 18px; border: 1px solid transparent; white-space: nowrap; }
.rv-ok { color: var(--dsh-success, #4ec9a0); border-color: var(--dsh-success, #4ec9a0); }
.rv-bad { color: var(--dsh-danger, #e06c75); border-color: var(--dsh-danger, #e06c75); }
.rv-muted { color: var(--dsh-text-secondary, #8b8b8b); border-color: var(--dsh-border, #3a3a3a); }
.rv-warn { color: var(--dsh-warning, #e5c07b); border-color: var(--dsh-warning, #e5c07b); }
.rv-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: currentColor; }
.rv-notice { margin: 0; font-size: 12px; }
.rv-notice-ok { color: var(--dsh-success, #4ec9a0); }
.rv-notice-bad { color: var(--dsh-danger, #e06c75); }
.rv-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rv-switchRow { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 12px; border: 1px solid var(--dsh-border, #2e2e2e); border-radius: 7px; }
.rv-switchText { display: flex; flex-direction: column; gap: 2px; }
.rv-switch { font: inherit; font-size: 12px; padding: 4px 12px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsh-border, #3a3a3a); background: transparent;
  color: var(--dsh-text-secondary, #8b8b8b); }
.rv-switchOn { border-color: var(--dsh-accent, #4a9eff); color: var(--dsh-accent, #4a9eff);
  background: color-mix(in srgb, var(--dsh-accent, #4a9eff) 14%, transparent); }
.rv-switch:disabled { cursor: default; opacity: .5; }
.rv-button { font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsh-border, #3a3a3a); background: var(--dsh-button-background, #2a2a2a);
  color: var(--dsh-text, #e6e6e6); }
.rv-button:hover:not(:disabled) { border-color: var(--dsh-accent, #4a9eff); }
.rv-button:disabled { cursor: default; opacity: .5; }
.rv-primary { border-color: var(--dsh-accent, #4a9eff); color: var(--dsh-accent, #4a9eff); }
.rv-mono { font-family: var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; }
.rv-section { display: flex; flex-direction: column; gap: 8px; padding-top: 12px;
  border-top: 1px solid var(--dsh-border, #2e2e2e); }
.rv-sectionTitle { font-weight: 600; font-size: 12.5px; }
.rv-empty { font-size: 12px; color: var(--dsh-text-secondary, #8b8b8b); }
`;
	/** Inject the stylesheet once per document. */
	function injectCss() {
		if (typeof document === "undefined") return;
		if (document.getElementById(CSS_ID) !== null) return;
		const style = document.createElement("style");
		style.id = CSS_ID;
		style.textContent = CSS;
		document.head.appendChild(style);
	}
	function Pill({ kind, children }) {
		return (0, react.createElement)("span", { className: `rv-badge rv-${kind}` }, (0, react.createElement)("span", { className: "rv-dot" }), children);
	}
	/** An on/off row. The value comes from the host, so a click is a write. */
	function SwitchRow(props) {
		return (0, react.createElement)("div", { className: "rv-switchRow" }, (0, react.createElement)("div", { className: "rv-switchText" }, (0, react.createElement)("span", { className: "rv-label" }, props.label), (0, react.createElement)("span", { className: "rv-sub" }, props.hint)), (0, react.createElement)("button", {
			type: "button",
			className: `rv-switch${props.value ? " rv-switchOn" : ""}`,
			role: "switch",
			"aria-checked": props.value ? "true" : "false",
			disabled: props.disabled,
			onClick: () => props.onCommit(!props.value)
		}, props.value ? "已开启" : "已关闭"));
	}
	function AccountStatus({ account }) {
		switch (account.status) {
			case "ready": return (0, react.createElement)(Pill, { kind: "ok" }, "可用");
			case "cooldown": return (0, react.createElement)(Pill, { kind: "warn" }, `冷却至 ${clock(account.cooldownUntil)}`);
			case "disabled": return (0, react.createElement)(Pill, { kind: "bad" }, "已停用");
			default: return (0, react.createElement)(Pill, { kind: "muted" }, "未配置");
		}
	}
	/** One labelled text input that writes on blur, so typing never spams the host. */
	function Field(props) {
		const [draft, setDraft] = (0, react.useState)(props.value);
		const focused = (0, react.useRef)(false);
		(0, react.useEffect)(() => {
			if (!focused.current) setDraft(props.value);
		}, [props.value]);
		return (0, react.createElement)("div", { className: "rv-field" }, (0, react.createElement)("label", { className: "rv-label" }, props.label), (0, react.createElement)("input", {
			className: `rv-input${props.mono === true ? " rv-mono" : ""}`,
			value: draft,
			disabled: props.disabled,
			spellCheck: false,
			placeholder: props.placeholder,
			onFocus: () => {
				focused.current = true;
			},
			onChange: (event) => setDraft(event.target.value),
			onBlur: () => {
				focused.current = false;
				const next = draft.trim();
				if (next !== props.value) props.onCommit(next);
			},
			onKeyDown: (event) => {
				if (event.key === "Enter") event.currentTarget.blur();
			}
		}), props.hint === void 0 ? null : (0, react.createElement)("p", { className: "rv-hint" }, props.hint));
	}
	/**
	* The river card, rendered inside the provider row.
	*
	* The Models page renders this INSTEAD of its generic "edit the patch file"
	* editor for a provider with `llm-river` as its settings namespace, so the row
	* carries real controls: the base URL, the active account, the capacity
	* defaults, and a per-model reasoning default.
	*/
	function RiverProviderCard() {
		const state = useRiver();
		const disabled = state.saving || state.status === "loading";
		if (state.status === "error") return (0, react.createElement)("div", { className: "rv-card" }, (0, react.createElement)("div", { className: "rv-head" }, (0, react.createElement)("span", { className: "rv-title" }, "river.ai"), (0, react.createElement)(Pill, { kind: "bad" }, "无法读取宿主状态")), (0, react.createElement)("p", { className: "rv-notice rv-notice-bad" }, state.error ?? "未知错误"), (0, react.createElement)("div", { className: "rv-actions" }, (0, react.createElement)("button", {
			type: "button",
			className: "rv-button",
			onClick: () => void store.refresh()
		}, "重试")));
		if (state.snapshot === void 0) return (0, react.createElement)("div", { className: "rv-card" }, (0, react.createElement)("div", { className: "rv-head" }, (0, react.createElement)("span", { className: "rv-title" }, "river.ai"), (0, react.createElement)("span", { className: "rv-sub" }, "读取中…")));
		const snapshot = state.snapshot;
		const active = snapshot.accounts.find((account) => account.active);
		const ready = snapshot.accounts.filter((account) => account.status === "ready").length;
		const primary = snapshot.models[0];
		return (0, react.createElement)("div", { className: "rv-card" }, (0, react.createElement)("div", { className: "rv-head" }, (0, react.createElement)("span", { className: "rv-title" }, "river.ai"), (0, react.createElement)(Pill, { kind: ready > 0 ? "ok" : "bad" }, `${ready}/${snapshot.accounts.length} 个账号可用`), active === void 0 ? null : (0, react.createElement)(Pill, { kind: "muted" }, `当前 ${active.label}`), (0, react.createElement)("span", { className: "rv-sub" }, `${snapshot.models.length} 个模型`)), (0, react.createElement)("div", { className: "rv-row" }, (0, react.createElement)(Field, {
			label: "接口地址",
			value: snapshot.apiBase,
			mono: true,
			disabled,
			hint: "留空使用 https://api.river.ai/v1",
			onCommit: (value) => void store.edit("apiBase", value)
		}), (0, react.createElement)(Field, {
			label: "当前账号",
			value: snapshot.defaults.activeAccount,
			placeholder: "留空自动选择",
			disabled,
			hint: "固定用某个账号，留空按健康度轮转",
			onCommit: (value) => void store.edit("activeAccount", value)
		})), (0, react.createElement)("div", { className: "rv-row" }, (0, react.createElement)(CapacityField, {
			label: "上下文窗口",
			value: snapshot.defaults.contextWindowLimit,
			ceiling: primary?.contextWindow ?? 0,
			disabled,
			onCommit: (value) => void store.edit("contextWindowLimit", value)
		}), (0, react.createElement)(CapacityField, {
			label: "输出预算",
			value: snapshot.defaults.maxOutputTokens,
			ceiling: primary?.maxOutputTokens ?? 0,
			disabled,
			onCommit: (value) => void store.edit("maxOutputTokens", value)
		})), (0, react.createElement)("div", { className: "rv-section" }, (0, react.createElement)("span", { className: "rv-sectionTitle" }, "各模型推理强度"), (0, react.createElement)("table", { className: "rv-table" }, (0, react.createElement)("thead", {}, (0, react.createElement)("tr", {}, (0, react.createElement)("th", {}, "模型"), (0, react.createElement)("th", {}, "上下文"), (0, react.createElement)("th", {}, "输出"), (0, react.createElement)("th", {}, "推理"))), (0, react.createElement)("tbody", {}, snapshot.models.map((model) => (0, react.createElement)(ModelEffortRow, {
			key: model.id,
			model,
			disabled
		})))), (0, react.createElement)("p", { className: "rv-hint" }, "这里只列出 river 每个模型真正接受的档位；「自动」表示不干预，交给模型默认值。")), (0, react.createElement)("div", { className: "rv-section" }, (0, react.createElement)("span", { className: "rv-sectionTitle" }, "账号"), (0, react.createElement)("table", { className: "rv-table" }, (0, react.createElement)("thead", {}, (0, react.createElement)("tr", {}, (0, react.createElement)("th", {}, "账号"), (0, react.createElement)("th", {}, "凭据引用"), (0, react.createElement)("th", {}, "状态"), (0, react.createElement)("th", {}, ""))), (0, react.createElement)("tbody", {}, snapshot.accounts.map((account) => (0, react.createElement)(AccountRow, {
			key: account.id,
			account,
			disabled
		}))))), (0, react.createElement)(SwitchRow, {
			label: "设置侧栏页面",
			hint: "在设置导航里加一个 river.ai 页（还包含模型可见性与路由）；关掉后本卡片仍可管理账号",
			value: snapshot.ui.showSettingsSection,
			disabled,
			onCommit: (value) => void store.edit("showSettingsSection", value)
		}), state.notice === "" ? null : (0, react.createElement)("p", { className: `rv-notice ${state.noticeOk ? "rv-notice-ok" : "rv-notice-bad"}` }, state.notice), (0, react.createElement)("div", { className: "rv-actions" }, (0, react.createElement)("button", {
			type: "button",
			className: "rv-button",
			disabled,
			onClick: () => void store.refresh()
		}, state.status === "loading" ? "刷新中…" : "刷新"), (0, react.createElement)("span", { className: "rv-sub" }, snapshot.ui.showSettingsSection ? "模型可见性与路由规则在「设置 → river.ai」页" : "模型可见性与路由规则写在 cordis.patch.yml 的 llm-river 段")));
	}
	/** A capacity input with the model ceiling it cannot exceed. */
	function CapacityField(props) {
		const [draft, setDraft] = (0, react.useState)(String(props.value));
		const focused = (0, react.useRef)(false);
		(0, react.useEffect)(() => {
			if (!focused.current) setDraft(String(props.value));
		}, [props.value]);
		return (0, react.createElement)("div", { className: "rv-field" }, (0, react.createElement)("label", { className: "rv-label" }, props.label, (0, react.createElement)("span", { className: "rv-sub" }, `上限 ${compact(props.ceiling)}`)), (0, react.createElement)("input", {
			className: "rv-input rv-mono",
			value: draft,
			disabled: props.disabled,
			inputMode: "numeric",
			onFocus: () => {
				focused.current = true;
			},
			onChange: (event) => setDraft(event.target.value),
			onBlur: () => {
				focused.current = false;
				const parsed = Number(draft.replace(/[^0-9]/g, ""));
				if (!Number.isFinite(parsed) || parsed <= 0) {
					setDraft(String(props.value));
					return;
				}
				const clamped = props.ceiling > 0 ? Math.min(parsed, props.ceiling) : parsed;
				setDraft(String(clamped));
				if (clamped !== props.value) props.onCommit(clamped);
			},
			onKeyDown: (event) => {
				if (event.key === "Enter") event.currentTarget.blur();
			}
		}));
	}
	/** One model's row: the effort select lists only what river accepts. */
	function ModelEffortRow({ model, disabled }) {
		const configured = matchEffort(model.id);
		return (0, react.createElement)("tr", {}, (0, react.createElement)("td", {}, (0, react.createElement)("div", {}, model.name), (0, react.createElement)("div", { className: "rv-hint rv-mono" }, model.id)), (0, react.createElement)("td", { className: "rv-num" }, compact(model.contextWindow)), (0, react.createElement)("td", { className: "rv-num" }, compact(model.maxOutputTokens)), (0, react.createElement)("td", {}, model.efforts.length === 0 ? (0, react.createElement)("span", { className: "rv-hint" }, "不支持推理档位") : (0, react.createElement)("select", {
			className: "rv-select",
			value: configured,
			disabled,
			onChange: (event) => {
				store.edit("defaultReasoningEffort", {
					...currentEffortMap(),
					[model.id]: event.target.value
				});
			}
		}, (0, react.createElement)("option", { value: "auto" }, "自动"), model.efforts.map((effort) => (0, react.createElement)("option", {
			key: effort,
			value: effort
		}, effortLabel(effort))))));
	}
	function currentEffortMap() {
		return store.state().snapshot?.defaults.defaultReasoningEffort ?? {};
	}
	/** The configured effort for one model, honouring the glob rules by precedence. */
	function matchEffort(model) {
		const map = currentEffortMap();
		if (map[model] !== void 0) return map[model];
		for (const [pattern, level] of Object.entries(map)) if (globMatch(pattern, model)) return level;
		return "auto";
	}
	function globMatch(pattern, model) {
		if (pattern === model) return true;
		if (!pattern.includes("*")) return false;
		const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		return new RegExp(`^${escaped.join(".*")}$`).test(model);
	}
	/** Harness vocabulary, spelled the way the picker spells it. */
	function effortLabel(effort) {
		switch (effort) {
			case "off": return "关闭 (off)";
			case "minimal": return "极少 (minimal)";
			case "low": return "低 (low)";
			case "medium": return "中 (medium)";
			case "high": return "高 (high)";
			case "xhigh": return "很高 (xhigh)";
			case "max": return "最大 (max)";
			default: return effort;
		}
	}
	/**
	* The full page: accounts, their keys, routing rules.
	*
	* Kept separate from the card because these are lists the Models page has no
	* room for, and because the card is rendered once per provider row while this
	* page is rendered once.
	*/
	function RiverSettingsPage() {
		const state = useRiver();
		const disabled = state.saving || state.status === "loading";
		if (state.snapshot === void 0) return (0, react.createElement)("div", { className: "rv-card" }, (0, react.createElement)("div", { className: "rv-head" }, (0, react.createElement)("span", { className: "rv-title" }, "river.ai"), (0, react.createElement)("span", { className: "rv-sub" }, state.status === "error" ? state.error ?? "读取失败" : "读取中…")), state.status === "error" ? (0, react.createElement)("div", { className: "rv-actions" }, (0, react.createElement)("button", {
			type: "button",
			className: "rv-button",
			onClick: () => void store.refresh()
		}, "重试")) : null);
		const snapshot = state.snapshot;
		return (0, react.createElement)("div", { className: "rv-card" }, (0, react.createElement)("div", { className: "rv-head" }, (0, react.createElement)("span", { className: "rv-title" }, "river.ai 账号"), (0, react.createElement)("span", { className: "rv-sub" }, "多个 key 自动轮转：429 冷却、401 停用，任一恢复后自动重新参与")), (0, react.createElement)("table", { className: "rv-table" }, (0, react.createElement)("thead", {}, (0, react.createElement)("tr", {}, (0, react.createElement)("th", {}, "账号"), (0, react.createElement)("th", {}, "凭据引用"), (0, react.createElement)("th", {}, "状态"), (0, react.createElement)("th", {}, ""))), (0, react.createElement)("tbody", {}, snapshot.accounts.map((account) => (0, react.createElement)(AccountRow, {
			key: account.id,
			account,
			disabled
		})))), (0, react.createElement)("div", { className: "rv-section" }, (0, react.createElement)("span", { className: "rv-sectionTitle" }, "模型可见性"), (0, react.createElement)("p", { className: "rv-hint" }, "取消勾选后该模型不出现在模型选择器里；一个都不勾表示全部可见。"), (0, react.createElement)("div", { className: "rv-actions" }, snapshot.models.map((model) => (0, react.createElement)("label", {
			key: model.id,
			className: "rv-label",
			style: { marginRight: "12px" }
		}, (0, react.createElement)("input", {
			type: "checkbox",
			checked: model.visible,
			disabled,
			onChange: (event) => {
				const next = {};
				for (const entry of snapshot.models) next[entry.id] = entry.visible;
				next[model.id] = event.target.checked;
				store.edit("modelVisibility", next);
			}
		}), model.name)))), snapshot.modelAccountRules.length === 0 ? null : (0, react.createElement)("div", { className: "rv-section" }, (0, react.createElement)("span", { className: "rv-sectionTitle" }, "模型路由"), (0, react.createElement)("table", { className: "rv-table" }, (0, react.createElement)("thead", {}, (0, react.createElement)("tr", {}, (0, react.createElement)("th", {}, "模型"), (0, react.createElement)("th", {}, "优先账号"))), (0, react.createElement)("tbody", {}, snapshot.modelAccountRules.map((rule, index) => (0, react.createElement)("tr", { key: `${index}` }, (0, react.createElement)("td", { className: "rv-mono" }, rule.models.join(", ")), (0, react.createElement)("td", { className: "rv-mono" }, rule.account)))))), state.notice === "" ? null : (0, react.createElement)("p", { className: `rv-notice ${state.noticeOk ? "rv-notice-ok" : "rv-notice-bad"}` }, state.notice));
	}
	/** One account row: its health, and a field to (re)store its key. */
	function AccountRow({ account, disabled }) {
		const [key, setKey] = (0, react.useState)("");
		const [visible, setVisible] = (0, react.useState)(false);
		const commit = (0, react.useCallback)(() => {
			const trimmed = key.trim();
			if (trimmed === "") return;
			store.setAccountKey(account.ref, trimmed).then((ok) => {
				if (ok) setKey("");
			});
		}, [account.ref, key]);
		return (0, react.createElement)("tr", {}, (0, react.createElement)("td", {}, (0, react.createElement)("div", {}, account.label), account.active ? (0, react.createElement)("span", { className: "rv-hint" }, "当前生效") : null, account.reason === "" ? null : (0, react.createElement)("div", { className: "rv-hint" }, account.reason)), (0, react.createElement)("td", { className: "rv-mono" }, account.ref), (0, react.createElement)("td", {}, (0, react.createElement)(AccountStatus, { account })), (0, react.createElement)("td", {}, (0, react.createElement)("div", { className: "rv-actions" }, (0, react.createElement)("input", {
			className: "rv-input rv-mono",
			type: visible ? "text" : "password",
			value: key,
			disabled,
			spellCheck: false,
			autoComplete: "new-password",
			placeholder: account.configured ? "已配置，粘贴可覆盖" : "粘贴 rv_... 密钥",
			style: { width: "190px" },
			onChange: (event) => setKey(event.target.value),
			onKeyDown: (event) => {
				if (event.key === "Enter") commit();
			}
		}), (0, react.createElement)("button", {
			type: "button",
			className: "rv-button",
			disabled,
			onClick: () => setVisible((value) => !value)
		}, visible ? "隐藏" : "显示"), (0, react.createElement)("button", {
			type: "button",
			className: "rv-button rv-primary",
			disabled: disabled || key.trim() === "",
			onClick: commit
		}, "保存"))));
	}
	/** Mount the Remote contribution and publish the namespace to the store. */
	function connectRemote(ctx) {
		let cancelled = false;
		let unmount;
		ctx.remote.$mount({
			package: REMOTE_PACKAGE,
			descriptors: remoteDescriptors()
		}).then((dispose) => {
			if (cancelled) {
				dispose();
				return;
			}
			unmount = dispose;
			ctx.inject([`remote.${REMOTE_NAMESPACE}`], (namespaceCtx) => {
				const remote = namespaceCtx.get(`remote.${REMOTE_NAMESPACE}`);
				if (remote !== void 0) store.attach(remote);
			});
		}).catch((error) => {
			ctx.logger.warn(`river: could not mount the settings Remote: ${String(error)}`);
		});
		return () => {
			cancelled = true;
			store.detach();
			if (unmount !== void 0) unmount();
		};
	}
	/**
	* Publish the settings page only while the switch is on.
	*
	* The switch is a host setting, so its value is unknown at load time and the
	* registration cannot be unconditional. `slots.inject` is still used for the
	* first registration because registering into a slot nobody declared yet
	* throws; after that the slot exists and the disposer lets the nav entry come
	* and go with the switch.
	*/
	function attachSettingsSection(ctx) {
		let dispose;
		let declared = false;
		let wanted = false;
		const sync = () => {
			if (wanted && declared && dispose === void 0) {
				dispose = ctx.slots.register({
					name: "settings.section",
					id: "river",
					order: 13,
					label: () => "river.ai"
				}, RiverSettingsPage);
				return;
			}
			if (!wanted && dispose !== void 0) {
				dispose();
				dispose = void 0;
			}
		};
		ctx.effect(() => {
			const unsubscribe = store.subscribe(() => {
				const enabled = store.state().snapshot?.ui.showSettingsSection ?? false;
				if (enabled === wanted) return;
				wanted = enabled;
				sync();
			});
			return () => {
				unsubscribe();
				if (dispose !== void 0) {
					dispose();
					dispose = void 0;
				}
			};
		}, "dsh-river-provider: settings page switch");
		try {
			ctx.slots.inject("settings.section", () => {
				declared = true;
				sync();
			});
		} catch (error) {
			ctx.logger.warn(`river: could not watch the settings section slot: ${String(error)}`);
		}
	}
	function apply(ctx) {
		injectCss();
		ctx.effect(() => connectRemote(ctx), "dsh-river-provider: settings Remote");
		ctx.effect(() => () => {
			(typeof document === "undefined" ? null : document.getElementById(CSS_ID))?.remove();
		}, "dsh-river-provider: styles");
		try {
			ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
				name: "settings.models.provider-card",
				key: "llm-river"
			}, RiverProviderCard));
		} catch (error) {
			ctx.logger.warn(`river: could not register the provider card: ${String(error)}`);
		}
		attachSettingsSection(ctx);
	}
	const inject = ["slots", "remote"];
	exports.apply = apply;
	exports.inject = inject;
	return exports;
})({}, require("react"));

		for (const key of Object.keys(__riverClient)) exports[key] = __riverClient[key];
		return module.exports;
	}
});
//# sourceMappingURL=client.js.map
