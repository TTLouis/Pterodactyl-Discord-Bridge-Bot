import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, ModalBuilder } from "discord.js";
import { getAdministrationState } from "../../core/administration/server-state.js";
import { RelaySettingsService, RelaySettingsError } from "../../core/administration/relay-settings.js";
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const button = (id, text, emoji) => new ButtonBuilder().setCustomId(id).setLabel(text).setEmoji(emoji).setStyle(ButtonStyle.Secondary);
const label = value => String(value).replace(/[`\r\n<>@]/g, " ").slice(0, 80);

/** Discord interaction handling delegates relay rules to the core service. */
export class DiscordRelaySettingsController {
  constructor({ configStore, reply, audit }) { this.service = new RelaySettingsService(configStore); this.reply = reply; this.audit = audit; }
  async handle(interaction, server, action) {
    if (!["relay", "relay-set", "relay-custom", "relay-custom-save"].includes(action)) return false;
    await this.perform(interaction, server, action);
    return true;
  }
  async perform(interaction, server, action) {
    const id = server.pterodactylServerId;
    if (action === "relay") {
      const state = getAdministrationState(server);
      if (!state.relaySupported) return this.reply(interaction, "Chat relay is not supported by the standard integration for this game. Monitoring and power controls remain available.");
      return this.reply(interaction, `Chat relay for ${label(server.name)} is ${server.chatRelay === false || server.chatRelay?.enabled === false ? "off" : "on"}. Standard commands are supplied automatically for this game.`, { components: [
        row(new StringSelectMenuBuilder().setCustomId(`bridge:card:${id}:relay-set`).setPlaceholder("Enable or disable chat relay").addOptions([{ label: "Enable chat relay", value: "on" }, { label: "Disable chat relay", value: "off" }])),
        row(button(`bridge:card:${id}:relay-custom`, "Advanced: custom command", "⚙️"))
      ] });
    }
    if (action === "relay-set") {
      const mode = interaction.values?.[0];
      if (!["on", "off"].includes(mode)) throw new Error("Invalid relay mode");
      try { this.service.setEnabled(id, mode === "on"); }
      catch (error) { if (error instanceof RelaySettingsError) return this.reply(interaction, "This game has no supported default chat relay."); throw error; }
      this.audit("server.relay", interaction, id);
      return this.reply(interaction, `Chat relay ${mode === "on" ? "enabled using this game's command" : "disabled"} for ${label(server.name)}.`, { components: [] });
    }
    if (action === "relay-custom") {
      const field = new TextInputBuilder().setCustomId("template").setLabel("Optional command; blank restores game default").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200);
      if (server.game.chatCommandTemplate) field.setValue(server.game.chatCommandTemplate);
      return interaction.showModal(new ModalBuilder().setCustomId(`bridge:card:${id}:relay-custom-save`).setTitle("Advanced chat relay").addComponents(row(field)));
    }
    if (action === "relay-custom-save") {
      let enabled;
      try { enabled = this.service.setCustomTemplate(id, interaction.fields.getTextInputValue("template")); }
      catch (error) {
        if (!(error instanceof RelaySettingsError)) throw error;
        if (error.code === "invalid-template") return this.reply(interaction, "The relay command must be a single line without control characters.");
        const messages = { "missing-content-placeholder": "A custom command must include {content}.", "invalid-factorio-command": "Factorio custom commands must start with /, such as /shout." };
        return this.reply(interaction, messages[error.code] ?? "This record changed. Refresh its card.");
      }
      this.audit("server.relay-custom", interaction, id);
      return this.reply(interaction, enabled ? "Chat relay command saved and enabled." : "This game has no standard chat relay; relay remains disabled.");
    }
  }
}
