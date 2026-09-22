export interface TrackPoint {
  lat: number
  lon: number
  timestamp: number   // Unix ms
}

export interface VesselTrack {
  mmsi: string
  points: TrackPoint[]  // ordered oldest → newest, max 120 points
}
