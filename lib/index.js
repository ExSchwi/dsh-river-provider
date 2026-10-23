import { Context, Service } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { LlmAdapter, LlmError, ProviderRequestId, ReasoningEffortId, ToolCallId, attributionHeaders, fileHandleText, offloadedImageText, requestImageHandleText, textOnlyImageText } from "@deepseek-ai/dsh-llm";
// src/capabilities.ts
/**
* Adapts river's model catalog to the shapes a request needs.
*
* Every number here is documented in river's model pages; the static table is a
* snapshot, not a guess, and `KNOWN_MODELS` is the single place to edit when
* river ships a model. Anything river serves that this table has not learned yet
* still works: the unknown-model fallback keeps the full documented context
* window, offers no reasoning effort it cannot verify, and uses a small output
* budget, so an unknown model produces a correct request instead of a 400.
*
* @module dsh-river-provider/capabilities
*/
/**
* Context window shared by every model river currently serves.
*
* One constant rather than a per-model field: river documents 1,048,576 for the
* whole catalog, and a per-model copy would drift on the first model that
* differs. A model with a smaller window is an explicit override below.
*/
const RIVER_CONTEXT_WINDOW = 1048576;
/**
* The static snapshot of river's catalog.
*
* Reasoning efforts are NOT uniform and this is the bug the upstream plugin
* shipped: DeepSeek-V4.1-Flash accepts `none|high|max` and rejects `low`, while
* GLM-5.3-Flash accepts `low|high|max` and rejects `none`. Forwarding a harness
* effort verbatim across that boundary is an instant 400.
*/
const KNOWN_MODELS = {
	"deepseek-ai/DeepSeek-V4.1-Flash-1017": {
		contextWindow: RIVER_CONTEXT_WINDOW,
		maxOutputTokens: 384e3,
		vision: true,
		efforts: [
			"off",
			"high",
			"max"
		],
		defaultEffort: "high",
		price: {
			input: .12,
			cachedInput: .0024,
			output: .48
		},
		reasoningStyle: "leading"
	},
	"deepseek-ai/DeepSeek-V4.1-Flash": {
		contextWindow: RIVER_CONTEXT_WINDOW,
		maxOutputTokens: 384e3,
		vision: true,
		efforts: [
			"off",
			"high",
			"max"
		],
		defaultEffort: "high",
		price: {
			input: .12,
			cachedInput: .0024,
			output: .48
		},
		reasoningStyle: "leading"
	},
	"zai-org/GLM-5.3-Flash": {
		contextWindow: RIVER_CONTEXT_WINDOW,
		maxOutputTokens: 128e3,
		vision: true,
		efforts: [
			"low",
			"high",
			"max"
		],
		defaultEffort: "high",
		price: {
			input: .12,
			cachedInput: .024,
			output: .4
		},
		reasoningStyle: "interleaved"
	},
	"nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4": {
		contextWindow: RIVER_CONTEXT_WINDOW,
		maxOutputTokens: 128e3,
		vision: true,
		efforts: [],
		price: {
			input: .07,
			cachedInput: .024,
			output: .37
		},
		reasoningStyle: "leading"
	}
};
/**
* Facts for a model the snapshot has not seen.
*
* `contextWindow` is the full 1M every river model publishes, not a smaller
* placeholder: the harness derives its usage meter, compaction thresholds and
* reference-file budget from this number, and under-reporting it makes the
* assistant compact early and throw away room the operator already paid for.
* A model that genuinely ships a smaller window only needs its entry added
* below.
*
* The output ceiling stays conservative: an over-large `max_tokens` is a hard
* 400 that no retry fixes, while a small one is raised by configuration. No
* reasoning means no `reasoning_effort` is sent, which every river model
* accepts.
*/
const UNKNOWN_MODEL_FACTS = {
	contextWindow: RIVER_CONTEXT_WINDOW,
	maxOutputTokens: 32768,
	vision: true,
	efforts: [],
	price: {
		input: 0,
		cachedInput: 0,
		output: 0
	},
	reasoningStyle: "leading"
};
/** Facts for one model id, falling back to the conservative defaults. */
function modelFacts(model) {
	const exact = KNOWN_MODELS[model];
	if (exact !== void 0) return exact;
	const tail = model.slice(model.lastIndexOf("/") + 1);
	for (const [id, facts] of Object.entries(KNOWN_MODELS)) if (id.slice(id.lastIndexOf("/") + 1) === tail) return facts;
	return UNKNOWN_MODEL_FACTS;
}
/** A display name for the model picker. */
function displayName(model) {
	if (KNOWN_MODELS[model] !== void 0) return model.slice(model.lastIndexOf("/") + 1);
	const tail = model.slice(model.lastIndexOf("/") + 1);
	return tail === "" ? model : tail;
}
/**
* The largest output budget any snapshot model allows.
*
* The settings form needs one number to show when nothing is configured. It is
* the ceiling rather than a conservative middle: a configured budget is a
* REQUEST, and river rejects one above a model's limit, so the honest default is
* the highest figure the catalog states — with the per-model table beside it
* holding the rest of the truth.
*/
function knownMaxOutputTokens() {
	let largest = 0;
	for (const facts of Object.values(KNOWN_MODELS)) if (facts.maxOutputTokens > largest) largest = facts.maxOutputTokens;
	return largest;
}
/** The reasoning efforts to offer for one model, in harness order. */
function reasoningEffortsFor(model) {
	return modelFacts(model).efforts.map((id) => {
		const effort = {
			id: ReasoningEffortId(id),
			name: effortName(id)
		};
		const description = effortDescription(id);
		if (description !== void 0) effort.description = description;
		return effort;
	});
}
/** Human names for effort levels. */
function effortName(id) {
	switch (id) {
		case "off": return "Off";
		case "minimal": return "Minimal";
		case "low": return "Low";
		case "medium": return "Medium";
		case "high": return "High";
		case "xhigh": return "Extra high";
		case "max": return "Maximum";
		default: return id;
	}
}
/** Explanations shown next to each effort. */
function effortDescription(id) {
	switch (id) {
		case "off": return "Answer directly; no reasoning is requested.";
		case "low": return "Short reasoning pass.";
		case "high": return "Default reasoning budget.";
		case "max": return "Longest reasoning budget; billed as output.";
		default: return;
	}
}
/** The harness's ordered effort ladder, used to snap an unsupported value. */
const EFFORT_LADDER = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* Normalize a requested effort onto the harness's own level ids.
*
* The ids this reports are the HARNESS vocabulary (`off|minimal|low|medium|
* high|xhigh|max`), not river's wire values, because the ids travel to the
* model picker and the settings form: an id outside that list has no label
* there, so the UI falls back to printing the raw id. Older harness spellings
* and river's own words are accepted on input and folded onto the ladder.
*/
function canonicalEffort(requested) {
	switch (requested) {
		case "none": return "off";
		case "null": return "off";
		case "minimal": return "minimal";
		case "extra-high": return "xhigh";
		case "ultra":
		case "maximum": return "max";
		default: return requested;
	}
}
/**
* Translate a requested effort into one the model actually accepts.
*
* An accepted value passes through untouched. Anything else moves to the
* nearest supported level, choosing the CHEAPER direction on a tie.
*
* The tie-break is a cost decision, not cosmetics: a caller asking for `low` on
* a DeepSeek model (which accepts only `off|high|max`) is one step from both
* `off` and `high`, and rounding UP spends real reasoning tokens on a level the
* caller did not ask for. Rounded down, the request is cheaper and still close.
* Ties compare rank on {@link EFFORT_LADDER}, which orders the vocabulary from
* least to most expensive.
*
* @returns an accepted effort, or undefined when the model has none.
*/
function translateEffort(model, requested) {
	const facts = modelFacts(model);
	if (facts.efforts.length === 0) return void 0;
	if (requested === void 0) return facts.defaultEffort;
	const wanted = canonicalEffort(requested);
	if (facts.efforts.includes(wanted)) return wanted;
	const targetRank = EFFORT_LADDER.indexOf(wanted);
	if (targetRank < 0) return facts.defaultEffort;
	let best;
	for (const effort of facts.efforts) {
		const rank = EFFORT_LADDER.indexOf(effort);
		if (rank < 0) continue;
		const distance = Math.abs(rank - targetRank);
		if (best === void 0 || distance < best.distance || distance === best.distance && rank < best.rank) best = {
			effort,
			distance,
			rank
		};
	}
	return best?.effort ?? facts.defaultEffort;
}
/**
* The `reasoning_effort` value to put on the wire, or undefined for none.
*
* `off` means "do not reason", and the field is then OMITTED rather than sent as
* the string `"none"`: river spells that choice per model (DeepSeek accepts
* `none`), and an ABSENT field is understood identically by every route and by
* any OpenAI-compatible gateway in front of it.
*/
function wireEffort(model, requested) {
	const resolved = translateEffort(model, requested);
	if (resolved === void 0 || resolved === "off") return void 0;
	return resolved;
}
/**
* Clamp a provider capacity to a configured ceiling.
*
* A ceiling may only LOWER a capacity: river would answer 400 for a
* `max_tokens` above the model's own maximum, so a configured 400000 on a
* 128000-output model must resolve to 128000 rather than fail every turn.
*
* `undefined`, zero and negative ceilings mean "no ceiling": the settings form
* shows an empty number field as absent, and a `0` typed into it reads as
* "leave this alone" rather than "disable the model".
*/
function clampCeiling(offered, ceiling) {
	if (ceiling === void 0 || !Number.isFinite(ceiling) || ceiling <= 0) return offered;
	return Math.min(Math.floor(ceiling), offered);
}
/**
* The configured default effort for one model, validated against the model's
* own whitelist.
*
* The per-model map is deliberately the only source (no global default): a
* model river ships tomorrow keeps ITS OWN default until someone names it,
* instead of silently inheriting a choice made for a different model.
*
* A configured value is NEVER snapped. Snapping is right for a request the
* harness generates at runtime (it must produce something), but wrong for a
* setting: a mistyped `low` on a DeepSeek model would silently become `none` or
* `high` and change both what the model does and what it costs, every turn,
* with nothing to notice. A rejected value surfaces instead, and configuration
* is a slow variable that gets corrected once.
*
* @throws RangeError when the configured value is not one the model accepts.
* @returns an accepted effort, or undefined when the model has no reasoning.
*/
function configuredEffort(model, overrides) {
	const wanted = overrideFor(model, overrides);
	if (wanted === void 0) return void 0;
	if (wanted === "" || wanted === "auto") return void 0;
	const facts = modelFacts(model);
	if (facts.efforts.length === 0) throw new RangeError(`${model} has no reasoning support, but defaultReasoningEffort sets "${wanted}".`);
	if (!facts.efforts.includes(wanted)) throw new RangeError(`${model} accepts only ${facts.efforts.join("|")} for reasoning_effort, not "${wanted}".`);
	return wanted;
}
/**
* Look one model up in an override map, accepting a glob on the model id.
*
* An exact id wins over a pattern, so a specific pin cannot be shadowed by a
* family wildcard. Patterns are matched segment-wise (`*` and `?`), which is
* how a model id is spelled: `zai-org/GLM-*` names one family without also
* matching an unrelated id that merely contains the text.
*/
function overrideFor(model, overrides) {
	if (overrides === void 0) return void 0;
	const exact = overrides[model];
	if (exact !== void 0) return exact;
	for (const [pattern, value] of Object.entries(overrides)) {
		if (value === void 0) continue;
		if (pattern.includes("*") || pattern.includes("?")) {
			if (matchesPattern(model, pattern)) return value;
			continue;
		}
	}
}
/** Segment-wise glob match, where `*` and `?` never cross a `/`. */
function matchesPattern(model, pattern) {
	const regex = pattern.split("/").map((segment) => segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("/");
	return new RegExp(`^${regex}$`).test(model);
}
/**
* The cheapest effort a model accepts.
*
* Used for machine-shaped calls (session titles, compaction) where reasoning
* would be paid for and never read. A model with no `none` (GLM) gets its
* lowest level instead of an invalid `none`.
*/
function titleEffort(model) {
	const facts = modelFacts(model);
	if (facts.efforts.length === 0) return void 0;
	if (facts.efforts.includes("off")) return "off";
	return facts.efforts[0];
}
/**
* The context window to report for one model, optionally capped by settings.
*
* Only the ADVERTISED capacity is capped. The request body never carries a
* context window, so this number reaches exactly three consumers: the harness's
* usage meter, compaction pressure thresholds, and the reference-file budget.
* Lowering it is how a 1M-token route is kept to a budget the operator actually
* wants to pay for; raising it is impossible, because the model would truncate
* what the meter believed fitted.
*/
function contextWindowFor(model, ceiling) {
	return clampCeiling(modelFacts(model).contextWindow, ceiling);
}
/**
* The output budget to report and request for one model.
*
* `min(configured, model)` and never above the model: this value becomes the
* request's `max_tokens`, and river rejects an over-large one with a 400. It is
* also the harness's `reservedCompletionTokens` during compaction, which is why
* the reported context window must stay above it — see the settings docs.
*/
function outputBudgetFor(model, ceiling) {
	return clampCeiling(modelFacts(model).maxOutputTokens, ceiling);
}
// src/accounts.ts
/**
* How long the retry layer will wait for a single retry.
*
* MUST equal the adapter's `backoff.maxDelayMs`: a longer `Retry-After` is
* discarded by the harness's retry layer, which then hammers a throttled
* account instead of honouring river's advice. Kept here because the pool is
* what computes the wait.
*/
const RETRY_MAX_DELAY_MS = 9e5;
/** How long a key must stay clean before a NEW mark is overwritten. */
const STATE_TTL_MS = 864e5;
/** The error raised when every account is unusable. */
var AllAccountsUnusableError = class extends Error {
	code;
	retryAfterMs;
	constructor(message, code, retryAfterMs) {
		super(message);
		this.code = code;
		this.retryAfterMs = retryAfterMs;
		this.name = "AllAccountsUnusableError";
	}
};
/** Whether a key may be attempted now. */
function accountUsable(state, now = Date.now()) {
	if (state === void 0) return true;
	if (state.kind === "cooldown") return state.until > 0 && now >= state.until;
	return false;
}
/** Trim a key for use as a map key; empty becomes undefined. */
function normalizeKey(value) {
	if (value === void 0) return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
/**
* Resolve configured slots to keys.
*
* Two slots may point at the same env var after a settings edit; the pool
* deduplicates by key so one physical account is never counted twice (which
* would make "all accounts exhausted" wrong and waste a rotation).
*/
async function resolveAccounts(options) {
	const seen = /* @__PURE__ */ new Set();
	const accounts = [];
	for (const slot of options.slots()) {
		const key = normalizeKey(slot.literal) ?? normalizeKey(await options.resolveRef(slot.ref));
		if (key === void 0) continue;
		if (seen.has(key)) continue;
		seen.add(key);
		accounts.push({
			slot,
			key,
			state: void 0
		});
	}
	return accounts;
}
/**
* The account a model is routed to, if a rule matches.
*
* The rule's target is resolved by id first and by credential ref second, so a
* rule survives a user renaming the label but keeps working when the rules were
* written against the env var (which is the id for a non-default slot).
*
* @param usable - accounts that may be attempted right now.
* @param excluded - accounts already rejected during this turn.
*/
function selectAccountForModel(usable, all, model, rules, excluded = /* @__PURE__ */ new Set()) {
	for (const rule of rules) {
		if (!rule.models.some((pattern) => matchesModel(pattern, model))) continue;
		const named = all.find((entry) => entry.slot.id === rule.account || entry.slot.ref === rule.account);
		if (named === void 0) continue;
		const candidate = usable.find((entry) => entry.key === named.key);
		if (candidate !== void 0 && !excluded.has(candidate.key)) return candidate;
	}
}
/** Glob-ish model matching: `*` wildcards, a bare suffix matches any prefix. */
function matchesModel(pattern, model) {
	if (pattern === model) return true;
	if (!pattern.includes("*")) return model.endsWith(`/${pattern}`) || model === pattern;
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(model);
}
/**
* The account pool.
*
* Instances are cheap: the pool holds no connection state of its own, so the
* plugin can scope it per API base and share health across turns.
*/
var RiverAccountPool = class {
	options;
	marks = /* @__PURE__ */ new Map();
	/** How many times each key has been handed out, for even distribution. */
	uses = /* @__PURE__ */ new Map();
	constructor(options) {
		this.options = options;
	}
	now() {
		return this.options.now?.() ?? Date.now();
	}
	/** Every configured account with its current health. */
	async describeAccounts() {
		return (await resolveAccounts(this.options)).map((account) => ({
			...account,
			state: this.marks.get(account.key)
		}));
	}
	/**
	* Reserve the next key for one attempt.
	*
	* Order: model route → pinned account → least-recently-used healthy account →
	* (only if everything is cooling down) the account that frees up soonest, so
	* a single-account setup waits instead of failing outright.
	*
	* @param tried - keys already rejected during this turn.
	* @param model - the model being called, for routing rules.
	*/
	async resolveKey(input = {}) {
		const accounts = await this.describeAccounts();
		if (accounts.length === 0) throw new AllAccountsUnusableError("No river.ai API key is configured: add one under Settings → Models → river.ai.", "INVALID_CREDENTIAL", void 0);
		const tried = new Set(input.tried ?? []);
		const now = this.now();
		const usable = accounts.filter((account) => !tried.has(account.key) && accountUsable(account.state, now));
		if (input.model !== void 0) {
			const rules = this.options.modelAccountRules?.() ?? [];
			const routed = selectAccountForModel(usable, accounts, input.model, rules);
			if (routed !== void 0) {
				this.recordUse(routed.key);
				return routed;
			}
		}
		const preferredId = this.options.preferredId?.();
		if (preferredId !== void 0) {
			const pinned = usable.find((account) => account.slot.id === preferredId || account.slot.ref === preferredId);
			if (pinned !== void 0) {
				this.recordUse(pinned.key);
				return pinned;
			}
		}
		if (usable.length > 0) {
			let pick = usable[0];
			for (const candidate of usable) if ((this.uses.get(candidate.key) ?? 0) < (this.uses.get(pick.key) ?? 0)) pick = candidate;
			this.recordUse(pick.key);
			return pick;
		}
		throw this.exhausted(accounts, tried, now);
	}
	/** The account to show in the sidebar: the next one that would be tried. */
	async activeAccount() {
		try {
			const accounts = await this.describeAccounts();
			const now = this.now();
			const preferredId = this.options.preferredId?.();
			return (preferredId === void 0 ? void 0 : accounts.find((account) => (account.slot.id === preferredId || account.slot.ref === preferredId) && accountUsable(account.state, now))) ?? accounts.find((account) => accountUsable(account.state, now)) ?? accounts[0];
		} catch {
			return;
		}
	}
	/**
	* Record that a key was refused.
	*
	* `resetAtMs` comes from river's `Retry-After` when present; otherwise the
	* cooldown is a conservative default that still lets the account return
	* within the session.
	*/
	markRejected(key, rejection, resetAtMs) {
		const normalized = normalizeKey(key);
		if (normalized === void 0) return;
		const now = this.now();
		const state = rejection === "invalid-credential" ? {
			kind: "disabled",
			cause: "auth",
			reason: "river.ai rejected this API key",
			until: 0
		} : {
			kind: "cooldown",
			cause: rejection === "throttled" ? "throttle" : "window",
			reason: rejection === "throttled" ? "river.ai rate limited this account" : "river.ai reported the account is out of balance",
			until: resetAtMs !== void 0 && resetAtMs > now ? resetAtMs : now + defaultCooldownMs(rejection)
		};
		const previous = this.marks.get(normalized);
		if (previous !== void 0 && previous.kind === "cooldown" && previous.until > state.until) return;
		this.marks.set(normalized, state);
		if (state.kind === "cooldown" && state.until - now > 864e5) this.marks.set(normalized, {
			...state,
			until: now + STATE_TTL_MS
		});
	}
	/** Record a successful attempt, clearing any stale cooldown. */
	markHealthy(key) {
		const normalized = normalizeKey(key);
		if (normalized === void 0) return;
		const state = this.marks.get(normalized);
		if (state !== void 0 && state.cause === "auth") return;
		this.marks.delete(normalized);
	}
	/** Forget every mark; used when credentials are edited. */
	reset() {
		this.marks.clear();
		this.uses.clear();
	}
	recordUse(key) {
		this.uses.set(key, (this.uses.get(key) ?? 0) + 1);
	}
	/** Build the error raised when nothing can be attempted. */
	exhausted(accounts, tried, now) {
		const allTried = accounts.every((account) => tried.has(account.key));
		const states = accounts.map((account) => account.state);
		if (states.length > 0 && states.every((state) => state?.cause === "auth")) return new AllAccountsUnusableError(`All ${accounts.length} river.ai accounts were rejected (invalid API key).`, "INVALID_CREDENTIAL", void 0);
		const cooldowns = accounts.map((account) => account.state).filter((state) => state !== void 0 && state.kind === "cooldown").map((state) => state.until);
		const soonest = cooldowns.length > 0 ? Math.min(...cooldowns) : 0;
		const wait = soonest > now ? Math.min(soonest - now, RETRY_MAX_DELAY_MS) : void 0;
		const suffix = allTried ? "every account was already tried this turn" : "all accounts are cooling down";
		return new AllAccountsUnusableError(wait === void 0 ? `All ${accounts.length} river.ai accounts are unavailable (${suffix}).` : `All ${accounts.length} river.ai accounts are busy; the next one frees up in ${Math.ceil(wait / 1e3)}s.`, cooldowns.length > 0 ? "RATE_LIMIT" : "THROTTLED", wait);
	}
};
/** A conservative cooldown when river gives no `Retry-After`. */
function defaultCooldownMs(rejection) {
	return rejection === "throttled" ? 6e4 : 3e5;
}
// src/model-prices.ts
/**
* river.ai pricing, cost estimation and the live-price catalogue.
*
* Token accounting is the part multi-account operation gets wrong most often:
* river bills cached input at a different rate (up to 5× below fresh input on
* DeepSeek, 5× below on GLM), so a cost figure computed from `prompt_tokens`
* alone overstates every cached turn. The helpers here take the harness's
* already-disjoint `TokenUsage` (fresh input / cache-read / cache-write /
* output) and price each bucket separately.
*
* @module dsh-river-provider/model-prices
*/
/** The console's public pricing endpoint (no auth, live). */
const LIVE_PRICE_URL = "https://console.river.ai/api/public/pricing";
/** The static price for one model, or zeros for a model river has not priced. */
function staticPrice(model) {
	return modelFacts(model).price;
}
/** Look one model up in a live price list, tolerating vendor-prefix differences. */
function findLivePrice(prices, model) {
	const exact = prices.find((entry) => entry.model === model);
	if (exact !== void 0) return exact;
	const tail = model.slice(model.lastIndexOf("/") + 1);
	return prices.find((entry) => entry.model.slice(entry.model.lastIndexOf("/") + 1) === tail);
}
/**
* Parse the console pricing payload.
*
* The endpoint returns `{ inference: [{ model, input, cached_input, output }] }`
* but the harness must keep working if river reshapes it, so every field is
* read defensively and a non-numeric entry is skipped rather than priced at
* `NaN`.
*/
function parseLivePrices(payload) {
	if (typeof payload !== "object" || payload === null) return [];
	const inference = payload.inference;
	if (!Array.isArray(inference)) return [];
	const prices = [];
	for (const raw of inference) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw;
		const model = entry.model;
		const input = entry.input;
		const output = entry.output;
		if (typeof model !== "string" || typeof input !== "number" || typeof output !== "number") continue;
		const cached = typeof entry.cached_input === "number" ? entry.cached_input : input;
		prices.push({
			model,
			input,
			cachedInput: cached,
			output
		});
	}
	return prices;
}
/**
* The price table the plugin uses for a model, preferring a fresh live value.
*
* A live price is authoritative while it is fresh; otherwise the snapshot in
* `capabilities.ts` answers immediately, so a cost badge never blocks on the
* network.
*/
var RiverPriceBook = class {
	prices = [];
	fetchedAt = 0;
	inFlight;
	/** Refresh from the console if the current table is stale. Never throws. */
	async refresh(fetchImpl = fetch) {
		if (Date.now() - this.fetchedAt < 18e5) return;
		if (this.inFlight !== void 0) return this.inFlight;
		this.inFlight = (async () => {
			try {
				const response = await fetchImpl(LIVE_PRICE_URL, { headers: { "user-agent": attributionUserAgent() } });
				if (!response.ok) return;
				const parsed = parseLivePrices(await response.json());
				if (parsed.length === 0) return;
				this.prices = parsed;
				this.fetchedAt = Date.now();
			} catch {} finally {
				this.inFlight = void 0;
			}
		})();
		return this.inFlight;
	}
	/** The best known price for a model. */
	priceFor(model) {
		const live = findLivePrice(this.prices, model);
		if (live !== void 0) return {
			input: live.input,
			cachedInput: live.cachedInput,
			output: live.output
		};
		return staticPrice(model);
	}
};
/**
* The attribution header value every river request carries.
*
* The harness's adapter contract requires every provider request to identify
* the client; river logs it for support, and the console pricing endpoint is
* the one place this module calls out on its own.
*/
function attributionUserAgent() {
	return "dsh-river-provider/0.1.0 (+https://github.com/Mars-Sea/dsh-river-provider)";
}
// src/wire-guards.ts
/** Non-throwing value guards for untrusted provider payloads. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
	return typeof value === "string" ? value : void 0;
}
function numberValue(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
// src/provider-errors.ts
/**
* Bilingual provider errors.
*
* Every failure the user can act on is raised as a `LlmError` whose message
* carries BOTH languages separated by `；` — the harness renders `message`
* verbatim, and this plugin's users are mixed-language. `code` is the stable
* machine-readable half: the retry policy, the rotation logic and the settings
* page all branch on it, never on the message text.
*
* The classification order matters and is deliberate:
*   1. output-ceiling rejections (a rejection that retrying cannot fix),
*   2. context overflow (must become CONTEXT_WINDOW_EXCEEDED, not a retry),
*   3. quota / balance (rotating accounts is the fix),
*   4. rate limiting (rotating accounts is the fix),
*   5. everything else, by HTTP status.
*
* @module dsh-river-provider/provider-errors
*/
/** Codes this plugin raises. Shared with the adapter's retry policy. */
const RATE_LIMIT_CODE = "RATE_LIMIT";
const THROTTLED_CODE = "THROTTLED";
const SERVER_CODE = "SERVER";
const TIMEOUT_CODE = "TIMEOUT";
const TRANSPORT_CODE = "TRANSPORT";
const OUTPUT_TOKEN_LIMIT_CODE = "OUTPUT_TOKEN_LIMIT";
const MODEL_NOT_FOUND_CODE = "MODEL_NOT_FOUND";
const BAD_REQUEST_CODE = "BAD_REQUEST";
/** Build a bilingual `LlmError`. */
function bilingual(code, en, zh, facts) {
	return new LlmError(`${en}；${zh}`, code, toErrorOptions(facts));
}
/**
* Convert plain facts into the branded option bag `LlmError` accepts.
*
* Every field is added only when present: `exactOptionalPropertyTypes` forbids
* writing `undefined` into an optional slot, and an absent field is what the
* harness reads as "no fact".
*/
function toErrorOptions(facts) {
	if (facts === void 0) return void 0;
	const options = {};
	if (facts.status !== void 0) options.status = facts.status;
	if (facts.providerRetryAfterMs !== void 0) options.providerRetryAfterMs = facts.providerRetryAfterMs;
	if (facts.requestId !== void 0 && facts.requestId !== "") options.requestId = ProviderRequestId(facts.requestId);
	if (facts.offloadImages !== void 0) options.offloadImages = facts.offloadImages;
	if (facts.cause !== void 0) options.cause = facts.cause;
	return options;
}
/**
* `LlmError` counts as an output-ceiling rejection when the provider refused
* the request because `max_tokens` exceeded the model's ceiling.
*
* river answers that with 400/422 and a message naming the limit; retrying the
* same request would fail identically, so these must be terminal.
*/
const OUTPUT_LIMIT_REJECTION = /max_tokens|max output|maximum context|output limit|too many tokens|token limit|exceeds? (?:the )?(?:maximum|limit)/i;
/** Whether a detail text is an output-ceiling rejection. */
function isOutputLimitDetail(detail) {
	return OUTPUT_LIMIT_REJECTION.test(detail);
}
/**
* Whether a detail text means the prompt exceeded the model's context window.
*
* Kept separate from {@link isOutputLimitDetail} because the remedies differ:
* overflow shrinks the prompt (harness compaction), a ceiling rejection
* changes `max_tokens`.
*/
const CONTEXT_OVERFLOW = /context (?:window|length)|context_length_exceeded|prompt is too long|input is too long|maximum context|too many input tokens|reduce (?:the )?(?:length|number) of/i;
/** Whether a detail means the prompt overflowed the model's context window. */
function isContextOverflowDetail(detail) {
	return CONTEXT_OVERFLOW.test(detail);
}
/** Whether a detail means the account is out of money (not out of rate). */
const QUOTA_DETAIL = /insufficient (?:balance|funds|credit|quota)|no credit|out of (?:credit|funds)|payment required|billing|spend limit|usage limit/i;
/** Whether a detail means the account is throttled for now. */
const THROTTLE_DETAIL = /rate limit|too many requests|throttl|concurren|requests per|tokens per/i;
/** Read the numeric value of a `Retry-After` style header or payload field. */
function retryAfterMs(value, now = Date.now()) {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value * 1e3);
	const text = stringValue(value);
	if (text === void 0) return void 0;
	const seconds = Number(text);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1e3);
	const at = Date.parse(text);
	if (!Number.isNaN(at)) return Math.max(0, at - now);
}
/** Pull the error detail out of a decoded response body or an SSE `error` event. */
function wireErrorDetail(value) {
	if (!isRecord(value)) return void 0;
	const error = isRecord(value.error) ? value.error : void 0;
	if (error !== void 0) {
		const detail = { message: stringValue(error.message) ?? stringValue(value.message) ?? "" };
		const type = stringValue(error.type);
		if (type !== void 0) detail.type = type;
		const code = stringValue(error.code);
		if (code !== void 0) detail.code = code;
		const param = stringValue(error.param);
		if (param !== void 0) detail.param = param;
		return detail;
	}
	const message = stringValue(value.message);
	if (message !== void 0) {
		const detail = { message };
		const type = stringValue(value.type);
		if (type !== void 0) detail.type = type;
		const code = stringValue(value.code);
		if (code !== void 0) detail.code = code;
		return detail;
	}
}
/** Join the useful parts of a wire error into one classification string. */
function detailText(detail) {
	return [
		detail.message,
		detail.type,
		detail.code,
		detail.param
	].filter((part) => part !== void 0).join(" ");
}
/**
* Turn a non-OK HTTP response into an `LlmError`.
*
* `status` drives the code because it is the one field river documents as
* stable: 401/403 credential, 402 balance, 404 model, 413 body, 429/503
* throttle, 5xx transient. The body refines the message only.
*/
function responseError(status, body, requestId, retryAfterHeader) {
	const detail = wireErrorDetail(body);
	const text = detail === void 0 ? "" : detailText(detail);
	const message = detail?.message !== void 0 && detail.message !== "" ? detail.message : `HTTP ${status}`;
	const base = requestId === void 0 ? {} : { requestId };
	const wait = retryAfterMs(retryAfterHeader);
	const withWait = wait === void 0 ? base : {
		...base,
		providerRetryAfterMs: wait
	};
	if (status === 401 || status === 403) return bilingual("INVALID_CREDENTIAL", `river.ai rejected the API key (${status}): ${message}`, `river.ai 拒绝了该 API Key（${status}）：${message}`, withWait);
	if (status === 402 || QUOTA_DETAIL.test(text)) return bilingual("QUOTA", `river.ai account is out of balance: ${message}`, `river.ai 账号余额不足：${message}`, {
		status,
		...withWait
	});
	if (status === 404) return bilingual(MODEL_NOT_FOUND_CODE, `river.ai could not find the model or endpoint: ${message}`, `river.ai 找不到该模型或端点：${message}`, {
		status,
		...withWait
	});
	if (status === 413) return bilingual(BAD_REQUEST_CODE, `river.ai refused the request size (413): ${message}`, `river.ai 拒绝了请求体积（413）：${message}。单次请求上限 50 MiB，图片请先压缩。`, {
		status,
		...withWait
	});
	if (status === 429 || THROTTLE_DETAIL.test(text)) return bilingual(RATE_LIMIT_CODE, `river.ai rate limited this account: ${message}`, `river.ai 对这个账号限流了：${message}`, {
		status,
		...withWait
	});
	if (status >= 500) return bilingual(SERVER_CODE, `river.ai returned ${status}: ${message}`, `river.ai 返回 ${status}：${message}`, {
		status,
		...withWait
	});
	if (isContextOverflowDetail(text)) return bilingual("CONTEXT_WINDOW_EXCEEDED", `river.ai rejected the prompt as too long: ${message}`, `river.ai 认为提示词过长：${message}`, {
		status,
		...withWait
	});
	if (isOutputLimitDetail(text)) return bilingual(OUTPUT_TOKEN_LIMIT_CODE, `river.ai rejected max_tokens: ${message}`, `river.ai 拒绝了 max_tokens：${message}`, {
		status,
		...withWait
	});
	return bilingual(BAD_REQUEST_CODE, `river.ai rejected the request (${status}): ${message}`, `river.ai 拒绝了请求（${status}）：${message}`, {
		status,
		...withWait
	});
}
/**
* Convert an in-stream `error` event into an `LlmError`.
*
* river's SSE can carry `data: {"error":{...}}` after a 200. Without this the
* turn would end in `EMPTY_RESPONSE` and be retried, hiding the real cause and
* burning another account's quota.
*/
function streamErrorToLlmError(value, fallbackMessage) {
	const detail = wireErrorDetail(value);
	const text = detail === void 0 ? fallbackMessage ?? "" : detailText(detail);
	const status = isRecord(value) ? numberValue(value.status) : void 0;
	const requestId = isRecord(value) ? stringValue(value.request_id) : void 0;
	const options = requestId === void 0 ? {} : { requestId };
	if (isContextOverflowDetail(text)) return bilingual("CONTEXT_WINDOW_EXCEEDED", `river.ai rejected the prompt as too long: ${text}`, `river.ai 认为提示词过长：${text}`, options);
	if (QUOTA_DETAIL.test(text)) return bilingual("QUOTA", `river.ai account is out of balance: ${text}`, `river.ai 账号余额不足：${text}`, options);
	if (THROTTLE_DETAIL.test(text)) return bilingual(RATE_LIMIT_CODE, `river.ai rate limited: ${text}`, `river.ai 限流：${text}`, options);
	return bilingual(status !== void 0 && status >= 500 ? SERVER_CODE : BAD_REQUEST_CODE, `river.ai stream failed: ${text === "" ? "unknown error" : text}`, `river.ai 流式响应失败：${text === "" ? "未知错误" : text}`, status === void 0 ? options : {
		status,
		...options
	});
}
/**
* Whether a failure is worth another account instead of another attempt.
*
* Rotating accounts fixes a throttle, a balance and a bad key; it cannot fix a
* malformed request, so those stop immediately rather than cycling the pool.
*/
function isAccountScopedFailure(failure) {
	return failure.code === "RATE_LIMIT" || failure.code === "THROTTLED" || failure.code === "QUOTA" || failure.code === "INVALID_CREDENTIAL" || failure.status === 429 || failure.status === 402 || failure.status === 401 || failure.status === 403;
}
// src/sse.ts
/**
* Incremental server-sent-events decoder.
*
* Feed raw text with {@link push}; it returns the events completed by that
* text and buffers any partial frame for the next call. Multi-line `data:`
* payloads are joined with `\n` per the SSE spec.
*/
var SseDecoder = class {
	buffer = "";
	/** Feed one decoded chunk; returns the events it completed. */
	push(chunk) {
		this.buffer += chunk;
		const events = [];
		for (;;) {
			const separator = this.nextSeparator();
			if (separator === void 0) break;
			const frame = this.buffer.slice(0, separator.index);
			this.buffer = this.buffer.slice(separator.index + separator.length);
			const event = decodeFrame(frame);
			if (event !== void 0) events.push(event);
		}
		return events;
	}
	/**
	* Flush a trailing unterminated frame.
	*
	* A provider that closes the connection without a final blank line still
	* delivered content; dropping it would lose the last token of every answer.
	*/
	flush() {
		const rest = this.buffer;
		this.buffer = "";
		if (rest.trim() === "") return [];
		const event = decodeFrame(rest);
		return event === void 0 ? [] : [event];
	}
	nextSeparator() {
		const lf = this.buffer.indexOf("\n\n");
		const crlf = this.buffer.indexOf("\r\n\r\n");
		if (lf < 0 && crlf < 0) return void 0;
		if (crlf >= 0 && (lf < 0 || crlf < lf)) return {
			index: crlf,
			length: 4
		};
		return {
			index: lf,
			length: 2
		};
	}
};
/** Decode one frame body into an event, or `undefined` for comments/empty. */
function decodeFrame(frame) {
	let eventName;
	const dataLines = [];
	for (const rawLine of frame.split(/\r?\n/)) {
		if (rawLine === "" || rawLine.startsWith(":")) continue;
		const colon = rawLine.indexOf(":");
		const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
		let value = colon < 0 ? "" : rawLine.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") dataLines.push(value);
		else if (field === "event") eventName = value;
	}
	if (dataLines.length === 0) return void 0;
	return eventName === void 0 ? { data: dataLines.join("\n") } : {
		event: eventName,
		data: dataLines.join("\n")
	};
}
// src/stream-decoder.ts
/**
* Converts one attempt's decoded JSON events into harness chunks.
*
* `done` flips once a terminal `finish` has been produced; the caller stops
* reading at that point, which matters because river keeps the socket open for
* a moment after the final frame.
*/
var StreamDecoder = class {
	maxTokens;
	nextIndex = 0;
	reasoningIndex;
	reasoningText = "";
	textIndex;
	text = "";
	calls = /* @__PURE__ */ new Map();
	usage;
	usageReported = false;
	finished = false;
	constructor(maxTokens) {
		this.maxTokens = maxTokens;
	}
	/** Whether a terminal `finish` chunk has been emitted. */
	get done() {
		return this.finished;
	}
	/**
	* Accept one SSE payload (JSON text, or `[DONE]`).
	*
	* Order inside one frame is deliberate: usage is captured FIRST, then the
	* choice is applied. river can put `finish_reason` and `usage` in the same
	* frame, and `acceptChoice` completes the stream on the spot, so capturing
	* usage afterwards would drop it on exactly the turns that matter. Because the
	* harness allows nothing after the terminal `finish`, a usage frame that
	* arrives after completion is dropped rather than emitted late.
	*
	* Yields the chunks the payload completes. Throws a classified `LlmError` for
	* an in-band error frame so the retry layer sees the real cause.
	*/
	*accept(data) {
		if (data === "[DONE]") {
			yield* this.finish();
			return;
		}
		let payload;
		try {
			payload = JSON.parse(data);
		} catch {
			return;
		}
		const record = isRecord(payload) ? payload : void 0;
		if (record === void 0) return;
		if (record.error !== void 0 && record.error !== null) throw streamErrorToLlmError(record.error, stringValue(record.message));
		const usage = isRecord(record.usage) ? record.usage : void 0;
		if (usage !== void 0) this.usage = mapUsage(usage);
		const choices = record.choices;
		if (Array.isArray(choices) && choices.length > 0) {
			const choice = isRecord(choices[0]) ? choices[0] : void 0;
			if (choice !== void 0) yield* this.acceptChoice(choice);
		}
	}
	/**
	* Emit the captured usage exactly once.
	*
	* The harness contract is "usage before the terminal finish and nothing
	* afterward", so this is called immediately before `finish` rather than after,
	* and never twice.
	*/
	*reportUsage() {
		if (this.usage === void 0 || this.usageReported) return;
		this.usageReported = true;
		yield {
			type: "usage",
			usage: this.usage
		};
	}
	/**
	* Close out an attempt whose stream ended without a `finish_reason`.
	*
	* A dropped connection still delivered a partial answer; the harness decides
	* whether a partial answer is usable (it retries on `EMPTY_RESPONSE` only).
	*/
	*finish() {
		if (this.finished) return;
		const calls = [...this.calls.values()].sort((a, b) => a.index - b.index);
		if (!(this.text !== "" || calls.length > 0)) {
			if (this.reasoningText !== "") throw bilingual("EMPTY_RESPONSE", "river.ai spent the whole output budget on reasoning and produced no answer. Raise max_tokens.", "river.ai 把整份输出预算都用在了思考上，没有产出正文。请提高 max_tokens。");
			throw bilingual("EMPTY_RESPONSE", "river.ai returned an empty answer.", "river.ai 返回了空回答。");
		}
		yield* this.closeBlocks();
		yield* this.reportUsage();
		this.finished = true;
		yield {
			type: "finish",
			reason: { kind: calls.length > 0 ? "tool-calls" : "stop" }
		};
	}
	/** Handle one `choices[0]` object. */
	*acceptChoice(choice) {
		const delta = isRecord(choice.delta) ? choice.delta : void 0;
		if (delta !== void 0) {
			const reasoning = readReasoning(delta);
			if (reasoning !== void 0 && reasoning !== "") {
				if (this.reasoningIndex === void 0) {
					const index = this.nextIndex++;
					this.reasoningIndex = index;
					yield {
						type: "block-start",
						index,
						blockType: "reasoning"
					};
				}
				this.reasoningText += reasoning;
				yield {
					type: "reasoning-delta",
					index: this.reasoningIndex,
					text: reasoning
				};
			}
			const content = stringValue(delta.content);
			if (content !== void 0 && content !== "") {
				yield* this.closeReasoning();
				if (this.textIndex === void 0) {
					const index = this.nextIndex++;
					this.textIndex = index;
					yield {
						type: "block-start",
						index,
						blockType: "text"
					};
				}
				this.text += content;
				yield {
					type: "text-delta",
					index: this.textIndex,
					text: content
				};
			}
			const toolCalls = delta.tool_calls;
			if (Array.isArray(toolCalls)) yield* this.acceptToolCalls(toolCalls);
		}
		const finishReason = stringValue(choice.finish_reason);
		if (finishReason !== void 0) yield* this.complete(finishReason);
	}
	/** Accumulate and stream tool-call fragments. */
	*acceptToolCalls(raw) {
		yield* this.closeReasoning();
		for (const entry of raw) {
			const call = isRecord(entry) ? entry : void 0;
			if (call === void 0) continue;
			const index = numberValue(call.index) ?? this.calls.size;
			let state = this.calls.get(index);
			if (state === void 0) {
				state = {
					index,
					id: "",
					name: "",
					arguments: "",
					started: false,
					blockIndex: -1
				};
				this.calls.set(index, state);
			}
			const id = stringValue(call.id);
			if (id !== void 0 && id !== "") state.id = id;
			const fn = isRecord(call.function) ? call.function : void 0;
			const name = fn === void 0 ? void 0 : stringValue(fn.name);
			if (name !== void 0 && name !== "") state.name = name;
			const args = fn === void 0 ? void 0 : stringValue(fn.arguments);
			if (!state.started && state.name !== "") {
				state.blockIndex = this.nextIndex++;
				state.started = true;
				if (state.id === "") state.id = fallbackCallId(state.index);
				yield {
					type: "block-start",
					index: state.blockIndex,
					blockType: "tool-call"
				};
				yield {
					type: "tool-call-delta",
					index: state.blockIndex,
					id: ToolCallId(state.id),
					name: state.name,
					argumentsDelta: ""
				};
			}
			if (args !== void 0 && args !== "" && state.started) {
				state.arguments += args;
				yield {
					type: "tool-call-delta",
					index: state.blockIndex,
					id: ToolCallId(state.id),
					argumentsDelta: args
				};
			}
		}
	}
	/** Emit the terminal chunks for one `finish_reason`. */
	*complete(finishReason) {
		if (this.finished) return;
		const calls = [...this.calls.values()].sort((a, b) => a.index - b.index);
		if (!(this.text !== "" || calls.length > 0)) {
			if (isOutputLimitDetail(finishReason) || finishReason === "length" || finishReason === "max_tokens") throw bilingual("OUTPUT_TOKEN_LIMIT", `river.ai stopped at max_tokens (${this.maxTokens ?? "model default"}) before writing an answer.`, `river.ai 触到 max_tokens（${this.maxTokens ?? "模型默认"}）时就停了，没有写出正文。`);
			if (this.reasoningText !== "") throw bilingual("EMPTY_RESPONSE", "river.ai spent the whole output budget on reasoning and produced no answer. Raise max_tokens.", "river.ai 把整份输出预算都用在了思考上，没有产出正文。请提高 max_tokens。");
			if (finishReason === "content_filter") throw bilingual("CONTENT_FILTER", "river.ai filtered the answer (content_filter).", "river.ai 过滤了这次回答（content_filter）。");
			throw bilingual("EMPTY_RESPONSE", "river.ai returned an empty answer.", "river.ai 返回了空回答。");
		}
		yield* this.closeBlocks();
		yield* this.reportUsage();
		this.finished = true;
		yield {
			type: "finish",
			reason: { kind: calls.length > 0 ? "tool-calls" : finishReason === "length" || finishReason === "max_tokens" || finishReason === "max_output_tokens" ? "max-tokens" : "stop" }
		};
	}
	/** Close the reasoning block if one is open. */
	*closeReasoning() {
		if (this.reasoningIndex === void 0) return;
		const index = this.reasoningIndex;
		this.reasoningIndex = void 0;
		yield {
			type: "block-end",
			index,
			block: {
				type: "reasoning",
				text: this.reasoningText
			}
		};
	}
	/** Close every open block: answer text, then each tool call. */
	*closeBlocks() {
		yield* this.closeReasoning();
		if (this.textIndex !== void 0) {
			const index = this.textIndex;
			this.textIndex = void 0;
			yield {
				type: "block-end",
				index,
				block: {
					type: "text",
					text: this.text
				}
			};
		}
		const calls = [...this.calls.values()].sort((a, b) => a.index - b.index);
		for (const call of calls) {
			if (!call.started) continue;
			yield {
				type: "block-end",
				index: call.blockIndex,
				block: {
					type: "tool-call",
					id: ToolCallId(call.id === "" ? fallbackCallId(call.index) : call.id),
					name: call.name,
					arguments: call.arguments === "" ? "{}" : call.arguments
				}
			};
		}
		this.calls.clear();
	}
};
/** Read whichever reasoning field this model used. */
function readReasoning(delta) {
	const direct = stringValue(delta.reasoning) ?? stringValue(delta.reasoning_content);
	if (direct !== void 0) return direct;
	const details = delta.reasoning_details;
	if (!Array.isArray(details)) return void 0;
	const parts = [];
	for (const entry of details) {
		const record = isRecord(entry) ? entry : void 0;
		if (record === void 0) continue;
		const text = stringValue(record.text) ?? stringValue(record.summary);
		if (text !== void 0 && text !== "") parts.push(text);
	}
	return parts.length === 0 ? void 0 : parts.join("");
}
/** A stable id for a tool call river never identified. */
function fallbackCallId(index) {
	return `call_river_${index}`;
}
/**
* Map river's `usage` onto the harness's disjoint counts.
*
* river follows OpenAI: `prompt_tokens` INCLUDES cached tokens. The harness's
* `inputTokens` is fresh input only and `totalTokens` is the sum of the parts,
* so the cached and cache-write counts must be subtracted. Passing
* `prompt_tokens` through unchanged inflates every cached turn, which is the
* single most common cost-reporting bug in adapters of this shape.
*/
function mapUsage(raw) {
	const promptTokens = numberValue(raw.prompt_tokens) ?? 0;
	const completionTokens = numberValue(raw.completion_tokens) ?? 0;
	const cacheRead = numberValue((isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : void 0)?.cached_tokens) ?? 0;
	const cacheWrite = numberValue(raw.cache_creation_input_tokens) ?? 0;
	const reasoningTokens = numberValue((isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : void 0)?.reasoning_tokens) ?? 0;
	const inputTokens = Math.max(0, promptTokens - cacheRead - cacheWrite);
	const usage = {
		inputTokens,
		outputTokens: completionTokens,
		totalTokens: inputTokens + cacheRead + cacheWrite + completionTokens
	};
	if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
	if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite;
	if (reasoningTokens > 0) usage.reasoningTokens = reasoningTokens;
	return usage;
}
// src/stream-response.ts
/**
* A caller-abortable wrapper around a provider response stream.
*
* Async generators queue `return()` BEHIND a pending `next()`, so a consumer
* that wants to stop (the harness aborts a turn) would wait for the next
* network chunk before the generator observes anything. Aborting the request's
* own `AbortController` is what actually wakes the pending read; `return()` is
* then just cleanup.
*
* Both signals are honoured: the caller's (turn cancelled) and the consumer's
* (`for await` broke out). Owned cleanup runs exactly once, on either path.
*
* @module dsh-river-provider/stream-response
*/
/** Either abort signal may be absent; both are wired when present. */
function ownedResponseStream(callerSignal, run) {
	const owned = new AbortController();
	const iterator = run(callerSignal === void 0 ? owned.signal : AbortSignal.any([callerSignal, owned.signal]))[Symbol.asyncIterator]();
	let closed = false;
	const self = {
		[Symbol.asyncIterator]() {
			return self;
		},
		async next() {
			if (closed) return {
				done: true,
				value: void 0
			};
			try {
				const step = await iterator.next();
				if (step.done === true) closed = true;
				return step;
			} catch (error) {
				closed = true;
				throw error;
			}
		},
		async return() {
			if (closed) return {
				done: true,
				value: void 0
			};
			closed = true;
			owned.abort(/* @__PURE__ */ new Error("stream closed by consumer"));
			try {
				await iterator.return?.(void 0);
			} catch {}
			return {
				done: true,
				value: void 0
			};
		},
		async throw(error) {
			closed = true;
			owned.abort(error instanceof Error ? error : /* @__PURE__ */ new Error("stream aborted"));
			try {
				await iterator.return?.(void 0);
			} catch {}
			throw error;
		}
	};
	return self;
}
/**
* Build the request body.
*
* Async because image variants are produced on demand; a text-only turn never
* touches the attachment layer.
*/
async function buildRequest(input) {
	const messages = [];
	if (input.system !== void 0 && input.system !== "") messages.push({
		role: "system",
		content: input.system
	});
	for (const message of input.messages) {
		const converted = await convertMessage(message, input.images);
		if (converted !== void 0) messages.push(converted);
	}
	const body = {
		model: input.model,
		messages,
		stream: true,
		stream_options: { include_usage: true }
	};
	if (input.maxTokens !== void 0) body.max_tokens = input.maxTokens;
	if (input.temperature !== void 0) body.temperature = input.temperature;
	if (input.topP !== void 0) body.top_p = input.topP;
	if (input.stop !== void 0 && input.stop.length > 0) body.stop = [...input.stop];
	const effort = wireEffort(input.model, input.reasoningEffort);
	if (effort !== void 0) body.reasoning_effort = effort;
	if (input.tools !== void 0 && input.tools.length > 0) {
		body.tools = input.tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters
			}
		}));
		body.tool_choice = "auto";
	}
	return body;
}
/** Convert one harness message into zero or one wire messages. */
async function convertMessage(message, images) {
	const role = message.role;
	if (role === "tool") {
		const text = plainText(message.content);
		const wire = {
			role: "tool",
			content: text,
			tool_call_id: String(message.toolCallId)
		};
		if (message.isError === true) wire.content = text === "" ? "(tool failed with no output)" : `[tool error] ${text}`;
		return wire;
	}
	if (role === "assistant") {
		const text = plainText(message.content);
		const calls = message.content.filter((block) => block.type === "tool-call");
		const wire = {
			role: "assistant",
			content: text
		};
		if (calls.length > 0) {
			wire.tool_calls = calls.map((block) => {
				const call = block;
				return {
					id: String(call.id),
					type: "function",
					function: {
						name: call.name,
						arguments: call.arguments === "" ? "{}" : call.arguments
					}
				};
			});
			if (text === "") delete wire.content;
		}
		return wire;
	}
	const parts = await convertParts(message.content, images);
	return {
		role: role === "developer" ? "system" : role,
		content: singleText(parts) ?? parts
	};
}
/**
* Convert content blocks into wire parts.
*
* Text blocks merge into one part per run; images become `image_url` data URLs.
* Ordering is preserved because a model reading "the error above" needs the
* same sequence the user typed.
*/
async function convertParts(content, images) {
	const parts = [];
	for (const block of content) switch (block.type) {
		case "text":
			if (block.text !== "") parts.push({
				type: "text",
				text: block.text
			});
			break;
		case "reasoning": break;
		case "image": {
			const ref = block.attachment;
			if (block.offloaded === true) {
				parts.push({
					type: "text",
					text: offloadedImageText(ref, images?.accessPath(ref))
				});
				break;
			}
			if (images === void 0) {
				parts.push({
					type: "text",
					text: textOnlyImageText(ref)
				});
				break;
			}
			try {
				const version = await images.readImage(ref);
				parts.push({
					type: "text",
					text: requestImageHandleText(ref, version, images.accessPath(ref))
				});
				parts.push({
					type: "image_url",
					image_url: { url: dataUrl(version) }
				});
			} catch {
				parts.push({
					type: "text",
					text: textOnlyImageText(ref)
				});
			}
			break;
		}
		case "file": parts.push({
			type: "text",
			text: fileHandleText(block.attachment, void 0)
		});
	}
	return parts;
}
/** Collapse a part list to a plain string when it is text-only. */
function singleText(parts) {
	if (parts.length === 0) return void 0;
	if (parts.length === 1) {
		const only = parts[0];
		return only !== void 0 && only.type === "text" ? only.text : void 0;
	}
}
/** Concatenate the text blocks of one message. */
function plainText(content) {
	return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Build the data URL river accepts for an inline image. */
function dataUrl(image) {
	const base64 = Buffer.from(image.data).toString("base64");
	return `data:${image.mediaType};base64,${base64}`;
}
/**
* Reject a body that river would refuse with 413.
*
* Failing locally yields a precise message naming the limit; failing remotely
* yields an opaque 413 after uploading 50 MiB.
*/
function assertBodySize(bytes) {
	if (bytes <= 52428800) return;
	throw bilingual("IMAGE_OFFLOAD_REQUIRED", `The request is ${(bytes / 1024 / 1024).toFixed(1)} MiB, over river.ai's 50 MiB limit. Offload older images and retry.`, `请求体积 ${(bytes / 1024 / 1024).toFixed(1)} MiB，超过 river.ai 的 50 MiB 上限。请卸下较早的图片后重试。`, { offloadImages: 1 });
}
// src/adapter.ts
/**
* The river.ai adapter.
*
* The adapter owns one HTTP attempt's worth of protocol: it builds the body,
* streams it, and maps river's wire vocabulary onto the harness's `StreamChunk`
* vocabulary. Account selection and rotation happen ABOVE it, injected through
* `resolveApiKey` / `markRejected`, so the adapter stays a function of
* (options, key) and is testable without a server.
*
* Model facts come from `GET {apiBase}/models` when the catalog is reachable;
* the static snapshot in `capabilities.ts` is the fallback. That split is
* deliberate — a new river release becomes usable without a plugin upgrade, and
* a catalog outage never breaks a turn.
*
* @module dsh-river-provider/adapter
*/
/**
* The fixed provider id this plugin registers.
*
* Not `riverai`: that id already belongs to the pi-ai row in the stock profile,
* and two plugins claiming one id makes the model picker and the default-model
* pointer ambiguous about which implementation a request runs through.
*/
const PROVIDER = "river";
/** Default API base; every request path hangs off it. */
const DEFAULT_API_BASE = "https://api.river.ai/v1";
/**
* Timeouts, matching river's documented ceilings.
*
* river documents prefill at 10 minutes and a non-streaming response at 15, so
* the whole-request budget is 15 and the silence budget is 10: a stream that
* goes quiet for longer than the prefill window is dead even though the socket
* may still be open.
*/
const DEFAULT_REQUEST_TIMEOUT_MS = 9e5;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 6e5;
/**
* The river.ai adapter.
*
* `stream()` performs exactly one HTTP attempt. Retries and rotation above the
* request lifetime are the harness's job; the only state this class keeps is
* the model catalog.
*/
var RiverAdapter = class extends LlmAdapter {
	deps;
	catalog;
	catalogInFlight;
	constructor(deps) {
		super();
		this.deps = deps;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "river.ai"
		};
	}
	/**
	* Retry policy: many attempts, long ceiling.
	*
	* `maxDelayMs` MUST equal {@link RETRY_MAX_DELAY_MS}: a `providerRetryAfterMs`
	* longer than the ceiling is discarded by the retry layer, which would turn a
	* well-behaved `Retry-After: 600` into a hammering loop.
	*/
	providerRetryPolicy(provider) {
		return {
			mode: "normal",
			maxRetries: 64,
			retryableCodes: [
				RATE_LIMIT_CODE,
				THROTTLED_CODE,
				SERVER_CODE,
				TIMEOUT_CODE,
				TRANSPORT_CODE,
				"EMPTY_RESPONSE"
			],
			initialDelayMs: 500,
			maxDelayMs: RETRY_MAX_DELAY_MS,
			jitterRatio: .1
		};
	}
	/** Every model this provider can serve. */
	async listModels(provider) {
		await this.refreshCatalog();
		const catalog = this.catalog?.models ?? [];
		return (catalog.length === 0 ? Object.keys(KNOWN_MODELS) : catalog.map((entry) => entry.id)).filter((id) => this.deps.isVisible(id)).map((id) => this.describe(id, catalog));
	}
	/** Resolve one model id, falling back to the static snapshot. */
	async resolveModel(provider, model, signal) {
		await this.refreshCatalog(signal);
		const facts = modelFacts(model);
		const connection = this.deps.connection();
		const resolved = {
			provider: PROVIDER,
			id: model,
			name: displayName(model),
			context: { contextWindow: contextWindowFor(model, connection.contextWindowLimit) },
			defaultMaxTokens: this.outputCeiling(model),
			toolUpdate: "addition-only"
		};
		const efforts = reasoningEffortsFor(model);
		if (efforts.length > 0) {
			const configured = this.deps.defaultEffort?.(model) ?? facts.defaultEffort;
			const defaultEffort = configured === void 0 ? void 0 : ReasoningEffortId(configured);
			resolved.reasoning = defaultEffort === void 0 ? { efforts } : {
				efforts,
				defaultEffort
			};
		}
		return resolved;
	}
	/**
	* One HTTP attempt.
	*
	* The connection is frozen at CALL time, not at construction: a settings edit
	* during a turn must not change the base URL halfway through an attempt.
	*/
	stream(options) {
		const connection = Object.freeze({ ...this.deps.connection() });
		return ownedResponseStream(options.signal, (signal) => this.runAttempt(options, connection, signal));
	}
	/**
	* Pick an account, translating pool exhaustion into a retry-aware error.
	*
	* The pool already knows how long the soonest account stays cooling down, but
	* it reports that as `retryAfterMs` on its own error type. Letting that escape
	* unwrapped loses the number: `dsh-llm-retry` only honours a wait it can read
	* off `providerRetryAfterMs`, so the harness would fall back to its generic
	* backoff and give up long before an account actually frees up.
	*/
	async resolveAccount(model) {
		try {
			return await this.deps.resolveApiKey(model);
		} catch (error) {
			const wait = error?.retryAfterMs;
			if (typeof wait !== "number" || !Number.isFinite(wait) || wait <= 0) throw error;
			const message = error instanceof Error ? error.message : String(error);
			const code = error.code;
			throw new LlmError(message, typeof code === "string" ? code : "RATE_LIMIT", { providerRetryAfterMs: wait });
		}
	}
	/** Run the request and stream its chunks. */
	async *runAttempt(options, connection, signal) {
		const account = await this.resolveAccount(options.model);
		const maxTokens = this.requestMaxTokens(options);
		const body = await buildRequest({
			model: options.model,
			messages: options.messages,
			system: options.system,
			tools: options.tools,
			maxTokens,
			temperature: options.temperature,
			stop: options.stop,
			reasoningEffort: options.purpose === "session-title" ? titleEffort(options.model) ?? options.reasoningEffort : options.reasoningEffort,
			images: this.deps.images
		});
		const serialized = JSON.stringify(body);
		assertBodySize(Buffer.byteLength(serialized, "utf8"));
		const url = `${trimSlash(connection.apiBase)}/chat/completions`;
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal.reason);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		const requestTimer = setTimeout(() => controller.abort(bilingual(TIMEOUT_CODE, "river.ai request timed out.", "river.ai 请求超时。")), connection.requestTimeoutMs);
		let idleTimer;
		const armIdle = () => {
			if (idleTimer !== void 0) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => controller.abort(bilingual(TIMEOUT_CODE, "river.ai stopped sending data.", "river.ai 停止发送数据了。")), connection.streamIdleTimeoutMs);
		};
		const stopTimers = () => {
			clearTimeout(requestTimer);
			if (idleTimer !== void 0) clearTimeout(idleTimer);
			idleTimer = void 0;
			signal.removeEventListener("abort", onAbort);
		};
		let response;
		try {
			armIdle();
			response = await fetch(url, {
				method: "POST",
				headers: {
					...attributionHeaders(),
					authorization: `Bearer ${account.key}`,
					"content-type": "application/json",
					accept: "text/event-stream"
				},
				body: serialized,
				signal: controller.signal
			});
		} catch (error) {
			stopTimers();
			throw this.transportError(error, signal);
		}
		try {
			if (!response.ok) {
				const payload = await readJsonSafe(response);
				this.rejectFromStatus(response.status, payload, account.key);
				throw responseError(response.status, payload, response.headers.get("x-request-id") ?? void 0, response.headers.get("retry-after") ?? void 0);
			}
			if ((response.headers.get("content-type") ?? "").includes("application/json")) yield* this.nonStreamingChunks(await readJsonSafe(response));
			else yield* this.streamChunks(response, maxTokens, account.key, armIdle);
			this.deps.markHealthy(account.key);
		} finally {
			stopTimers();
		}
	}
	/** Decode the SSE body into harness chunks. */
	async *streamChunks(response, maxTokens, key, armIdle) {
		const body = response.body;
		if (body === null) throw bilingual("EMPTY_RESPONSE", "river.ai returned no body.", "river.ai 没有返回任何响应体。");
		const reader = body.getReader();
		const text = new TextDecoder();
		const sse = new SseDecoder();
		const decoder = new StreamDecoder(maxTokens);
		try {
			for (;;) {
				const step = await reader.read();
				if (step.done) break;
				armIdle();
				for (const event of sse.push(text.decode(step.value, { stream: true }))) {
					if (event.data === "[DONE]") {
						yield* decoder.finish();
						return;
					}
					yield* this.guard(key, () => decoder.accept(event.data));
					if (decoder.done) return;
				}
			}
			for (const event of sse.flush()) {
				if (event.data === "[DONE]") break;
				yield* this.guard(key, () => decoder.accept(event.data));
				if (decoder.done) return;
			}
			if (!decoder.done) yield* this.guard(key, () => decoder.finish());
		} catch (error) {
			this.reclassifyThrow(error, key);
			throw error;
		} finally {
			reader.releaseLock();
		}
	}
	/** Run a decoder step, classifying an account-scoped failure on the way out. */
	*guard(key, step) {
		try {
			yield* step();
		} catch (error) {
			this.reclassifyThrow(error, key);
			throw error;
		}
	}
	/**
	* Accept a non-streamed completion.
	*
	* Some proxies strip `stream: true`; parsing the JSON body keeps the turn
	* working instead of surfacing "no frames received".
	*/
	*nonStreamingChunks(payload) {
		const completion = asRecord(payload);
		const choices = completion?.choices;
		const choice = Array.isArray(choices) ? asRecord(choices[0]) : void 0;
		const message = choice === void 0 ? void 0 : asRecord(choice.message);
		if (message === void 0) throw bilingual("EMPTY_RESPONSE", "river.ai returned no message.", "river.ai 没有返回任何消息。");
		let index = 0;
		const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
		if (reasoning !== "") {
			yield {
				type: "block-start",
				index,
				blockType: "reasoning"
			};
			yield {
				type: "reasoning-delta",
				index,
				text: reasoning
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "reasoning",
					text: reasoning
				}
			};
			index += 1;
		}
		const content = typeof message.content === "string" ? message.content : "";
		if (content !== "") {
			yield {
				type: "block-start",
				index,
				blockType: "text"
			};
			yield {
				type: "text-delta",
				index,
				text: content
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "text",
					text: content
				}
			};
			index += 1;
		}
		const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
		for (const raw of calls) {
			const call = asRecord(raw);
			if (call === void 0) continue;
			const fn = asRecord(call.function);
			const id = typeof call.id === "string" ? call.id : `call_river_${index}`;
			const name = typeof fn?.name === "string" ? fn.name : "";
			const args = typeof fn?.arguments === "string" && fn.arguments !== "" ? fn.arguments : "{}";
			yield {
				type: "block-start",
				index,
				blockType: "tool-call"
			};
			yield {
				type: "tool-call-delta",
				index,
				id,
				name,
				argumentsDelta: args
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "tool-call",
					id,
					name,
					arguments: args
				}
			};
			index += 1;
		}
		const usage = asRecord(completion?.usage);
		if (usage !== void 0) yield {
			type: "usage",
			usage: mapUsage(usage)
		};
		const finishReason = choice === void 0 ? void 0 : choice.finish_reason;
		yield {
			type: "finish",
			reason: { kind: calls.length > 0 ? "tool-calls" : finishReason === "length" || finishReason === "max_tokens" ? "max-tokens" : "stop" }
		};
	}
	/** `max_tokens` for this call: the caller's budget, capped by the model. */
	requestMaxTokens(options) {
		const ceiling = this.outputCeiling(options.model);
		if (options.maxTokens === void 0) return ceiling;
		return Math.min(options.maxTokens, ceiling);
	}
	/** The model's own ceiling, or the configured override when lower. */
	outputCeiling(model) {
		return outputBudgetFor(model, this.deps.connection().maxOutputTokens);
	}
	/** Build the detached metadata for one model id. */
	describe(id, catalog) {
		const entry = catalog.find((candidate) => candidate.id === id);
		const facts = modelFacts(id);
		const vision = entry?.vision ?? facts.vision;
		const info = {
			provider: PROVIDER,
			id,
			name: entry?.name ?? displayName(id),
			inputModalities: vision ? ["text", "image"] : ["text"]
		};
		const description = entry?.description ?? catalogDescription(id);
		if (description !== void 0) info.description = description;
		return info;
	}
	/**
	* Refresh the model catalog, at most once per {@link CATALOG_TTL_MS}.
	*
	* Failure is silent by design: the snapshot answers, so a catalog outage must
	* never become a failed turn.
	*/
	refreshCatalog(signal) {
		if (this.catalog !== void 0 && Date.now() - this.catalog.at < 9e5) return Promise.resolve();
		if (this.catalogInFlight !== void 0) return this.catalogInFlight;
		this.catalogInFlight = (async () => {
			try {
				const connection = this.deps.connection();
				const account = await this.deps.resolveApiKey("");
				const response = await fetch(`${trimSlash(connection.apiBase)}/models`, {
					headers: {
						...attributionHeaders(),
						authorization: `Bearer ${account.key}`
					},
					...signal === void 0 ? {} : { signal }
				});
				if (!response.ok) return;
				const list = asRecord(await response.json())?.data;
				if (!Array.isArray(list)) return;
				const models = [];
				for (const raw of list) {
					const entry = asRecord(raw);
					const id = entry?.id;
					if (typeof id !== "string") continue;
					const model = { id };
					if (typeof entry?.name === "string") model.name = entry.name;
					if (typeof entry?.description === "string") model.description = entry.description;
					models.push(model);
				}
				if (models.length > 0) this.catalog = {
					at: Date.now(),
					models
				};
			} catch {} finally {
				this.catalogInFlight = void 0;
			}
		})();
		return this.catalogInFlight;
	}
	/** Record an account-scoped rejection learned from an HTTP status. */
	rejectFromStatus(status, payload, key) {
		if (status === 429 || status === 503) this.deps.markRejected(key, "throttled", findRetryAfter(payload));
		else if (status === 401 || status === 403) this.deps.markRejected(key, "invalid-credential");
		else if (status === 402) this.deps.markRejected(key, "rate-limit", findRetryAfter(payload));
	}
	/** Mark an error's key when the error is account-scoped. */
	reclassifyThrow(error, key) {
		const failure = error.failure;
		if (failure === void 0 || !isAccountScopedFailure(failure)) return;
		const resetAt = failure.providerRetryAfterMs === void 0 ? void 0 : Date.now() + failure.providerRetryAfterMs;
		if (failure.code === "INVALID_CREDENTIAL") this.deps.markRejected(key, "invalid-credential");
		else if (failure.code === "QUOTA") this.deps.markRejected(key, "rate-limit", resetAt);
		else this.deps.markRejected(key, "throttled", resetAt);
	}
	/** Wrap a fetch throw into a classified `LlmError`. */
	transportError(error, signal) {
		if (signal.aborted) return bilingual("ABORTED", "The river.ai request was aborted.", "river.ai 请求已中止。");
		if (error instanceof LlmErrorCarrier) return error.cause;
		if (error.failure !== void 0) return error;
		if ((error instanceof Error ? error.name : "") === "AbortError") return bilingual(TIMEOUT_CODE, "river.ai stopped responding.", "river.ai 停止响应了。");
		const message = error instanceof Error ? error.message : String(error);
		return bilingual(TRANSPORT_CODE, `Could not reach river.ai: ${message}`, `无法连接 river.ai：${message}`);
	}
};
/** Marker so a classified error surfacing through `fetch` keeps its identity. */
var LlmErrorCarrier = class extends Error {
	cause;
	constructor(cause) {
		super(cause.message);
		this.cause = cause;
	}
};
/** Model blurbs shown in the picker when the catalog is silent. */
function catalogDescription(id) {
	const facts = modelFacts(id);
	if (facts.price.input === 0) return void 0;
	return `$${facts.price.input}/M in · $${facts.price.output}/M out · ${Math.round(facts.contextWindow / 1024)}K context`;
}
/** Strip a trailing slash from a base URL. */
function trimSlash(value) {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
/** Read a JSON body without throwing on a non-JSON or empty payload. */
async function readJsonSafe(response) {
	try {
		const text = await response.text();
		if (text.trim() === "") return void 0;
		return JSON.parse(text);
	} catch {
		return;
	}
}
/** Find a `Retry-After` inside a JSON error body, as epoch ms. */
function findRetryAfter(payload) {
	const record = asRecord(payload);
	const error = asRecord(record?.error);
	for (const source of [record, error]) {
		if (source === void 0) continue;
		const ms = source.retry_after_ms;
		if (typeof ms === "number" && Number.isFinite(ms)) return Date.now() + ms;
		const seconds = source.retry_after;
		if (typeof seconds === "number" && Number.isFinite(seconds)) return Date.now() + seconds * 1e3;
	}
}
// src/image-request.ts
/** Longest edge river accepts without quality loss on a vision model. */
const REQUEST_IMAGE_MAX_LONG_EDGE = 1568;
/** Largest single encoded image, comfortably inside river's 50 MiB body cap. */
const REQUEST_IMAGE_MAX_ENCODED_BYTES = 1048576;
/**
* Fit an image into a bounding box, preserving aspect ratio.
*
* Returns the original dimensions when it already fits, so an image that needs
* no downscale is not re-encoded (re-encoding a PNG screenshots loses text
* fidelity the model needs).
*/
function longEdgeDimensions(width, height, longEdge) {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return {
		width: longEdge,
		height: longEdge
	};
	const current = Math.max(width, height);
	if (current <= longEdge) return {
		width: Math.round(width),
		height: Math.round(height)
	};
	const scale = longEdge / current;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale))
	};
}
/** The request-encoding target for one image. */
function requestImageTarget(ref) {
	const dims = longEdgeDimensions(ref.width, ref.height, REQUEST_IMAGE_MAX_LONG_EDGE);
	return {
		width: dims.width,
		height: dims.height,
		maxBytes: REQUEST_IMAGE_MAX_ENCODED_BYTES
	};
}
/** Whether river accepts this media type inline. */
function isRiverImageType(mediaType) {
	const normalized = mediaType.toLowerCase();
	return normalized === "image/jpeg" || normalized === "image/png";
}
// src/images.ts
/**
* Resolves images through the mounted attachment store.
*
* The store is per-profile and stable for the plugin's lifetime, so binding it
* once at registration is enough; `bind` exists for the context-first form the
* adapter uses when the store appears after the plugin loaded.
*/
var AttachmentImageResolver = class {
	store;
	mapHostPath;
	constructor(mapHostPath = () => void 0) {
		this.mapHostPath = mapHostPath;
	}
	/** Bind the profile's attachment store (idempotent; latest binding wins). */
	bind(store) {
		this.store = store;
	}
	/**
	* Read the request variant of one image, honouring river's limits.
	*
	* The byte ceiling is enforced by the store's encoder ladder: asking for a
	* target makes it produce the smallest variant that fits, and a variant that
	* still overflows is refused by `assertBodySize` at serialization rather than
	* silently truncating an image the model was told about.
	*/
	async readImage(ref, signal) {
		const store = this.store;
		if (store === void 0) throw new Error("No attachment store is available for this river.ai request.");
		if (!isRiverImageType(ref.mediaType)) throw new UnsupportedImageFormat(ref);
		return store.readImageRequest(ref, requestImageTarget(ref), signal);
	}
	/**
	* Resolve a tool-readable path for one image, when the backend has one.
	*
	* river has no path-based image reference — content parts carry bytes only —
	* so a block that falls back to text still names the file the model could ask
	* a tool to open.
	*/
	accessPath(ref) {
		const store = this.store;
		if (store === void 0) return void 0;
		const hostPath = store.imageHostPath(ref);
		if (hostPath === void 0) return void 0;
		const readonlyPath = this.mapHostPath(hostPath);
		return readonlyPath === void 0 ? void 0 : { readonlyPath };
	}
};
/** Raised for a format river cannot accept; `wire.ts` turns it into text. */
var UnsupportedImageFormat = class extends Error {
	ref;
	constructor(ref) {
		super(`river.ai accepts JPEG and PNG only; ${ref.mediaType} needs conversion.`);
		this.ref = ref;
		this.name = "UnsupportedImageFormat";
	}
};
// src/config-volatile.ts
/**
* Volatile-config helpers for the DSH profile Config.
*
* `settings.describe()` projects each entry's schema through `volatileForm()`,
* so a settings form contains ONLY nodes carrying `meta.volatile`, and the
* loader resolves each marked field into a frozen `{ get() }` reference that is
* written IN PLACE (no remount). Two helpers keep the rest of the plugin
* reading a PLAIN `Config`: `markVolatile()` applies the mark, and
* `unwrapVolatileConfig()` reads every top-level field through its reference
* when one is present — FRESH per call, because a reference's identity is
* stable while its value changes.
*
* Only TOP-LEVEL fields are marked (a form write names a top-level path such
* as `accounts`), so one unwrap level is complete. Literal `apiKey` secrets
* stay unmarked on purpose: no settings surface writes them — both the web page
* and the config file write keys through the credentials seam — so a
* config-file edit to a secret literal reloading the fiber is correct.
*
* @module dsh-river-provider/config-volatile
*/
/**
* Mark one schema field volatile.
*
* `.volatile()` is a schemastery 3.18.3 feature and the supported engine ships
* `~3.18.5`, so the method is always present. It is reached through a
* structural member so the caller's declared field type survives — the mark
* changes what the schema PARSES to (a live reference), not the plugin-facing
* `Config` shape.
*/
function markVolatile(schema) {
	return schema.volatile();
}
/**
* Mark every field of a Config field dict volatile, except the named
* composition-only secrets (`apiKey`, which no settings surface writes).
*/
function markVolatileFields(fields, skip = []) {
	const source = fields.dict ?? fields;
	const marked = Object.fromEntries(Object.entries(source).map(([name, schema]) => [name, skip.includes(name) ? schema : markVolatile(schema)]));
	const target = fields;
	if (target.dict !== void 0) {
		target.dict = marked;
		return fields;
	}
	return marked;
}
// src/remote-state.ts
/**
* The settings page's data source, on the Host.
*
* The browser never calls river.ai: a page that did would need the raw key in
* the browser and would leak a 401/429 policy into the Client. Everything the
* page renders is assembled here from the same objects the adapter uses, so what
* the form shows and what a request does cannot disagree.
*
* @module dsh-river-provider/remote-state
*/
/** Build one account row: configured, active, and why it is not usable. */
function accountView(account, slot, activeId, now, configured) {
	const state = account?.state;
	let status = "ready";
	let reason = "";
	if (!configured) {
		status = "unconfigured";
		reason = slot.literal === void 0 || slot.literal === "" ? `No value for ${slot.ref}.` : "The literal key in this account is empty.";
	} else if (state !== void 0 && !accountUsable(state, now)) {
		status = state.kind === "disabled" ? "disabled" : "cooldown";
		reason = state.reason;
	} else if (state !== void 0 && accountUsable(state, now)) {
		status = "ready";
		reason = "";
	}
	return {
		id: slot.id,
		label: slot.label,
		ref: slot.ref,
		configured,
		active: slot.id === activeId,
		status,
		reason,
		cooldownUntil: status === "cooldown" ? state?.until ?? 0 : 0
	};
}
/** The current model list, with the capacities and efforts the picker uses. */
function modelViews(deps) {
	return Object.keys(KNOWN_MODELS).map((id) => {
		const facts = modelFacts(id);
		const price = facts.price;
		return {
			id,
			name: displayName(id),
			contextWindow: facts.contextWindow,
			maxOutputTokens: facts.maxOutputTokens,
			vision: facts.vision,
			efforts: reasoningEffortsFor(id).map((effort) => String(effort.id)),
			defaultEffort: facts.defaultEffort ?? "",
			visible: deps.isVisible(id),
			price: {
				input: price.input,
				cachedInput: price.cachedInput,
				output: price.output
			}
		};
	});
}
/**
* Assemble the page snapshot.
*
* `activeId` is resolved from the pool rather than recomputed here: the pool is
* the only thing that knows which account a request would take right now, and a
* second implementation of that rule would eventually pick a different one.
*/
async function buildSnapshot(deps) {
	const raw = deps.config();
	const defaults = deps.defaults();
	const now = Date.now();
	const resolved = await deps.pool.describeAccounts();
	const activeId = (await deps.pool.activeAccount().catch(() => void 0))?.slot.id ?? "";
	const byId = /* @__PURE__ */ new Map();
	for (const account of resolved) byId.set(account.slot.id, account);
	const slots = deps.slots();
	const configured = await Promise.all(slots.map(async (slot) => {
		if ((slot.literal ?? "") !== "") return true;
		return deps.isConfigured(slot.ref);
	}));
	return {
		provider: deps.provider,
		apiBase: defaults.apiBase,
		accounts: slots.map((slot, index) => accountView(byId.get(slot.id), slot, activeId, now, configured[index] ?? false)),
		models: modelViews(deps),
		defaults: {
			contextWindowLimit: defaults.contextWindowLimit,
			maxOutputTokens: defaults.maxOutputTokens,
			activeAccount: raw.activeAccount ?? "",
			defaultReasoningEffort: { ...raw.defaultReasoningEffort ?? {} }
		},
		modelAccountRules: (raw.modelAccountRules ?? []).map((rule) => ({
			models: [...rule.models],
			account: rule.account
		}))
	};
}
// src/remote-edit.ts
/**
* Writing the settings page's edits back into the profile.
*
* Every write goes through {@link SettingsForms.update}, which merges the patch
* into the profile's own `cordis.patch.yml` and re-reads it: the plugin never
* edits a file itself. That matters because the same section is ALSO loaded from
* the composed `cordis.yml` — a hand edit there would be shadowed, and a hand
* edit here could race the settings service's own revision tracking.
*
* @module dsh-river-provider/remote-edit
*/
/** A refused edit, carrying the message the page shows. */
var EditRefused = class extends Error {};
function refuse(message) {
	throw new EditRefused(message);
}
/** Cap on a capacity, mirroring the schema's own bound. */
const CAPACITY_MAX = 8388608;
function capacity(field, value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) refuse(`${field} must be a positive number.`);
	if (value > CAPACITY_MAX) refuse(`${field} must not exceed ${CAPACITY_MAX}.`);
	return Math.floor(value);
}
/**
* Validate one effort map against river's per-model whitelists.
*
* A level a model does not accept is refused HERE rather than at request time:
* {@link configuredEffort} treats it as a configuration error and fails the
* turn, so letting the page store it would break every request that model
* serves. The check runs against each known model the glob selects.
*/
function effortMap(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) refuse("defaultReasoningEffort must be an object of model → effort.");
	const result = {};
	for (const [pattern, level] of Object.entries(value)) {
		if (typeof level !== "string") refuse(`The effort for ${pattern} must be a string.`);
		const trimmed = level.trim();
		if (trimmed === "") continue;
		result[pattern] = trimmed;
		if (trimmed === "auto") continue;
		for (const model of Object.keys(KNOWN_MODELS)) {
			if (!matches(pattern, model)) continue;
			const facts = modelFacts(model);
			if (facts.efforts.length === 0) refuse(`${model} has no reasoning support, so "${trimmed}" cannot be set for ${pattern}.`);
			if (!facts.efforts.includes(trimmed)) refuse(`${model} accepts only ${facts.efforts.join("|")} for reasoning_effort, not "${trimmed}".`);
		}
	}
	return result;
}
/** Glob match: `*` only, which is all river model ids need. */
function matches(pattern, model) {
	if (pattern === model) return true;
	if (!pattern.includes("*")) return false;
	const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`^${escaped.join(".*")}$`).test(model);
}
/**
* Turn one form edit into the patch the settings service merges.
*
* The patch names ONLY the edited key: `update` is a merge, so a field the page
* did not touch keeps whatever the profile already had.
*/
function patchFor(edit) {
	switch (edit.field) {
		case "apiBase": {
			const value = String(edit.value ?? "").trim();
			if (value === "") return { apiBase: void 0 };
			if (!/^https?:\/\//.test(value)) refuse("The base URL must start with http:// or https://.");
			return { apiBase: value.replace(/\/+$/, "") };
		}
		case "apiKeyEnv": {
			const value = String(edit.value ?? "").trim();
			if (value === "") return { apiKeyEnv: void 0 };
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) refuse("An environment variable name takes letters, digits and underscores.");
			return { apiKeyEnv: value };
		}
		case "activeAccount": {
			const value = String(edit.value ?? "").trim();
			return { activeAccount: value === "" ? void 0 : value };
		}
		case "contextWindowLimit": {
			const value = capacity("The context window", edit.value);
			return { contextWindowLimit: value === 0 ? void 0 : value };
		}
		case "maxOutputTokens": {
			const value = capacity("The output budget", edit.value);
			return { maxOutputTokens: value === 0 ? void 0 : value };
		}
		case "defaultReasoningEffort": return { defaultReasoningEffort: effortMap(edit.value) };
		case "modelVisibility": {
			const value = edit.value;
			if (typeof value !== "object" || value === null || Array.isArray(value)) refuse("modelVisibility must be an object of model → boolean.");
			const result = {};
			for (const [model, visible] of Object.entries(value)) {
				if (typeof visible !== "boolean") refuse(`The visibility of ${model} must be true or false.`);
				result[model] = visible;
			}
			return { modelVisibility: result };
		}
		case "visibleModels":
			if (!Array.isArray(edit.value) || edit.value.some((item) => typeof item !== "string")) refuse("visibleModels must be a list of model ids.");
			return { visibleModels: [...edit.value] };
		case "accounts":
			if (!Array.isArray(edit.value)) refuse("accounts must be a list.");
			return { accounts: edit.value.map((account, index) => {
				const ref = account.apiKeyEnv?.trim() ?? "";
				if (ref !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) refuse(`Account ${index + 2}: an environment variable name takes letters, digits and underscores.`);
				const label = account.label?.trim() ?? "";
				const literal = account.apiKey?.trim() ?? "";
				return {
					...label === "" ? {} : { label },
					...ref === "" ? {} : { apiKeyEnv: ref },
					...literal === "" ? {} : { apiKey: literal }
				};
			}) };
		case "modelAccountRules":
			if (!Array.isArray(edit.value)) refuse("modelAccountRules must be a list.");
			return { modelAccountRules: edit.value.map((rule, index) => {
				if (!Array.isArray(rule.models) || rule.models.some((item) => typeof item !== "string")) refuse(`Rule ${index + 1}: models must be a list of ids or globs.`);
				if (typeof rule.account !== "string" || rule.account.trim() === "") refuse(`Rule ${index + 1}: an account is required.`);
				return {
					models: rule.models,
					account: rule.account.trim()
				};
			}) };
		default: refuse(`Unknown setting ${edit.field}.`);
	}
}
/**
* Apply one edit.
*
* @returns the state after the write, or the reason it was refused. A refusal is
* a normal answer, not a thrown error: the page renders it next to the field.
*/
async function applyEdit(deps, edit) {
	const settings = deps.settings();
	if (settings === void 0) refuse("This profile has no writable settings form, so the edit was not stored.");
	const patch = patchFor(edit);
	try {
		await settings.update(deps.ns, patch);
	} catch (error) {
		refuse(error instanceof Error ? error.message : String(error));
	}
	return { ok: true };
}
/**
* Store one literal key for an account.
*
* A literal key typed into the page is written to the credential store, not to
* the profile file: the settings document is plain text on disk and a key there
* would be both stored in the clear and re-shown by any config dump.
*/
async function storeAccountKey(deps, target) {
	const ref = target.ref.trim();
	const key = target.key.trim();
	if (ref === "") refuse("An account reference is required.");
	if (key === "") refuse("The key is empty.");
	const credentials = deps.credentials();
	if (credentials === void 0) refuse("This profile has no credential store; set the key as an environment variable instead.");
	const value = credentialRef(ref);
	await credentials.set(value, key);
	return { ok: true };
}
// node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js
/**
* Remote decorators and explicit Gateway bindings backed by versioned
* descriptors carried on decorated class prototypes. Strict reflection
* remains a Typert compiler responsibility.
* @module @deepseek-ai/dsh-typert-protocol
*/
const TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/**
* Test one generated Remote name against the Connection endpoint grammar.
* @param value - namespace, method, lookup, or Context segment.
* @returns whether the value can cross the shared RPC carrier unchanged.
*/
function isTypertRemoteSegment(value) {
	return value !== "." && value !== ".." && TYPERT_REMOTE_SEGMENT_PATTERN.test(value);
}
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";
/**
* Bind one visible Service field to a Cordis key and Remote namespace. A
* service that owns a Cordis Context also gives its tree `ctx.invocation`,
* `undefined` outside a Remote call, so no `TypertRemoteService` is needed for
* a Host composition to read it.
* @param service - owning Service instance, normally `this`.
* @param serviceKey - exact Cordis service key.
* @param options - optional wire namespace.
* @returns a frozen, inspectable binding with no compiler-injected metadata.
*/
function bindTypertRemote(service, serviceKey, options = {}) {
	validateName("service key", serviceKey);
	const namespace = options.namespace ?? serviceKey;
	validateName("namespace", namespace);
	const ctx = Reflect.get(service, "ctx");
	if (Context.is(ctx)) provideInvocationAccessor(ctx);
	return Object.freeze({
		service,
		serviceKey,
		namespace
	});
}
/** Cordis Service base that exposes its registered name through Typert Gateway. */
var TypertRemoteService = class extends Service {
	/** Visible binding consumed by the Gateway's source-mode discovery. */
	typertRemote;
	/**
	* Register the Service and bind the same key to Typert Gateway.
	* @param ctx - owning Cordis Context.
	* @param serviceKey - exact Cordis service key and default wire namespace.
	* @param options - optional wire namespace.
	*/
	constructor(ctx, serviceKey, options = {}) {
		super(ctx, serviceKey);
		this.typertRemote = bindTypertRemote(this, this.name, options);
	}
};
/**
* Make `ctx.invocation` read as `undefined` outside a Remote call instead of the
* reflect service's "cannot get property" error; a call-derived Context shadows
* the accessor with its own property. The first Remote Service constructed in a
* tree registers it on the root, where it outlives any one Service.
*/
function provideInvocationAccessor(ctx) {
	if (Object.hasOwn(ctx.root.reflect.props, "invocation")) return;
	ctx.root.accessor("invocation", { get: () => void 0 });
}
function Remote(methodExportOrOptions, context) {
	if (typeof methodExportOrOptions === "string") {
		validateName("Remote export name", methodExportOrOptions);
		return remoteDecorator({ kind: "direct" }, { exportName: methodExportOrOptions });
	}
	if (typeof methodExportOrOptions === "object") return remoteDecorator({ kind: "direct" }, markerOptions(methodExportOrOptions, REMOTE_OPTION_KEYS, "Remote options require name, mode: \"stream\", or resources"));
	if (context === void 0) throw new TypeError("typert-protocol: Remote decorator context is missing");
	addMarkerInitializer(context, { kind: "direct" });
}
const REMOTE_OPTION_KEYS = /* @__PURE__ */ new Set([
	"name",
	"mode",
	"resources"
]);
/** Validate one decorator options object against its accepted keys and select the marker fields. */
function markerOptions(options, accepted, requirement) {
	const keys = Reflect.ownKeys(options);
	if (keys.length === 0 || keys.some((key) => typeof key !== "string" || !accepted.has(key)) || Object.hasOwn(options, "mode") && options.mode !== "stream") throw new TypeError(`typert-protocol: ${requirement}`);
	const { mode, name, resources } = options;
	if (name !== void 0) validateName("Remote export name", name);
	return {
		...mode === void 0 ? {} : { mode },
		...name === void 0 ? {} : { exportName: name },
		...resources === void 0 ? {} : { resources: resourceReaders(resources) }
	};
}
/** Freeze declared readers into the marker record; a misdeclared reader fails at decoration. */
function resourceReaders(resources) {
	const readers = {};
	for (const [kind, reader] of Object.entries(resources)) {
		if (typeof reader !== "function") throw new TypeError(`typert-protocol: Remote resource reader "${kind}" must be a function`);
		readers[kind] = reader;
	}
	if (Object.keys(readers).length === 0) throw new TypeError("typert-protocol: Remote resources require at least one reader");
	return Object.freeze(readers);
}
function remoteDecorator(invocation, options = {}) {
	return function(_method, context) {
		addMarkerInitializer(context, invocation, options);
	};
}
function readRemoteMethodDescriptor(prototype) {
	const property = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR);
	if (property === void 0) return void 0;
	const descriptor = property.value;
	if (descriptor === null || typeof descriptor !== "object") throw new TypeError("typert-protocol: Remote method descriptor must be an object");
	const version = Reflect.get(descriptor, "version");
	if (version !== 1) throw new TypeError(`typert-protocol: unsupported Remote method descriptor version ${String(version)}`);
	const methods = Reflect.get(descriptor, "methods");
	if (!Array.isArray(methods)) throw new TypeError("typert-protocol: Remote method descriptor methods must be an array");
	return descriptor;
}
function addMarkerInitializer(context, invocation, options = {}) {
	if (context.private || context.static || typeof context.name !== "string") throw new TypeError("typert-protocol: Remote decorators require a public instance method with a string name");
	const method = context.name;
	context.addInitializer(function() {
		const prototype = Object.getPrototypeOf(this);
		if (prototype === null) throw new TypeError(`typert-protocol: cannot mark Remote method "${method}" on an object without a prototype`);
		mark(prototype, method, invocation, options);
	});
}
function mark(prototype, method, invocation, { mode, exportName, resources }) {
	const descriptor = readRemoteMethodDescriptor(prototype);
	const marker = Object.freeze({
		method,
		...exportName === void 0 || exportName === method ? {} : { exportName },
		...mode === void 0 ? {} : { mode },
		invocation: Object.freeze(invocation),
		...resources === void 0 ? {} : { resources }
	});
	const current = descriptor?.methods.find((candidate) => candidate.method === method);
	if (current !== void 0) {
		if (current.exportName === marker.exportName && current.mode === marker.mode && current.resources === marker.resources && sameInvocation(current.invocation, invocation)) return;
		throw new Error(`typert-protocol: Remote method "${method}" has conflicting invocation markers`);
	}
	Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze([...descriptor?.methods ?? [], marker])
		})
	});
}
function sameInvocation(left, right) {
	if (left.kind === "direct") return right.kind === "direct";
	if (right.kind === "direct") return false;
	return left.context === right.context;
}
function validateName(subject, value) {
	if (!isTypertRemoteSegment(value)) throw new TypeError(`typert-protocol: ${subject} must contain only RPC endpoint segment characters`);
}
// src/remote-wire.ts
/**
* The Remote wire contract between the Host and the settings page.
*
* Both halves need the exact same descriptor: the Host registers it on
* `ctx.typert` so the Gateway can dispatch, and the Client mounts it on
* `ctx.remote` so the page can call. Duplicating the shapes is how a rename on
* one side becomes a runtime "no such endpoint" on the other, so this module is
* the single source and both bundles import it.
*
* Validation is hand-rolled on purpose: the Client bundle may not pull a schema
* library, and {@link TypertSchema} only asks for `parse`.
*
* @module dsh-river-provider/remote-wire
*/
/** Namespace every river Remote lives under: `river/<method>`. */
const REMOTE_NAMESPACE = "river";
/** Cordis service key the Gateway resolves the Remote receiver by. */
const REMOTE_SERVICE = "riverAccounts";
// src/remote-service.ts
/**
* The Remote receiver.
*
* Constructing it registers the Cordis service under {@link REMOTE_SERVICE},
* which is the lifetime the markers live for: dispose the fiber and the Gateway
* stops claiming the endpoints.
*/
var RiverRemoteService = class extends TypertRemoteService {
	deps;
	constructor(ctx, deps) {
		super(ctx, REMOTE_SERVICE, { namespace: REMOTE_NAMESPACE });
		this.deps = deps;
	}
	/** The whole settings page, in one round trip. */
	@Remote async state() {
		return this.deps.snapshot();
	}
	/** Re-read the live price table, then answer the state. */
	@Remote async refresh() {
		return this.deps.refresh();
	}
	/** Apply one settings write. */
	@Remote async edit(edit) {
		return this.deps.edit(edit);
	}
	/** Store one account's key. */
	@Remote async setAccountKey(target) {
		return this.deps.setAccountKey(target);
	}
};
// src/index.ts
const name = "llm-river";
const inject = ["llm"];
/** Settings namespace for this provider. */
const NS = "llm-river";
/** Default env var holding the first river.ai key. */
const DEFAULT_API_KEY_ENV = "RIVERAI_API_KEY";
const RiverConfigSchema = markVolatileFields(Schema.object({
	apiBase: Schema.string().description("Base URL of the river.ai API, e.g. https://api.river.ai/v1").default(DEFAULT_API_BASE),
	apiKeyEnv: Schema.string().role("credential-ref").description(`Environment variable holding the first river.ai key.`).default(DEFAULT_API_KEY_ENV),
	apiKey: Schema.string().role("secret").description("Literal river.ai key for the first account. Prefer the env var."),
	accounts: Schema.array(Schema.object({
		label: Schema.string().description("Name shown in rotation status and errors."),
		apiKeyEnv: Schema.string().role("credential-ref").description("Environment variable holding this key."),
		apiKey: Schema.string().role("secret").description("Literal key for this account.")
	})).description("Additional river.ai accounts. Requests rotate across all of them.").default([]),
	activeAccount: Schema.string().description("Pin every request to one account by label or slot id. Leave empty to rotate."),
	modelAccountRules: Schema.array(Schema.object({
		models: Schema.array(Schema.string()).description("Model id or glob pattern."),
		account: Schema.string().description("Account label or slot id.")
	})).description("Route matching models to a fixed account.").default([]),
	requestTimeoutMs: Schema.number().description("Whole-request budget. river.ai documents 15 minutes per response.").default(DEFAULT_REQUEST_TIMEOUT_MS),
	streamIdleTimeoutMs: Schema.number().description("Longest silence tolerated mid-stream. river.ai documents 10 minutes of prefill.").default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	maxOutputTokens: Schema.number().description("Global output ceiling. Omitted means each model uses its own maximum."),
	contextWindowLimit: Schema.number().description("Cap the advertised context window. Leave empty for the model's own capacity (the 1M river publishes). Keep it above maxOutputTokens plus the compaction headroom, or pressure compaction cannot run."),
	defaultReasoningEffort: Schema.dict(Schema.string()).description("Default reasoning effort per model id or glob, e.g. {\"zai-org/GLM-*\": \"max\"}. Only levels river documents for that model are accepted: DeepSeek none|high|max, GLM low|high|max. Anything else is reported as a configuration error instead of being silently changed. \"auto\" keeps the model's own default.").default({}),
	visibleModels: Schema.array(Schema.string()).description("Only show these models in the picker. Empty means the whole catalog.").default([]),
	modelVisibility: Schema.dict(Schema.boolean()).description("Per-model visibility overrides, e.g. {\"zai-org/GLM-5.3-Flash\": false}.").default({})
}));
/** Model ids that carry vision, from the bundled snapshot. */
async function apply(ctx, config) {
	const current = () => config ?? {};
	const prices = new RiverPriceBook();
	const images = new AttachmentImageResolver();
	/**
	* Resolve a credential ref to its value.
	*
	* Per call, never cached: the credential seam is the one place a key edited in
	* the settings panel becomes visible, and caching would freeze a rotated key
	* for the life of the process. The process environment is the fallback for a
	* `.env`-style setup with no credentials provider registered.
	*/
	const resolveRef = async (ref) => {
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const resolved = await credentials.resolve(credentialRef(ref));
			if (resolved !== void 0 && resolved.value !== "") return resolved.value;
		}
		const ambient = process.env[ref];
		return ambient === void 0 || ambient.trim() === "" ? void 0 : ambient;
	};
	/** Build the account slots for the current config. */
	const slots = (raw) => {
		const primary = {
			id: "default",
			label: "Default",
			ref: raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
			literal: raw.apiKey
		};
		const extra = [];
		for (const [index, account] of (raw.accounts ?? []).entries()) {
			const ref = account.apiKeyEnv ?? account.apiKey;
			if (ref === void 0 || ref === "") continue;
			extra.push({
				id: account.apiKeyEnv ?? `account-${index + 2}`,
				label: account.label ?? account.apiKeyEnv ?? `Account ${index + 2}`,
				ref: account.apiKeyEnv ?? `RIVERAI_API_KEY_${index + 2}`,
				literal: account.apiKey
			});
		}
		return [primary, ...extra];
	};
	const pool = new RiverAccountPool({
		slots: () => slots(current()),
		resolveRef,
		preferredId: () => current().activeAccount,
		modelAccountRules: () => current().modelAccountRules ?? []
	});
	const connection = () => {
		const raw = current();
		return {
			apiBase: raw.apiBase ?? "https://api.river.ai/v1",
			requestTimeoutMs: raw.requestTimeoutMs ?? 9e5,
			streamIdleTimeoutMs: raw.streamIdleTimeoutMs ?? 6e5,
			...raw.maxOutputTokens === void 0 ? {} : { maxOutputTokens: raw.maxOutputTokens },
			...raw.contextWindowLimit === void 0 ? {} : { contextWindowLimit: raw.contextWindowLimit }
		};
	};
	/**
	* The configured reasoning effort for one model, validated against the
	* model's own whitelist.
	*
	* Resolved per call from the live config so an edit applies to the next turn
	* without a reload, and `auto`/empty both answer `undefined` — "no opinion",
	* which leaves the model's own default standing.
	*
	* A configured value the model does not accept is a configuration mistake and
	* is reported as one: {@link configuredEffort} throws, which surfaces as a
	* failed `resolveModel` instead of a silently different (and differently
	* priced) reasoning level. Nothing is snapped here — snapping is for requests
	* the harness generates at runtime, where producing nothing is worse.
	*/
	const defaultEffort = (model) => configuredEffort(model, current().defaultReasoningEffort);
	/**
	* The output budget the page shows when none is configured.
	*
	* The largest figure the snapshot knows is the honest answer to "what would
	* this cost me": river's models differ (384K vs 128K) and a single global
	* default can only claim one, so the form shows the ceiling with the model
	* table beside it holding the per-model truth.
	*/
	const defaultMaxOutputTokens = () => knownMaxOutputTokens();
	/**
	* Whether a key resolves for one reference, through the same seam the adapter
	* reads. A failure reads as "not configured": the row still renders, with the
	* reason a user needs to see.
	*/
	const isConfigured = async (ref) => {
		try {
			return (await resolveRef(ref) ?? "").trim() !== "";
		} catch {
			return false;
		}
	};
	const isVisible = (model) => {
		const raw = current();
		const override = raw.modelVisibility?.[model];
		if (override !== void 0) return override;
		const allow = raw.visibleModels ?? [];
		if (allow.length === 0) return true;
		return allow.includes(model);
	};
	const adapter = new RiverAdapter({
		connection,
		images,
		prices,
		isVisible,
		defaultEffort,
		async resolveApiKey(model) {
			const account = model === "" ? await pool.resolveKey({}) : await pool.resolveKey({ model });
			return {
				key: account.key,
				accountId: account.slot.id
			};
		},
		markRejected: (key, rejection, resetAt) => pool.markRejected(normalizeKey(key) ?? key, rejection, resetAt),
		markHealthy: (key) => pool.markHealthy(normalizeKey(key) ?? key),
		log: (message) => ctx.logger.debug?.(`[llm-river] ${message}`)
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "river.ai",
		settingsNs: NS,
		settingsPath: []
	}]);
	ctx.llm.registerAdapter([PROVIDER], adapter);
	const remoteDeps = {
		snapshot: async () => {
			prices.refresh();
			return buildSnapshot({
				provider: PROVIDER,
				config: () => current(),
				defaults: () => ({
					apiBase: current().apiBase ?? "https://api.river.ai/v1",
					contextWindowLimit: current().contextWindowLimit ?? 1048576,
					maxOutputTokens: current().maxOutputTokens ?? defaultMaxOutputTokens()
				}),
				pool,
				slots: () => slots(current()),
				isVisible,
				isConfigured
			});
		},
		async refresh() {
			await prices.refresh();
			return remoteDeps.snapshot();
		},
		async edit(edit) {
			const editDeps = {
				ns: NS,
				settings: () => ctx.get("settings"),
				credentials: () => ctx.get("credentials")
			};
			try {
				await applyEdit(editDeps, edit);
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
			return {
				ok: true,
				snapshot: await remoteDeps.snapshot()
			};
		},
		async setAccountKey(target) {
			const editDeps = {
				ns: NS,
				settings: () => ctx.get("settings"),
				credentials: () => ctx.get("credentials")
			};
			try {
				await storeAccountKey(editDeps, target);
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
			return { ok: true };
		}
	};
	new RiverRemoteService(ctx, remoteDeps);
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.get("settings")?.configure({ auto: true }, ctx.fiber);
	});
	ctx.inject(["commands"], (commandsCtx) => {
		commandsCtx.commands?.register({
			name: "river-accounts",
			description: "Show river.ai account rotation status.",
			async run() {
				const rows = (await pool.describeAccounts()).map((account) => {
					const status = describeState(account);
					return `- ${account.slot.label} (${account.slot.id}) — ${status}`;
				});
				return rows.length === 0 ? "No river.ai accounts configured." : rows.join("\n");
			}
		});
	});
}
/** One account's health, as shown to a human. */
function describeState(account) {
	const state = account.state;
	if (state === void 0) return "ready";
	if (accountUsable(state)) return "ready (cooldown elapsed)";
	if (state.kind === "disabled") return `disabled: ${state.reason}`;
	return `cooling down ${Math.max(0, Math.ceil((state.until - Date.now()) / 1e3))}s: ${state.reason}`;
}
/** True for the pool's "nothing can be attempted" error. */
function isPoolExhausted(error) {
	return error instanceof AllAccountsUnusableError;
}
export { PROVIDER, RiverConfigSchema, apply, inject, isPoolExhausted, name };

//# sourceMappingURL=index.js.map