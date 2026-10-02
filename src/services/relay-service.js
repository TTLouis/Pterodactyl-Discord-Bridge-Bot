import { randomUUID } from "node:crypto";
import { CoreEvents } from "../core/core-events.js";
import { buildGameChatCommand, formatPlatformRelay, normalizeRelayText, truncateRelayContent, sanitizeAuthorName } from "../lib/chat-relay-formatters.js";
import { MAX_RELAY_QUEUE_LENGTH, MAX_RELAY_RECEIPTS, RELAY_QUEUE_TTL_MS } from "../lib/relay-limits.js";
import { isServerRelayEnabled } from "../lib/server-lifecycle.js";

const routeKey = server => JSON.stringify([
  server.game?.type, server.game?.chatCommandTemplate, server.discordChannelId, server.kookChannelId
]);
const explicitlyDisabled = server => !server || server.archived || server.deleted
  || (server.active === false && !server.unavailable) || server.chatRelay === false || server.chatRelay?.enabled === false;

/** Persistent FIFO delivery, independent of status polling and platform latency. */
export class RelayService {
  constructor({ config, stateStore, eventBus, pterodactylClient, getAdapter, isCurrent,
    logger, kookEnabled = false, now = Date.now, retryBaseMs = 1000 }) {
    Object.assign(this, { config, stateStore, eventBus, pterodactylClient, getAdapter, isCurrent,
      logger, kookEnabled, now, retryBaseMs });
    this.outbox = { ...(stateStore?.getRelayOutbox?.() ?? {}) };
    this.receipts = { ...(stateStore?.getRelayReceipts?.() ?? {}) };
    this.memoryQueues = new Map();
    this.workers = new Map();
    this.targets = new Set(Object.keys(this.outbox));
    this.wakeRequested = new Set();
    this.lifecycle = 0;
    this.timers = new Map();
    this.overflowNotified = new Set();
    this.stopped = true;
    this.recovered = false;
    this.dirty = false;
    this.persistenceNotified = false;
    this.echoes = new Map();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.recovered) {
      this.recovered = true;
      this.#recover();
    }
    this.reconcile();
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.lifecycle++;
    this.wakeRequested.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    // In-flight calls are bounded by transport timeouts. Unfinished checkpoints
    // remain dispatching and are retired as unknown at the next process start.
    let timer;
    await Promise.race([
      Promise.allSettled([...this.workers.values()]),
      new Promise(resolve => { timer = setTimeout(resolve, 2000); })
    ]);
    clearTimeout(timer);
    this.#persist();
  }

  #server(id) { return this.config.servers.find(server => server.pterodactylServerId === id); }
  #target(platform, server) { return `${platform}:${server.pterodactylServerId}`; }
  #parse(target) {
    const index = target.indexOf(":");
    return { platform: target.slice(0, index), serverId: target.slice(index + 1) };
  }
  #queue(target) {
    const { platform, serverId } = this.#parse(target);
    const entries = platform === "game"
      ? (this.stateStore?.getRelayQueue?.(serverId) ?? this.memoryQueues.get(serverId) ?? [])
      : this.outbox[target];
    return Array.isArray(entries) ? [...entries] : [];
  }
  #set(target, entries) {
    this.dirty = true;
    this.targets.add(target);
    const { platform, serverId } = this.#parse(target);
    if (platform === "game") {
      if (this.stateStore?.setRelayQueue) this.stateStore.setRelayQueue(serverId, entries);
      else if (entries.length) this.memoryQueues.set(serverId, entries);
      else this.memoryQueues.delete(serverId);
    } else if (entries.length) this.outbox[target] = entries;
    else delete this.outbox[target];
    if (entries.length < MAX_RELAY_QUEUE_LENGTH) this.overflowNotified.delete(target);
  }
  #persist() {
    if (!this.dirty) return;
    try {
      this.stateStore?.setRelayOutbox?.(this.outbox, this.receipts);
      this.stateStore?.flush?.();
      this.persistenceNotified = false;
      this.dirty = false;
    } catch {
      if (!this.persistenceNotified) {
        this.persistenceNotified = true;
        this.logger.error("Relay persistence failed; dispatch is paused until state can be saved.");
        this.#notice(null, "relay-persistence-failed", { message: "Relay storage could not be saved; dispatch is paused." });
      }
      throw Object.assign(new Error("Relay storage unavailable"), { deliveryStatus: "not-sent" });
    }
  }
  #notice(server, kind, details = {}) {
    const event = { kind, server: server ?? { name: "Bridge" }, ...details };
    const emit = this.eventBus.emitSettled?.bind(this.eventBus) ?? this.eventBus.emit.bind(this.eventBus);
    void Promise.resolve().then(() => emit(CoreEvents.SERVER_NOTICE, event)).catch(() => {
      this.logger.warn("Could not publish relay operator notice", { kind });
    });
  }
  #log(outcome, target, entry) {
    this.logger.info("Relay outcome", { outcome, target, relayId: entry.id,
      queueAgeMs: Math.max(0, this.now() - entry.enqueuedAt), attempts: entry.attempts ?? 0 });
  }
  #remove(target, id) {
    // Always read current state: a network await may have admitted new messages,
    // expired old ones, or cancelled the route.
    this.#set(target, this.#queue(target).filter(entry => entry.id !== id));
  }
  #pruneReceipts(capacity = MAX_RELAY_RECEIPTS) {
    const entries = Object.entries(this.receipts).filter(([, value]) =>
      Number.isFinite(value?.at) && value.at + RELAY_QUEUE_TTL_MS > this.now());
    entries.sort((a, b) => a[1].at - b[1].at);
    const retained = entries.slice(-capacity);
    if (retained.length !== Object.keys(this.receipts).length) this.dirty = true;
    this.receipts = Object.fromEntries(retained);
  }
  #recover() {
    const targets = new Set([...this.targets, ...Object.keys(this.outbox)]);
    for (const server of this.config.servers) targets.add(this.#target("game", server));
    for (const id of Object.keys(this.stateStore?.state?.relayQueue ?? {})) targets.add(`game:${id}`);
    for (const target of targets) {
      const { serverId, platform } = this.#parse(target);
      const server = this.#server(serverId);
      const valid = [];
      let invalid = 0;
      let unknown = 0;
      for (const entry of this.#queue(target)) {
        if (!entry || typeof entry.content !== "string" || !Number.isFinite(entry.enqueuedAt)
          || entry.enqueuedAt > this.now() + 60000 || !server) { invalid++; continue; }
        if (entry.state === "dispatching") { unknown++; continue; }
        if (platform !== "game" && (typeof entry.formattedContent !== "string" || entry.formattedContent.length > 1900
          || entry.channelId !== (platform === "discord" ? server.discordChannelId : server.kookChannelId))) { invalid++; continue; }
        valid.push({ ...entry, authorName: sanitizeAuthorName(entry.authorName),
          content: platform === "game" ? truncateRelayContent(entry.content) : entry.content,
          id: typeof entry.id === "string" && entry.id ? entry.id : randomUUID(), state: "pending", serverId,
          route: entry.route ?? routeKey(server) });
      }
      if (valid.length > MAX_RELAY_QUEUE_LENGTH) {
        invalid += valid.length - MAX_RELAY_QUEUE_LENGTH;
        valid.splice(0, valid.length - MAX_RELAY_QUEUE_LENGTH);
      }
      this.#set(target, valid);
      if (invalid || unknown) this.#notice(server, "relay-restored-discarded", { count: invalid + unknown,
        message: `${invalid} invalid and ${unknown} uncertain restored relay entries were withheld.` });
    }
    this.#pruneReceipts();
    this.#persist();
  }

  accept(message) {
    if (this.stopped) return false;
    const sourcePlatform = message.sourcePlatform === "kook" ? "kook" : "discord";
    const server = this.config.servers.find(entry => isServerRelayEnabled(entry) &&
      (sourcePlatform === "kook" ? entry.kookChannelId : entry.discordChannelId) === message.channelId);
    const content = normalizeRelayText(message.content, sourcePlatform);
    if (!server || !content) return false; // Text-only; attachments/edits are outside relay scope.
    this.#pruneReceipts();
    const receipt = message.messageId ? JSON.stringify([sourcePlatform, message.channelId, message.messageId]) : null;
    if (receipt && this.receipts[receipt]) return false;
    if (receipt) this.#pruneReceipts(MAX_RELAY_RECEIPTS - 1);
    const relay = { id: randomUUID(), sourcePlatform, authorName: sanitizeAuthorName(message.authorName),
      authorColor: message.authorColor ?? null, platformColor: message.platformColor ?? null,
      content, enqueuedAt: this.now(), serverId: server.pterodactylServerId, route: routeKey(server), state: "pending" };
    const targets = this.#enqueuePlatforms(server, relay);
    if (["factorio", "minecraft", "source"].includes(server.game?.type)) {
      const gameRelay = { ...relay, content: truncateRelayContent(content) };
      try {
        if (buildGameChatCommand(server, gameRelay)) {
          const target = this.#target("game", server);
          this.#enqueue(target, gameRelay);
          targets.push(target);
        }
      } catch {
        this.#notice(server, "relay-failed", { message: "Game relay command is invalid or too long." });
      }
    } else if (server.game?.chatCommandTemplate) {
      this.#notice(server, "relay-failed", { message: "This game has no supported console chat delivery." });
    }
    if (receipt) {
      this.receipts[receipt] = { at: this.now(), id: relay.id };
      this.dirty = true;
    }
    // Acceptance and all destination queues are saved in one state-file write.
    try { this.#persist(); }
    catch (error) {
      for (const target of targets) this.#retry(target, this.retryBaseMs);
      throw error;
    }
    for (const target of targets) this.wake(target);
    return true;
  }

  acceptGame(server, message) {
    if (this.stopped || !isServerRelayEnabled(server)) return;
    const relay = { ...message, authorName: sanitizeAuthorName(message.authorName),
      content: normalizeRelayText(message.content), id: randomUUID(), sourcePlatform: "game", enqueuedAt: this.now(),
      serverId: server.pterodactylServerId, route: routeKey(server), state: "pending" };
    const targets = this.#enqueuePlatforms(server, relay);
    try { this.#persist(); }
    catch (error) {
      for (const target of targets) this.#retry(target, this.retryBaseMs);
      throw error;
    }
    for (const target of targets) this.wake(target);
  }
  #enqueuePlatforms(server, relay) {
    const targets = [];
    for (const platform of ["discord", "kook"]) {
      const channelId = platform === "discord" ? server.discordChannelId : server.kookChannelId;
      if (platform === relay.sourcePlatform || !channelId || (platform === "kook" && !this.kookEnabled)) continue;
      const target = this.#target(platform, server);
      const parts = formatPlatformRelay(relay, platform);
      parts.forEach((formattedContent, part) => this.#enqueue(target, {
        ...relay, id: `${relay.id}:${platform}:${part}`, channelId, formattedContent
      }));
      targets.push(target);
    }
    return targets;
  }
  #enqueue(target, entry) {
    this.expireTarget(target);
    const queue = this.#queue(target);
    queue.push(entry);
    let dropped = 0;
    while (queue.length > MAX_RELAY_QUEUE_LENGTH) {
      const index = queue.findIndex(item => item.state !== "dispatching");
      if (index < 0) break;
      queue.splice(index, 1);
      dropped++;
    }
    this.#set(target, queue);
    if (dropped && !this.overflowNotified.has(target)) {
      this.overflowNotified.add(target);
      this.#notice(this.#server(entry.serverId), "relay-queue-overflow", { limit: MAX_RELAY_QUEUE_LENGTH, target });
    }
    this.#log("queued", target, entry);
  }
  expireTarget(target) {
    const queue = this.#queue(target);
    const retained = queue.filter(entry => entry.state === "dispatching" || entry.enqueuedAt + RELAY_QUEUE_TTL_MS > this.now());
    if (retained.length !== queue.length) {
      this.#set(target, retained);
      this.#notice(this.#server(this.#parse(target).serverId), "relay-queue-expired", {
        expiredCount: queue.length - retained.length, target
      });
    }
  }
  expire(server) { this.expireTarget(this.#target("game", server)); this.#persist(); }

  reconcile() {
    if (!this.recovered) { this.recovered = true; this.#recover(); }
    const targets = new Set([...this.targets, ...Object.keys(this.outbox)]);
    for (const server of this.config.servers) targets.add(this.#target("game", server));
    for (const id of Object.keys(this.stateStore?.state?.relayQueue ?? {})) targets.add(`game:${id}`);
    for (const id of this.memoryQueues.keys()) targets.add(`game:${id}`);
    for (const target of targets) {
      const server = this.#server(this.#parse(target).serverId);
      const queue = this.#queue(target);
      const retained = queue.filter(entry => !explicitlyDisabled(server) && entry.route === routeKey(server));
      if (queue.length !== retained.length) {
        this.#set(target, retained);
        this.#notice(server, "relay-cancelled", { count: queue.length - retained.length,
          message: `${queue.length - retained.length} pending relays cancelled after a configuration change.` });
      }
      this.expireTarget(target);
      this.wake(target);
    }
    this.#persist();
  }

  flush(server) { return this.wake(this.#target("game", server)); }
  wake(target) {
    if (this.stopped) return;
    if (this.workers.has(target)) {
      this.wakeRequested.add(target);
      return this.workers.get(target);
    }
    const worker = Promise.resolve().then(() => this.#drain(target)).catch(error => {
      this.logger.error("Relay worker paused", { target, error: error.message });
      this.#retry(target, this.retryBaseMs);
    }).finally(() => {
      if (this.workers.get(target) === worker) this.workers.delete(target);
      if (this.wakeRequested.delete(target)) this.wake(target);
    });
    this.workers.set(target, worker);
    return worker;
  }
  #retry(target, delay) {
    if (this.stopped || this.timers.has(target)) return;
    const timer = setTimeout(() => { this.timers.delete(target); this.wake(target); }, delay);
    timer.unref?.();
    this.timers.set(target, timer);
  }
  #eligible(target, entry) {
    const { platform, serverId } = this.#parse(target);
    const server = this.#server(serverId);
    if (this.stopped || !isServerRelayEnabled(server ?? {}) || explicitlyDisabled(server)
      || entry.route !== routeKey(server) || !this.#queue(target).some(item => item.id === entry.id)) return false;
    const adapter = this.getAdapter(serverId);
    return platform !== "game" || (Boolean(adapter) && this.isCurrent(server, adapter)
      && this.pterodactylClient.isConsoleSessionReady?.(serverId));
  }
  async #drain(target) {
    while (!this.stopped) {
      this.expireTarget(target);
      const entry = this.#queue(target)[0];
      if (!entry) { this.#persist(); return; }
      if (!this.#eligible(target, entry)) { this.#retry(target, 1000); return; }
      if (entry.retryAt > this.now()) { this.#retry(target, entry.retryAt - this.now()); return; }
      const { platform, serverId } = this.#parse(target);
      const server = this.#server(serverId);
      let dispatched = false;
      let echoCommand = null;
      const lifecycle = this.lifecycle;
      const isCurrent = () => lifecycle === this.lifecycle && this.#eligible(target, entry);
      const onDispatch = () => {
        if (!isCurrent()) throw Object.assign(new Error("Relay route is paused or obsolete"), { deliveryStatus: "not-sent" });
        const queue = this.#queue(target);
        const current = queue.find(item => item.id === entry.id);
        current.state = "dispatching";
        this.#set(target, queue);
        this.#persist();
        dispatched = true;
        if (echoCommand) this.#rememberEcho(serverId, echoCommand);
      };
      let outcome;
      try {
        if (platform === "game") {
          const command = buildGameChatCommand(server, entry);
          echoCommand = command;
          if (!command) outcome = { status: "rejected" };
          else if (this.pterodactylClient.runRelayCommand) {
            outcome = await this.pterodactylClient.runRelayCommand(serverId, command, { isCurrent, onDispatch });
          } else {
            // Compatibility for older/custom transports. An error after this
            // checkpoint cannot safely be retried.
            const adapter = this.getAdapter(serverId);
            if (!adapter?.handleChatCommand && !adapter?.handleChatMessage) outcome = { status: "rejected" };
            else {
              onDispatch();
              if (adapter.handleChatCommand) await adapter.handleChatCommand(command);
              else await adapter.handleChatMessage({ ...entry, command });
              outcome = { status: "dispatched" };
            }
          }
        } else {
          const payload = { ...entry, server, destinationPlatform: platform, isCurrent, onDispatch };
          const event = entry.sourcePlatform === "game" ? CoreEvents.GAME_CHAT_RELAY : CoreEvents.GROUP_CHAT_RELAY;
          const results = this.eventBus.emitSettled
            ? await this.eventBus.emitSettled(event, payload)
            : (await this.eventBus.emit(event, payload)).map(value => ({ status: "fulfilled", value }));
          const failure = results.find(result => result.status === "rejected");
          if (failure) throw failure.reason;
          if (!results.some(result => result.value?.platform === platform)) {
            throw Object.assign(new Error("Relay destination has no active listener"), { deliveryStatus: "not-sent" });
          }
          outcome = { status: "dispatched" };
        }
      } catch (error) {
        outcome = { status: error.deliveryStatus ?? (dispatched ? "unknown" : "not-sent"), permanent: error.permanent,
          retryAfter: Number(error.retryAfter ?? 0) };
      }
      if (outcome.status === "not-sent" && !outcome.permanent) {
        const queue = this.#queue(target);
        const pending = queue.find(item => item.id === entry.id);
        if (!pending) continue;
        pending.state = "pending";
        pending.attempts = (pending.attempts ?? 0) + 1;
        const delay = Math.max(Number.isFinite(outcome.retryAfter) ? outcome.retryAfter : 0,
          Math.min(30000, this.retryBaseMs * 2 ** Math.min(pending.attempts - 1, 5)));
        pending.retryAt = this.now() + delay;
        this.#set(target, queue);
        this.#persist();
        this.#log("retry", target, pending);
        this.#retry(target, delay);
        return;
      }
      this.#remove(target, entry.id);
      this.#persist();
      this.#log(outcome.status, target, entry);
      if (outcome.status !== "dispatched") this.#notice(server,
        outcome.status === "unknown" ? "relay-uncertain" : "relay-failed", {
          message: outcome.status === "unknown" ? "Delivery is uncertain; this message will not be resent." : "Relay destination rejected a message.", target
        });
    }
  }

  #rememberEcho(serverId, command) {
    const entries = (this.echoes.get(serverId) ?? []).filter(entry => entry.until > this.now());
    const text = command.replace(/^\/(?:say|shout)\s+/i, "").replace(/\[\/?color(?:=#[0-9a-f]{6})?\]/gi, "");
    entries.push({ text, until: this.now() + 30000 });
    this.echoes.set(serverId, entries.slice(-100));
  }
  isEcho(serverId, message) {
    if (!/^(?:<?server>?|server console|console)$/i.test(message.authorName)) return false;
    const content = message.content.replace(/\[\/?color(?:=#[0-9a-f]{6})?\]/gi, "");
    const entries = (this.echoes.get(serverId) ?? []).filter(entry => entry.until > this.now());
    const index = entries.findIndex(entry => entry.text === content);
    if (index < 0) { this.echoes.set(serverId, entries); return false; }
    entries.splice(index, 1);
    this.echoes.set(serverId, entries);
    return true;
  }
}
