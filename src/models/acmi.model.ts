
/**
 * Represents the state of an object at a specific point in time.
 */
export interface TimeState {
  time: number;
  // WGS84 coordinates
  longitude: number;
  latitude: number;
  altitude: number; // meters
  // Euler angles in degrees
  roll?: number;
  pitch?: number;
  yaw?: number;
}

/**
 * Represents a single object tracked in the ACMI file.
 * It contains metadata and a time-series of its states.
 */
export interface AcmiObject {
  id: string;
  properties: Map<string, string>; // e.g., Name, Type, Color
  states: TimeState[];
  removedAtTime: number | null;
}

/**
 * The final parsed data structure, containing all objects and global metadata.
 */
export interface AcmiData {
  objects: Map<string, AcmiObject>;
  startTime: number;
  endTime: number;
  referenceTime: Date;
  referenceLongitude: number;
  referenceLatitude: number;
}

/**
 * Represents the interpolated state of an object for rendering.
 * Position is in local Cartesian coordinates.
 */
export interface InterpolatedState {
    id: string;
    x: number;
    y: number;
    z: number;
    qW: number;
    qX: number;
    qY: number;
    qZ: number;
    vX: number;
    vY: number;
    vZ: number;
    color: string;
    isActive: boolean;
    // Derived data for UI
    speed: number; // m/s
    verticalSpeed: number; // m/s
    heading: number; // degrees
}
