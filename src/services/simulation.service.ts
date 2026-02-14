
import { Injectable, computed, signal } from '@angular/core';
import { AcmiData, AcmiObject, InterpolatedState, TimeState } from '../models/acmi.model';
import { wgs84ToEcef, ecefToEnu } from '../utils/coordinates';
import { slerpQuaternion, eulerToQuaternion } from '../utils/interpolation';
import * as THREE from 'three';

// Reusable THREE objects to avoid allocations in the loop
const tempEuler = new THREE.Euler();
const tempVec3_1 = new THREE.Vector3();
const tempVec3_2 = new THREE.Vector3();

/**
 * Service for managing the simulation core.
 * 
 * System Architecture Note (Simulation Module):
 * This service is the heart of the replay engine. It holds the simulation's
 * current time, playback state (playing, speed), and the dataset. Its most
 * critical role is to compute the `interpolatedStates` signal. This signal
 * reactively calculates the position and orientation of every object for the
 * current simulation time, which the rendering engine then consumes.
 */
@Injectable()
export class SimulationService {
  // Signals for reactive state management
  readonly time = signal<number>(0);
  readonly isPlaying = signal<boolean>(false);
  readonly playbackSpeed = signal<number>(1);
  
  readonly duration = signal<number>(0);
  readonly isDataLoaded = signal<boolean>(false);
  
  public readonly acmiData = signal<AcmiData | null>(null);
  
  // ECEF and ENU transformation matrices for coordinate conversion
  private originEcef: THREE.Vector3 | null = null;
  private enuMatrix: THREE.Matrix4 | null = null;
  
  /**
   * A computed signal that provides the interpolated state for all objects
   * at the current simulation time (`this.time()`). This is the primary
   * output of the simulation service, consumed by the renderer.
   */
  public readonly interpolatedStates = computed(() => {
    const data = this.acmiData();
    const simTime = this.time();
    if (!data) {
      return new Map<string, InterpolatedState>();
    }

    const currentStates = new Map<string, InterpolatedState>();
    for (const [id, obj] of data.objects.entries()) {
      const state = this.getInterpolatedState(obj, simTime);
      currentStates.set(id, state);
    }
    return currentStates;
  });

  public loadData(data: AcmiData): void {
    this.acmiData.set(data);
    this.time.set(data.startTime);
    this.duration.set(data.endTime);
    this.isDataLoaded.set(true);

    // Setup coordinate system origin based on the first data point
    this.originEcef = wgs84ToEcef(data.referenceLatitude, data.referenceLongitude, 0);
    this.enuMatrix = ecefToEnu(this.originEcef, data.referenceLatitude, data.referenceLongitude);
  }

  public tick(deltaTime: number): void {
    if (!this.isPlaying() || !this.isDataLoaded()) return;

    this.time.update(t => {
      const newTime = t + deltaTime * this.playbackSpeed();
      return Math.min(newTime, this.duration());
    });
    
    if (this.time() >= this.duration()) {
      this.pause();
    }
  }

  public play(): void {
    if (!this.isDataLoaded()) return;
    if (this.time() >= this.duration()) {
        this.seek(this.acmiData()?.startTime ?? 0);
    }
    this.isPlaying.set(true);
  }

  public pause(): void {
    this.isPlaying.set(false);
  }

  public seek(newTime: number): void {
    if (!this.isDataLoaded()) return;
    this.time.set(Math.max(0, Math.min(newTime, this.duration())));
  }

  public setSpeed(speed: number): void {
    this.playbackSpeed.set(speed);
  }

  public reset(): void {
    this.pause();
    this.acmiData.set(null);
    this.isDataLoaded.set(false);
    this.time.set(0);
    this.duration.set(0);
  }
  
  /**
   * Calculates the interpolated state of a single object for a given time.
   */
  private getInterpolatedState(obj: AcmiObject, time: number): InterpolatedState {
    const isActive = obj.states.length > 0 && time >= obj.states[0].time && (obj.removedAtTime === null || time < obj.removedAtTime);
    
    const defaultState = { id: obj.id, x: 0, y: 0, z: 0, qW: 1, qX: 0, qY: 0, qZ: 0, vX: 0, vY: 0, vZ: 0, color: 'gray', isActive: false, speed: 0, verticalSpeed: 0, heading: 0 };
    if (!isActive) {
      return defaultState;
    }

    // Find the two states to interpolate between
    let i = obj.states.findIndex(s => s.time > time);
    if (i === -1) i = obj.states.length; // After the last state
    
    const s1 = obj.states[Math.max(0, i - 1)];
    const s2 = obj.states[Math.min(obj.states.length - 1, i)];
    
    const timeDelta = s2.time - s1.time;
    const t = timeDelta === 0 ? 1 : (time - s1.time) / timeDelta;

    // Interpolate position (linearly)
    const lon = s1.longitude + (s2.longitude - s1.longitude) * t;
    const lat = s1.latitude + (s2.latitude - s1.latitude) * t;
    const alt = s1.altitude + (s2.altitude - s1.altitude) * t;

    // Convert to local cartesian coordinates
    const ecefPos = wgs84ToEcef(lat, lon, alt);
    const localPos = ecefPos.applyMatrix4(this.enuMatrix!);

    // Interpolate rotation (slerp)
    const q1 = eulerToQuaternion(s1.roll ?? 0, s1.pitch ?? 0, s1.yaw ?? 0);
    const q2 = eulerToQuaternion(s2.roll ?? 0, s2.pitch ?? 0, s2.yaw ?? 0);
    const q = slerpQuaternion(q1, q2, t);

    // Derive speed, vertical speed, and heading
    let speed = 0;
    let verticalSpeed = 0;
    let vX = 0;
    let vY = 0;
    let vZ = 0;
    if (timeDelta > 0) {
      const p1 = wgs84ToEcef(s1.latitude, s1.longitude, s1.altitude).applyMatrix4(this.enuMatrix!);
      const p2 = wgs84ToEcef(s2.latitude, s2.longitude, s2.altitude).applyMatrix4(this.enuMatrix!);
      const distance = p1.distanceTo(p2);
      const velocity = p2.sub(p1).divideScalar(timeDelta);
      vX = velocity.x;
      vY = velocity.y;
      vZ = velocity.z;
      speed = distance / timeDelta;
      verticalSpeed = (s2.altitude - s1.altitude) / timeDelta;
    }

    tempEuler.setFromQuaternion(q, 'ZYX');
    const heading = (THREE.MathUtils.radToDeg(tempEuler.y) + 360) % 360;

    return {
      id: obj.id,
      x: localPos.x,
      y: localPos.y, 
      z: localPos.z,
      qW: q.w,
      qX: q.x,
      qY: q.y,
      qZ: q.z,
      vX,
      vY,
      vZ,
      color: obj.properties.get('Color') || 'cyan',
      isActive: true,
      speed,
      verticalSpeed,
      heading,
    };
  }
}
