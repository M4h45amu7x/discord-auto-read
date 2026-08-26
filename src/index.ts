import type { BdApiFacade } from "./betterdiscord";
import { PLUGIN_META } from "./meta";
import { RuntimeController } from "./runtime/controller";
import { SettingsStore } from "./settings/store";

export default class SmartAutoRead {
    private readonly api = new BdApi(PLUGIN_META.name) as BdApiFacade;
    private readonly settings = new SettingsStore(this.api.Data);
    private readonly runtime = new RuntimeController(this.api, this.settings);

    start(): void {
        this.runtime.start();
    }

    stop(): void {
        this.runtime.stop();
    }

    getSettingsPanel(): import("react").ReactElement {
        return this.runtime.createSettingsPanel();
    }
}
