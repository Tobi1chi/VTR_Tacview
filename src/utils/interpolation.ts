
import * as THREE from 'three';

const tempEuler = new THREE.Euler();
const tempQuaternion = new THREE.Quaternion();

/**
 * Converts Euler angles (in degrees) to a THREE.Quaternion.
 * The order of rotation is Yaw-Pitch-Roll (ZYX), common in aviation.
 * @param roll Degrees
 * @param pitch Degrees
 * @param yaw Degrees
 * @returns THREE.Quaternion
 */
export function eulerToQuaternion(roll: number, pitch: number, yaw: number): THREE.Quaternion {
  const rollRad = THREE.MathUtils.degToRad(roll);
  const pitchRad = THREE.MathUtils.degToRad(pitch);
  const yawRad = THREE.MathUtils.degToRad(-yaw);
  
  // Tacview uses YAW, PITCH, ROLL order
  return tempQuaternion.clone().setFromEuler(tempEuler.set(pitchRad, yawRad, rollRad, 'ZYX'));
}

/**
 * Performs Spherical Linear Interpolation (SLERP) between two quaternions.
 * @param q1 Start quaternion
 * @param q2 End quaternion
 * @param t Interpolation factor (0 to 1)
 * @returns Interpolated THREE.Quaternion
 */
export function slerpQuaternion(q1: THREE.Quaternion, q2: THREE.Quaternion, t: number): THREE.Quaternion {
  return new THREE.Quaternion().copy(q1).slerp(q2, t);
}
