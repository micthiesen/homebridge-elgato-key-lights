import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
  new URL("../../homebridge-ui/public/app.js", import.meta.url),
  "utf8",
);
function browser(configs: unknown[] = []) {
  const nodes = new Map<
    string,
    {
      innerHTML: string;
      textContent: string;
      value: string;
      disabled: boolean;
      checked: boolean;
      classList: { add: () => void };
    }
  >();
  const get = (id: string) => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: "",
        textContent: "",
        value: "",
        disabled: false,
        checked: true,
        classList: { add: () => {} },
      });
    return nodes.get(id)!;
  };
  const homebridge = {
    addEventListener: vi.fn(),
    getPluginConfig: vi.fn(async () => structuredClone(configs)),
    updatePluginConfig: vi.fn(async (_config: unknown) => {}),
    savePluginConfig: vi.fn(async () => {}),
    request: vi.fn(async (_route: string, _payload: unknown) => ({
      success: true,
      data: { serialNumber: "serial-1", productName: "Elgato Key Light" },
    })),
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
  const context = createContext({
    homebridge,
    document: { getElementById: get },
    console,
    setTimeout,
    clearTimeout,
    MpKit: {
      StatusBadge: {
        online: () => "online",
        offline: () => "offline",
        checking: () => "checking",
        disabled: () => "disabled",
      },
    },
  });
  runInContext(source, context);
  return {
    get,
    homebridge,
    run: (code: string) => runInContext(code, context) as unknown,
  };
}

