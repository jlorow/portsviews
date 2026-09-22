export type VesselType =
  | 'cargo'
  | 'tanker'
  | 'cruise'
  | 'ferry'
  | 'tugboat'
  | 'naval'
  | 'unknown'

export interface VesselGlyphSpec {
  type: VesselType
  baseSize: number      // reference size in pixels at 1920px canvas width
  color: string         // hex color
  isNotable: boolean    // notable vessels use accent color #7EC8C8
}

export const VESSEL_COLORS: Record<VesselType, string> = {
  cargo:   '#0AA0FF',
  tanker:  '#FF7A1A',
  cruise:  '#00B388',
  ferry:   '#8C4CE0',
  tugboat: '#D93B4A',
  naval:   '#9C9478',
  unknown: '#C8D8F0',
}

export const NOTABLE_COLOR = '#7EC8C8'

// The one dark value used to separate a drawn thing from whatever is
// behind it: VIS-8's hero-label shadow, and its outline on stopped-vessel
// dots and the unknown silhouette. Deliberately not '#000000' -- a
// slightly blue-black reads as an edge rather than as a hole punched in
// the canvas. It lives here, beside the palette it is used against, so
// there is exactly one such value rather than a second literal wherever
// it is next needed.
export const DARK_OUTLINE_COLOR = '#0A0E14'

export const VESSEL_BASE_SIZES: Record<VesselType, number> = {
  cargo:   120,  // was 28
  tanker:  110,  // was 26
  cruise:  130,  // was 30
  ferry:   90,   // was 20
  tugboat: 70,   // was 14
  naval:   100,  // was 22
  unknown: 80,   // was 16
}
