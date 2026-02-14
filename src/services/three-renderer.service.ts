
import { Injectable, NgZone, signal } from '@angular/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { InterpolatedState, AcmiObject } from '../models/acmi.model';

enum UnitCategory { Aircraft, Ground, Ship, Missile, Unknown }

/**
 * Service for managing the Three.js rendering engine.
 *
 * System Architecture Note (Rendering Module):
 * This service is responsible for all 3D visualization. It creates the Three.js
 * scene, manages the camera and lights, and contains the core rendering loop.
 * The `updateObjects` method is crucial; it efficiently synchronizes the 3D scene
 * with the simulation state provided by the SimulationService, creating, updating,
 * and removing 3D objects as needed without re-creating them every frame.
 */
@Injectable()
export class ThreeRendererService {
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;

  private objectMeshes = new Map<string, THREE.Group>();
  private tempQuaternion = new THREE.Quaternion();
  private tempQuaternion2 = new THREE.Quaternion();
  private tempEuler = new THREE.Euler();
  private tempDirection = new THREE.Vector3();
  private modelForward = new THREE.Vector3(0, 0, -1);
  private nonAircraftRollOffsetDeg = 0;
  private modelScaleMultiplier = 4;
  private enuToThreeQuat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().set(
      1, 0, 0, 0,
      0, 0, 1, 0,
      0, -1, 0, 0,
      0, 0, 0, 1
    )
  );
  private enuToThreeQuatInv = this.enuToThreeQuat.clone().invert();
  private groundPlaneY = -1;
  private minHeightAboveGround = 10;
  private extraGroundOffsets = new Map<string, number>([
    ['vtolvr_EscortCruiser.obj', 80],
    ['Watercraft.CVN-74.obj', 120],
  ]);

  // Camera follow state
  public readonly followTargetId = signal<string | null>(null);
  private followOffset = new THREE.Vector3(0, 300, 700); // Static offset for follow cam
  private followSmoothingFactor = 0.05; // Value between 0 and 1 for lerp

  // Keyboard controls state
  private keyStates = new Map<string, boolean>();
  private moveSpeed = 500; // units per second
  private tempMoveVector = new THREE.Vector3();
  private tempCamVector = new THREE.Vector3();

  // Model loading
  private loader = new OBJLoader();
  private modelCache = new Map<string, THREE.Group>();
  private modelsLoaded = signal(false);
  private assetBaseUrl = new URL('.', document.baseURI);

  // Dynamic model loading cache
  private loadedShapes = new Map<string, THREE.Group>();
  private shapeLoadPromises = new Map<string, Promise<THREE.Group>>();

  public initialize(canvas: HTMLCanvasElement): void {
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a202c); // Dark blue-gray
    this.scene.fog = new THREE.Fog(0x1a202c, 20000, 100000);

    // Camera
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 10, 200000);
    this.camera.position.set(0, 500, 1000);
    this.camera.lookAt(0, 0, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this._preloadModels();

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.screenSpacePanning = false;

    // Automatically disable follow mode when user interacts with camera controls
    this.controls.addEventListener('start', () => {
      this.followTargetId.set(null);
    });

    // Keyboard Listeners
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(1, 1, 1).normalize();
    this.scene.add(directionalLight);

    // Ground Plane
    const groundGeometry = new THREE.PlaneGeometry(100000, 100000);
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x2d3748 });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1; // Slightly below origin
    this.scene.add(ground);

    // Grid Helper
    const grid = new THREE.GridHelper(100000, 100, 0x4a5568, 0x4a5568);
    this.scene.add(grid);

    window.addEventListener('resize', this.onWindowResize.bind(this));
  }

  public render(deltaTime: number): void {
    this.updateCameraFromKeyboard(deltaTime);
    this.updateFollowCamera();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  public updateObjects(states: Map<string, InterpolatedState>, allObjects: Map<string, AcmiObject>): void {
    if (!this.modelsLoaded()) return; // Don't try to render objects until models are ready

    for (const [id, state] of states.entries()) {
      let group = this.objectMeshes.get(id);

      if (!group) {
        const acmiObject = allObjects.get(id);
        if (acmiObject) {
          group = this._createUnitMesh(acmiObject);
          this.objectMeshes.set(id, group);
          this.scene.add(group);
        }
      }

      if (group) {
        group.visible = state.isActive;
        if (state.isActive) {
          // Map ENU (Z-up, Y-north) to Three.js (Y-up, Z-south from camera)
          const acmiObject = allObjects.get(id);
          const extraOffset = this._getExtraGroundOffset(acmiObject);
          const minY = this.groundPlaneY + this.minHeightAboveGround + extraOffset;
          const clampedY = Math.max(state.z, minY);
          group.position.set(state.x, clampedY, -state.y);
          this.tempDirection.set(state.vX, state.vZ, -state.vY);
          if (this.tempDirection.lengthSq() < 1e-6) {
            this.tempDirection.copy(this.modelForward);
          } else {
            this.tempDirection.normalize();
          }
          this.tempQuaternion.setFromUnitVectors(this.modelForward, this.tempDirection);
          this.tempQuaternion2.set(state.qX, state.qY, state.qZ, state.qW);
          this.tempEuler.setFromQuaternion(this.tempQuaternion2, 'ZYX');
          const isAircraft = acmiObject && this._getUnitCategory(acmiObject) === UnitCategory.Aircraft;
          const rollOffsetRad = isAircraft ? 0 : THREE.MathUtils.degToRad(this.nonAircraftRollOffsetDeg);
          const rollRad = this.tempEuler.z - rollOffsetRad;
          this.tempQuaternion2.setFromAxisAngle(this.tempDirection, rollRad);
          this.tempQuaternion2.multiply(this.tempQuaternion);
          group.setRotationFromQuaternion(this.tempQuaternion2);
        }
      }
    }
  }

  public setFollowTarget(id: string | null): void {
    if (this.followTargetId() === id) {
      this.followTargetId.set(null); // Toggle off if same id is selected
    } else {
      this.followTargetId.set(id);
    }
  }

  private updateFollowCamera(): void {
    const targetId = this.followTargetId();
    if (!targetId) return;

    const targetMesh = this.objectMeshes.get(targetId);
    if (!targetMesh || !targetMesh.visible) {
      // If target is invalid or not visible, stop following
      this.followTargetId.set(null);
      return;
    }

    // Calculate desired camera position based on static offset
    const desiredPosition = targetMesh.position.clone().add(this.followOffset);

    // Smoothly interpolate camera position and controls target
    this.camera.position.lerp(desiredPosition, this.followSmoothingFactor);
    this.controls.target.lerp(targetMesh.position, this.followSmoothingFactor);
  }

  public focusOnObject(state: InterpolatedState): void {
    if (!this.controls) return;
    const objectPosition = new THREE.Vector3(state.x, state.z, -state.y);
    this.controls.target.copy(objectPosition);
    this.camera.position.set(
      objectPosition.x,
      objectPosition.y + 400, // Look from above
      objectPosition.z + 800  // and behind
    );
    this.controls.update();
  }

  public destroy(): void {
    window.removeEventListener('resize', this.onWindowResize.bind(this));
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.renderer.dispose();
  }

  private onWindowResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private onKeyDown(event: KeyboardEvent): void {
    this.keyStates.set(event.code, true);
  }

  private onKeyUp(event: KeyboardEvent): void {
    this.keyStates.set(event.code, false);
  }

  private updateCameraFromKeyboard(deltaTime: number): void {
    this.tempMoveVector.set(0, 0, 0);
    let isMoving = false;

    // Forward/Backward
    if (this.keyStates.get('KeyW')) {
      this.camera.getWorldDirection(this.tempCamVector);
      this.tempMoveVector.add(this.tempCamVector);
      isMoving = true;
    }
    if (this.keyStates.get('KeyS')) {
      this.camera.getWorldDirection(this.tempCamVector);
      this.tempMoveVector.sub(this.tempCamVector);
      isMoving = true;
    }
    // Strafe Left/Right
    if (this.keyStates.get('KeyA')) {
      this.camera.getWorldDirection(this.tempCamVector);
      this.tempCamVector.cross(this.camera.up);
      this.tempMoveVector.sub(this.tempCamVector);
      isMoving = true;
    }
    if (this.keyStates.get('KeyD')) {
      this.camera.getWorldDirection(this.tempCamVector);
      this.tempCamVector.cross(this.camera.up);
      this.tempMoveVector.add(this.tempCamVector);
      isMoving = true;
    }
    // Up/Down
    if (this.keyStates.get('Space')) {
      this.tempMoveVector.y += 1;
      isMoving = true;
    }
    if (this.keyStates.get('ControlLeft') || this.keyStates.get('ControlRight')) {
      this.tempMoveVector.y -= 1;
      isMoving = true;
    }

    if (isMoving) {
      // Disable follow mode if user moves camera
      this.followTargetId.set(null);

      const speedMultiplier = this.keyStates.get('ShiftLeft') || this.keyStates.get('ShiftRight') ? 4 : 1;
      const moveDistance = this.moveSpeed * speedMultiplier * deltaTime;

      this.tempMoveVector.normalize().multiplyScalar(moveDistance);

      this.camera.position.add(this.tempMoveVector);
      this.controls.target.add(this.tempMoveVector);
    }
  }

  private async _preloadModels(): Promise<void> {
    const modelsToLoad = new Map<UnitCategory, { fileName: string, targetSize: number, rotate: boolean }>([
      [UnitCategory.Aircraft, { fileName: 'vtolvr_F-45A.obj', targetSize: 120, rotate: true }],
      [UnitCategory.Missile, { fileName: 'vtolvr_SAAW.obj', targetSize: 50, rotate: true }],
      [UnitCategory.Ground, { fileName: 'vtolvr_enemyMBT1.obj', targetSize: 40, rotate: false }],
      [UnitCategory.Ship, { fileName: 'vtolvr_AlliedCarrier.obj', targetSize: 250, rotate: false }],
    ]);

    try {
      for (const [category, config] of modelsToLoad.entries()) {
        try {
          const modelPaths = this._buildModelPaths(config.fileName);
          const group = await this._loadObjWithFallbacks(modelPaths);

          // Post-process: center and scale
          const box = new THREE.Box3().setFromObject(group);
          const center = box.getCenter(new THREE.Vector3());
          group.traverse(child => {
            if (child instanceof THREE.Mesh) {
              child.geometry.translate(-center.x, -center.y, -center.z);
            }
          });

          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);
          if (maxDim > 0) {
            const scale = config.targetSize / maxDim;
            group.scale.set(scale, scale, scale);
          }

          if (config.rotate) {
            group.rotation.x = Math.PI / 2;
          }

          this.modelCache.set(UnitCategory[category], group);
        } catch (e) {
          console.warn(`Could not load model for ${UnitCategory[category]} from ${config.fileName}. A primitive will be used instead.`);
        }
      }
    } catch (error) {
      console.error("A critical error occurred during model preloading.", error);
    } finally {
      this.modelsLoaded.set(true);
    }
  }

  private _getUnitCategory(object: AcmiObject): UnitCategory {
    const type = object.properties.get('Type') || '';
    if (type.includes('FixedWing') || type.includes('Rotorcraft')) return UnitCategory.Aircraft;
    if (type.includes('Ground') || type.includes('Tank') || type.includes('Vehicle') || type.includes('APC') || type.includes('Artillery') || type.includes('Infantry')) return UnitCategory.Ground;
    if (type.includes('Sea')) return UnitCategory.Ship;
    if (type.includes('Missile') || type.includes('Bomb')) return UnitCategory.Missile;
    return UnitCategory.Unknown;
  }

  private _createUnitMesh(object: AcmiObject): THREE.Group {
    const group = new THREE.Group();
    const color = object.properties.get('Color') || 'cyan';
    const shapeName = this._resolveShapeName(object);
    const opacity = this._getOpacityForShape(shapeName);

    group.scale.setScalar(this.modelScaleMultiplier);

    // 1. Create a placeholder (fallback) mesh immediately
    const fallbackMesh = this._createFallbackMesh(object, color, opacity);
    group.add(fallbackMesh);

    // 2. If a specific shape is requested, try to load it asynchronously
    if (shapeName) {
      this._loadShapeModel(shapeName, group, color, opacity, fallbackMesh);
    }

    return group;
  }

  private _createFallbackMesh(object: AcmiObject, colorString: string, opacity: number): THREE.Object3D {
    const category = this._getUnitCategory(object);
    // Check if we have a preloaded generic model for this category
    const preloadedModel = this.modelCache.get(UnitCategory[category]);

    const material = new THREE.MeshStandardMaterial({ color: colorString, opacity, transparent: opacity < 1 });

    if (preloadedModel) {
      const clone = preloadedModel.clone(true);
      clone.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.material = material;
        }
      });
      return clone;
    }

    // Primitive fallback
    let mesh: THREE.Mesh;
    switch (category) {
      case UnitCategory.Aircraft:
        const fuselageGeom = new THREE.ConeGeometry(20, 80, 8);
        const fuselage = new THREE.Mesh(fuselageGeom, material);
        fuselage.rotation.x = Math.PI / 2;
        const wingGeom = new THREE.BoxGeometry(120, 4, 20);
        const wings = new THREE.Mesh(wingGeom, material);
        wings.position.y = -10;
        const aircraftGroup = new THREE.Group();
        aircraftGroup.add(fuselage);
        aircraftGroup.add(wings);
        return aircraftGroup;

      case UnitCategory.Ground:
        mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 10, 40), material);
        return mesh;

      case UnitCategory.Ship:
        mesh = new THREE.Mesh(new THREE.BoxGeometry(40, 30, 250), material);
        return mesh;

      case UnitCategory.Missile:
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 50, 8), material);
        mesh.rotation.x = Math.PI / 2;
        return mesh;

      default: // Unknown
        mesh = new THREE.Mesh(new THREE.SphereGeometry(25, 16, 16), material);
        return mesh;
    }
  }

  private async _loadShapeModel(shapeName: string, targetGroup: THREE.Group, colorString: string, opacity: number, placeholder: THREE.Object3D): Promise<void> {
    try {
      const fileName = this._ensureObjExtension(shapeName);
      const cacheKey = this._getShapeCacheKey(fileName);
      let modelGroup = this.loadedShapes.get(cacheKey);

      if (!modelGroup) {
        // Check if already loading
        let promise = this.shapeLoadPromises.get(cacheKey);
        if (!promise) {
          console.log(`[ThreeRenderer] Attempting to load shape: "${shapeName}"`);

          const modelPaths = this._buildModelPaths(fileName);
          console.log(`[ThreeRenderer] Loading model from: ${modelPaths[0]}`);

          promise = this._loadObjWithFallbacks(modelPaths).then(group => {
            console.log(`[ThreeRenderer] Successfully loaded: ${modelPaths[0]}`);
            const box = new THREE.Box3().setFromObject(group);
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());

            group.traverse(child => {
              if (child instanceof THREE.Mesh) {
                child.geometry.translate(-center.x, -center.y, -center.z);
              }
            });
            return group;
          }).catch(err => {
            console.error(`[ThreeRenderer] Failed to load ${fileName}:`, err);
            throw err;
          });
          this.shapeLoadPromises.set(cacheKey, promise);
        }
        modelGroup = await promise;
        this.loadedShapes.set(cacheKey, modelGroup!);
        this.shapeLoadPromises.delete(cacheKey);
      }

      if (modelGroup) {
        const instance = modelGroup.clone(true);
        const material = new THREE.MeshStandardMaterial({ color: colorString, opacity, transparent: opacity < 1 });
        instance.traverse(child => {
          if (child instanceof THREE.Mesh) {
            child.material = material;
          }
        });

        targetGroup.remove(placeholder);
        targetGroup.add(instance);
      }

    } catch (e) {
      console.warn(`[ThreeRenderer] Error handling shape ${shapeName}`, e);
    }
  }

  private _resolveShapeName(object: AcmiObject): string | null {
    const rawShape = object.properties.get('Shape');
    if (!rawShape) return null;
    const trimmed = rawShape.trim();
    if (!trimmed) return null;

    const normalized = trimmed.split(/[\\/]/).pop() || trimmed;
    return normalized;
  }

  private _ensureObjExtension(fileName: string): string {
    if (fileName.toLowerCase().endsWith('.obj')) return fileName;
    return `${fileName}.obj`;
  }

  private _buildModelPaths(fileName: string): string[] {
    const folder = this._getMeshFolder(fileName);
    const paths = new Set<string>();
    paths.add(new URL(`${folder}/${fileName}`, this.assetBaseUrl).toString());
    paths.add(`/${folder}/${fileName}`);
    paths.add(`/public/${folder}/${fileName}`);
    return Array.from(paths);
  }

  private _getMeshFolder(fileName: string): string {
    return fileName.toLowerCase().startsWith('vtolvr_') ? 'Meshes_vtolvr' : 'Meshes_tacview';
  }

  private _getOpacityForShape(shapeName: string | null): number {
    if (!shapeName) return 1;
    if (shapeName === 'vtolvr_ConePog.obj') return 0.3;
    return 1;
  }

  private _getExtraGroundOffset(object?: AcmiObject): number {
    if (!object) return 0;
    const shapeName = this._resolveShapeName(object);
    if (!shapeName) return 0;
    return this.extraGroundOffsets.get(shapeName) ?? 0;
  }

  private _getShapeCacheKey(fileName: string): string {
    return `${this._getMeshFolder(fileName)}/${fileName}`;
  }

  private async _loadObjWithFallbacks(paths: string[]): Promise<THREE.Group> {
    let lastError: unknown;
    for (const path of paths) {
      try {
        return await this.loader.loadAsync(path);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('Failed to load model.');
  }
}
