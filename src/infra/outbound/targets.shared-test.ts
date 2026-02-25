import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveOutboundTarget } from "./targets.js";

export function installResolveOutboundTargetPluginRegistryHooks(): void {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });
}

export function runResolveOutboundTargetCoreTests(): void {
  describe("resolveOutboundTarget", () => {
    installResolveOutboundTargetPluginRegistryHooks();

    it("rejects telegram with missing target", () => {
      const res = resolveOutboundTarget({ channel: "telegram", to: " " });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("Telegram");
      }
    });

    it("rejects webchat delivery", () => {
      const res = resolveOutboundTarget({ channel: "webchat", to: "x" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("WebChat");
      }
    });
  });
}
