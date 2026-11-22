/** A display window: width, centre (level) and whether the grey scale is reversed. */
export interface WindowSetting {
  w: number;
  c: number;
  invert: boolean;
}

/** Standard CT windows, in Hounsfield units. */
export const CT_PRESETS = [
  { label: 'Soft tissue', w: 400, c: 40 },
  { label: 'Lung', w: 1500, c: -600 },
  { label: 'Bone', w: 1800, c: 400 },
  { label: 'Brain', w: 80, c: 40 },
  { label: 'Angio', w: 700, c: 200 },
  { label: 'Liver', w: 150, c: 90 },
];

/** For series that have no standard windows. */
export const NO_PRESETS: typeof CT_PRESETS = [];
