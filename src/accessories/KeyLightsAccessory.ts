import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import type { KeyLightsPlatform } from "../platform/KeyLightsPlatform.js";
import type { KeyLightInstance } from "../devices/KeyLightInstance.js";
import { COLOR_TEMPERATURE, clampColorTemperature } from "../config/constants.js";
import type { LightState } from "../protocol/client.js";

/** HomeKit is a Promise/callback boundary; device work remains scoped Effect. */
export class KeyLightsAccessory {
  private readonly service: Service;
  constructor(
    private readonly platform: KeyLightsPlatform,
    readonly accessory: PlatformAccessory,
    readonly device: KeyLightInstance,
    readonly name: string,
  ) {
    const { Service, Characteristic } = platform;
    this.service =
      accessory.getService(Service.Lightbulb) ??
      accessory.addService(Service.Lightbulb);
    this.service.setCharacteristic(Characteristic.Name, name);
    this.service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    this.service.updateCharacteristic(Characteristic.ConfiguredName, name);
    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.read("on") === 1)
      .onSet((value) => this.write("on", value));
    this.service
      .getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.read("brightness"))
      .onSet((value) => this.write("brightness", value));
    this.service
      .getCharacteristic(Characteristic.ColorTemperature)
      .updateValue(clampColorTemperature(device.snapshot.light?.temperature ?? 213))
      .setProps({
        minValue: COLOR_TEMPERATURE.MIN_MIREK,
        maxValue: COLOR_TEMPERATURE.MAX_MIREK,
      })
      .onGet(() => clampColorTemperature(this.read("temperature")))
      .onSet((value) => this.write("temperature", value));
    accessory.on("identify", () => {
      void platform
        .command(device, device.identify())
        .catch((error) => platform.log.debug(`Identify failed: ${String(error)}`));
    });
    this.update();
  }
  private unavailable() {
    return new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }
  private read(key: keyof LightState): number {
    const snapshot = this.device.snapshot;
    if (snapshot.status !== "online" || !snapshot.light) throw this.unavailable();
    return snapshot.light[key];
  }
  private write(key: keyof LightState, value: CharacteristicValue): Promise<void> {
    const numeric = key === "on" ? (value ? 1 : 0) : value;
    if (typeof numeric !== "number" || !Number.isFinite(numeric))
      return Promise.reject(this.unavailable());
    const patch = key === "on" ? { on: numeric as 0 | 1 } : { [key]: numeric };
    return this.platform
      .command(this.device, this.device.setProperty(patch))
      .catch(() => {
        throw this.unavailable();
      });
  }
  /** Called from the platform's serialized snapshot boundary. */
  update(): void {
    const { Characteristic, Service } = this.platform;
    const snapshot = this.device.snapshot;
    if (snapshot.info) {
      const info =
        this.accessory.getService(Service.AccessoryInformation) ??
        this.accessory.addService(Service.AccessoryInformation);
      info
        .setCharacteristic(Characteristic.Manufacturer, "Elgato")
        .setCharacteristic(Characteristic.Model, snapshot.info.productName)
        .setCharacteristic(Characteristic.SerialNumber, snapshot.info.serialNumber)
        .setCharacteristic(
          Characteristic.FirmwareRevision,
          snapshot.info.firmwareVersion || "unknown",
        );
    }
    const state = snapshot.status === "online" ? snapshot.light : undefined;
    this.service
      .getCharacteristic(Characteristic.On)
      .updateValue(state ? state.on === 1 : this.unavailable());
    this.service
      .getCharacteristic(Characteristic.Brightness)
      .updateValue(state ? state.brightness : this.unavailable());
    this.service
      .getCharacteristic(Characteristic.ColorTemperature)
      .updateValue(
        state ? clampColorTemperature(state.temperature) : this.unavailable(),
      );
  }
}