describe("custom UI browser boundary", () => {
  it("escapes hostile discovery names and API metadata in text and attributes", () => {
    const ui = browser();
    ui.run(
      `renderDevices([{name:'<img src=x onerror=alert(1)>', model:'<script>bad</script>', host:'<svg onload=bad()>', online:true}])`,
    );
    expect(ui.get("deviceList").innerHTML).toContain("&lt;img");
    expect(ui.get("deviceList").innerHTML).not.toContain("<script>");
    ui.run(
      `renderDeviceSettings({name:'" onfocus=bad() x="',displayName:'<img>',mac:'<svg>'}, {serialNumber:'<script>bad</script>'}, null)`,
    );
    expect(ui.get("settingsContent").innerHTML).toContain("&quot; onfocus");
    expect(ui.get("settingsContent").innerHTML).not.toContain('value="<img>"');
    expect(ui.get("settingsContent").innerHTML).not.toContain("<script>");
  });

  it("updates the matching platform while preserving unrelated configuration", async () => {
    const other = { platform: "Other", devices: [{ name: "preserve" }] };
    const ui = browser([
      other,
      { platform: "ElgatoKeyLights", pollingRate: 5000, custom: true },
    ]);
    await ui.run(
      `saveDevicesToConfig([{name:'Desk',serialNumber:'serial-1',host:'192.0.2.1',port:9123}])`,
    );
    expect(ui.homebridge.updatePluginConfig).toHaveBeenCalledWith([
      other,
      {
        platform: "ElgatoKeyLights",
        pollingRate: 5000,
        custom: true,
        devices: [
          expect.objectContaining({ serialNumber: "serial-1", host: "192.0.2.1" }),
        ],
      },
    ]);
  });

  it("manual IP add saves the verified serial identity without requiring mDNS", async () => {
    const ui = browser();
    ui.get("manualIp").value = "192.0.2.1";
    ui.get("manualPort").value = "9123";
    await ui.run("addDeviceByIp()");
    expect(ui.homebridge.updatePluginConfig).toHaveBeenCalledWith([
      expect.objectContaining({
        devices: [
          expect.objectContaining({ serialNumber: "serial-1", ip: "192.0.2.1" }),
        ],
      }),
    ]);
  });

  it("does not save an unverified manual device", async () => {
    const ui = browser();
    ui.homebridge.request.mockRejectedValueOnce(new Error("unreachable"));
    ui.get("manualIp").value = "192.0.2.1";
    await ui.run("addDeviceByIp()");
    expect(ui.homebridge.updatePluginConfig).not.toHaveBeenCalled();
    expect(ui.homebridge.toast.error).toHaveBeenCalledWith(
      expect.stringContaining("unreachable"),
    );
  });

  it("rejects a concurrent save before reading or overwriting config", async () => {
    const ui = browser();
    let release!: () => void;
    ui.homebridge.savePluginConfig.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = ui.run("saveDevicesToConfig([])");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(ui.run("saveDevicesToConfig([])")).rejects.toThrow(
      "already in progress",
    );
    release();
    await first;
    expect(ui.homebridge.updatePluginConfig).toHaveBeenCalledTimes(1);
  });

  it("reports an unconfirmed save as failure instead of success", async () => {
    vi.useFakeTimers();
    try {
      const ui = browser();
      ui.homebridge.savePluginConfig.mockImplementationOnce(
        () => new Promise<void>(() => {}),
      );
      const saving = ui.run("saveDevicesToConfig([])");
      const assertion = expect(saving).rejects.toThrow("Save was not confirmed");
      await vi.advanceTimersByTimeAsync(10000);
      await assertion;
      expect(ui.run("configuredDevices.length")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renaming preserves absent power-on overrides", async () => {
    const ui = browser();
    ui.run(
      `discoveredDevices = [{name:'Desk',serialNumber:'serial-1',host:'192.0.2.1'}]; renderDeviceSettings(discoveredDevices[0], null, null)`,
    );
    ui.get("displayName").value = "New name";
    ui.get("powerOnBehavior").value = "0";
    ui.get("powerOnBrightness").value = "50";
    ui.get("powerOnTemperature").value = "4500";
    await ui.run("saveDeviceSettings(0)");
    expect(ui.homebridge.updatePluginConfig).toHaveBeenCalledWith([
      expect.objectContaining({
        devices: [
          expect.objectContaining({
            displayName: "New name",
            powerOnBehavior: undefined,
            powerOnBrightness: undefined,
            powerOnTemperature: undefined,
          }),
        ],
      }),
    ]);
  });

  it("preserves zero brightness and saves an explicitly moved slider", async () => {
    const ui = browser();
    ui.run(
      `discoveredDevices = [{name:'Desk',serialNumber:'serial-1',host:'192.0.2.1',powerOnBrightness:0}]; renderDeviceSettings(discoveredDevices[0], null, null)`,
    );
    expect(ui.get("settingsContent").innerHTML).toContain('id="brightnessValue">0%');
    ui.get("displayName").value = "Desk";
    ui.get("powerOnBehavior").value = "0";
    ui.get("powerOnBrightness").value = "0";
    ui.get("powerOnTemperature").value = "5000";
    ui.run("updateTemperatureValue('5000')");
    await ui.run("saveDeviceSettings(0)");
    expect(ui.homebridge.updatePluginConfig).toHaveBeenCalledWith([
      expect.objectContaining({
        devices: [
          expect.objectContaining({ powerOnBrightness: 0, powerOnTemperature: 5000 }),
        ],
      }),
    ]);
  });

  it("does not infer offline or online status from mDNS presence alone", () => {
    const ui = browser();
    expect(
      ui.run(`mergeDevices([{serialNumber:'manual',host:'192.0.2.1'}], [])[0].online`),
    ).toBe(null);
    expect(
      ui.run(
        `mergeDevices([], [{mac:'AA:BB:CC:DD:EE:01',host:'192.0.2.1'}])[0].online`,
      ),
    ).toBe(null);
    ui.run(
      `renderDevices(mergeDevices([{name:'Desk',serialNumber:'manual',host:'192.0.2.1'}], []))`,
    );
    expect(ui.get("deviceList").innerHTML).toContain("Not checked");
    expect(ui.get("deviceList").innerHTML).not.toContain("offline");
  });

  it("merges manual and discovered lights only after confirmed identity", () => {
    const ui = browser();
    expect(
      ui.run(
        `mergeDevices([{serialNumber:'serial-1',ip:'192.0.2.1',port:9123}], [{mac:'AA:BB:CC:DD:EE:01',host:'192.0.2.1',port:9123}]).length`,
      ),
    ).toBe(2);
    expect(
      ui.run(
        `mergeDevices([{serialNumber:'serial-1',ip:'192.0.2.1',port:9123}], [{mac:'AA:BB:CC:DD:EE:01',serialNumber:'serial-1',host:'192.0.2.1',port:9123,online:true}]).length`,
      ),
    ).toBe(1);
    expect(
      ui.run(
        `sameDevice({serialNumber:'serial-1',ip:'192.0.2.1',port:9123}, {serialNumber:'serial-2',host:'192.0.2.1',port:9124})`,
      ),
    ).toBe(false);
  });

  it("never matches distinct devices just because both MACs are empty", () => {
    const ui = browser();
    expect(
      ui.run(`sameDevice({mac:'',host:'192.0.2.1'}, {mac:'',host:'192.0.2.2'})`),
    ).toBe(false);
  });
});
