
import * as THREE from 'three';

// WGS84 ellipsoid parameters
const A = 6378137.0; // Semi-major axis
const F = 1 / 298.257223563; // Flattening
const B = A * (1 - F); // Semi-minor axis
const E2 = F * (2 - F); // Square of eccentricity

/**
 * Converts WGS84 coordinates (latitude, longitude, altitude) to
 * Earth-Centered, Earth-Fixed (ECEF) Cartesian coordinates.
 * @param lat Latitude in degrees
 * @param lon Longitude in degrees
 * @param alt Altitude in meters
 * @returns THREE.Vector3 representing ECEF coordinates (x, y, z)
 */
export function wgs84ToEcef(lat: number, lon: number, alt: number): THREE.Vector3 {
  const latRad = THREE.MathUtils.degToRad(lat);
  const lonRad = THREE.MathUtils.degToRad(lon);
  const cosLat = Math.cos(latRad);
  const sinLat = Math.sin(latRad);
  const cosLon = Math.cos(lonRad);
  const sinLon = Math.sin(lonRad);

  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  
  const x = (n + alt) * cosLat * cosLon;
  const y = (n + alt) * cosLat * sinLon;
  const z = (n * (1 - E2) + alt) * sinLat;

  return new THREE.Vector3(x, y, z);
}

/**
 * Creates a transformation matrix to convert from ECEF coordinates to a local
 * East-North-Up (ENU) frame, centered at a given origin.
 * @param originEcef The origin of the local frame in ECEF coordinates
 * @param lat The latitude of the origin in degrees
 * @param lon The longitude of the origin in degrees
 * @returns THREE.Matrix4 for ECEF-to-ENU transformation
 */
export function ecefToEnu(originEcef: THREE.Vector3, lat: number, lon: number): THREE.Matrix4 {
  const latRad = THREE.MathUtils.degToRad(lat);
  const lonRad = THREE.MathUtils.degToRad(lon);
  const cosLat = Math.cos(latRad);
  const sinLat = Math.sin(latRad);
  const cosLon = Math.cos(lonRad);
  const sinLon = Math.sin(lonRad);
  
  // The matrix is composed of the east, north, and up vectors
  const east = new THREE.Vector3(-sinLon, cosLon, 0);
  const north = new THREE.Vector3(-sinLat * cosLon, -sinLat * sinLon, cosLat);
  const up = new THREE.Vector3(cosLat * cosLon, cosLat * sinLon, sinLat);

  const rotationMatrix = new THREE.Matrix4().makeBasis(east, north, up).transpose();
  const translationMatrix = new THREE.Matrix4().makeTranslation(-originEcef.x, -originEcef.y, -originEcef.z);
  
  // First translate, then rotate
  return rotationMatrix.multiply(translationMatrix);
}
