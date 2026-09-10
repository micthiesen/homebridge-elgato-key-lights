/** Device color temperatures are mirek; clamp only at the HomeKit boundary. */
export const COLOR_TEMPERATURE = { MIN_MIREK: 143, MAX_MIREK: 344 } as const;
export function clampColorTemperature(value: number): number {
  return Math.max(
    COLOR_TEMPERATURE.MIN_MIREK,
    Math.min(COLOR_TEMPERATURE.MAX_MIREK, value),
  );
}
