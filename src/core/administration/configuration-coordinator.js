import { CoreEvents } from "../core-events.js";

/** Saved configuration changes notify platforms directly; discovery is independent. */
export class AdministrationConfigurationCoordinator {
  constructor({ eventBus, applyRuntime }) { this.eventBus = eventBus; this.applyRuntime = applyRuntime; }
  async apply(serverId = null) {
    await this.applyRuntime();
    await this.eventBus.emit(CoreEvents.ADMINISTRATION_CONFIGURATION_CHANGED, { serverId });
  }
}
