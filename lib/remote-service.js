/**
 * The Host half of the settings page Remote.
 *
 * The Gateway discovers a Remote Service in "source mode": it walks every live
 * Cordis service, reads the `typertRemote` binding for the wire namespace, and
 * takes the methods marked with the `@Remote` decorator. That is the whole
 * contract — no descriptor registration, no schema artifacts — which is why the
 * methods below are plain async methods with one JSON argument each.
 *
 * Every method answers with the SAME shape the page parses
 * ({@link RiverSnapshot}), built by one builder, so the page cannot render a
 * field the Host never sends.
 *
 * @module dsh-river-provider/remote-service
 */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { REMOTE_NAMESPACE, REMOTE_SERVICE, } from "./remote-wire.js";
/**
 * The Remote receiver.
 *
 * Constructing it registers the Cordis service under {@link REMOTE_SERVICE},
 * which is the lifetime the markers live for: dispose the fiber and the Gateway
 * stops claiming the endpoints.
 */
let RiverRemoteService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _state_decorators;
    let _refresh_decorators;
    let _edit_decorators;
    let _setAccountKey_decorators;
    return class RiverRemoteService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _state_decorators = [Remote];
            _refresh_decorators = [Remote];
            _edit_decorators = [Remote];
            _setAccountKey_decorators = [Remote];
            __esDecorate(this, null, _state_decorators, { kind: "method", name: "state", static: false, private: false, access: { has: obj => "state" in obj, get: obj => obj.state }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _refresh_decorators, { kind: "method", name: "refresh", static: false, private: false, access: { has: obj => "refresh" in obj, get: obj => obj.refresh }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _edit_decorators, { kind: "method", name: "edit", static: false, private: false, access: { has: obj => "edit" in obj, get: obj => obj.edit }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _setAccountKey_decorators, { kind: "method", name: "setAccountKey", static: false, private: false, access: { has: obj => "setAccountKey" in obj, get: obj => obj.setAccountKey }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        deps = __runInitializers(this, _instanceExtraInitializers);
        constructor(ctx, deps) {
            super(ctx, REMOTE_SERVICE, { namespace: REMOTE_NAMESPACE });
            this.deps = deps;
        }
        /** The whole settings page, in one round trip. */
        async state() {
            return this.deps.snapshot();
        }
        /** Re-read the live price table, then answer the state. */
        async refresh() {
            return this.deps.refresh();
        }
        /** Apply one settings write. */
        async edit(edit) {
            return this.deps.edit(edit);
        }
        /** Store one account's key. */
        async setAccountKey(target) {
            return this.deps.setAccountKey(target);
        }
    };
})();
export { RiverRemoteService };
//# sourceMappingURL=remote-service.js.map