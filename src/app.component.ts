
import { Component, ChangeDetectionStrategy, ElementRef, ViewChild, AfterViewInit, inject, signal, effect, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';

import { AcmiParserService } from './services/acmi-parser.service';
import { SimulationService } from './services/simulation.service';
import { ThreeRendererService } from './services/three-renderer.service';
import { PlaybackControlsComponent } from './components/playback-controls/playback-controls.component';
import { ObjectListComponent } from './components/object-list/object-list.component';
import { AircraftInfoPanelComponent, AircraftDisplayData } from './components/aircraft-info-panel/aircraft-info-panel.component';
import { AcmiData, InterpolatedState } from './models/acmi.model';

// Declare JSZip for TypeScript since it's loaded from a script tag.
declare var JSZip: any;

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, PlaybackControlsComponent, ObjectListComponent, AircraftInfoPanelComponent],
  providers: [AcmiParserService, SimulationService, ThreeRendererService],
  standalone: true,
})
export class AppComponent implements AfterViewInit, OnDestroy {
  @ViewChild('rendererCanvas', { static: true }) rendererCanvas!: ElementRef<HTMLCanvasElement>;

  private parserService = inject(AcmiParserService);
  public threeRenderer = inject(ThreeRendererService);
  public simulationService = inject(SimulationService);

  isLoading = signal<boolean>(false);
  errorMessage = signal<string | null>(null);
  fileName = signal<string | null>(null);
  
  selectedAircraftData = signal<AircraftDisplayData | null>(null);

  private animationFrameId: number | null = null;
  private lastTimestamp = 0;
  private initialFocusDone = signal<boolean>(false);

  constructor() {
    // Effect to link the simulation's interpolated states to the renderer.
    effect(() => {
      const states = this.simulationService.interpolatedStates();
      const acmiData = this.simulationService.acmiData();
      if (states.size > 0 && acmiData) {
        this.threeRenderer.updateObjects(states, acmiData.objects);
      }

      // Auto-focus camera on the first object when data is first loaded.
      if (this.simulationService.isDataLoaded() && !this.initialFocusDone() && states.size > 0) {
        const firstActiveObject = Array.from(states.values()).find((s: InterpolatedState) => s.isActive);
        if (firstActiveObject) {
          this.threeRenderer.focusOnObject(firstActiveObject);
          this.initialFocusDone.set(true);
        }
      }
    });

    // Effect to update the aircraft info panel data.
    effect(() => {
      const targetId = this.threeRenderer.followTargetId();
      const data = this.simulationService.acmiData();
      const states = this.simulationService.interpolatedStates();

      if (!targetId || !data) {
        this.selectedAircraftData.set(null);
        return;
      }
      
      const acmiObject = data.objects.get(targetId);
      const currentState = states.get(targetId);
      const objectType = acmiObject?.properties.get('Type') || '';
      const isAircraft = objectType.includes('FixedWing') || objectType.includes('Rotorcraft');

      if (acmiObject && currentState && isAircraft) {
        this.selectedAircraftData.set({
          callsign: acmiObject.properties.get('Name') || 'N/A',
          altitude: currentState.z,
          speed: currentState.speed,
          verticalSpeed: currentState.verticalSpeed,
          heading: currentState.heading,
        });
      } else {
        this.selectedAircraftData.set(null);
      }
    });
  }

  ngAfterViewInit(): void {
    this.threeRenderer.initialize(this.rendererCanvas.nativeElement);
    this.startRenderLoop();
  }

  ngOnDestroy(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.threeRenderer.destroy();
  }

  private startRenderLoop(): void {
    const loop = (timestamp: number) => {
      if (this.lastTimestamp === 0) {
        this.lastTimestamp = timestamp;
      }
      const deltaTime = (timestamp - this.lastTimestamp) / 1000; // seconds
      this.lastTimestamp = timestamp;

      this.simulationService.tick(deltaTime);
      this.threeRenderer.render(deltaTime);
      this.animationFrameId = requestAnimationFrame(loop);
    };
    this.animationFrameId = requestAnimationFrame(loop);
  }

  async onFileChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    this.fileName.set(file.name);
    this.isLoading.set(true);
    this.errorMessage.set(null);
    this.simulationService.reset();
    this.initialFocusDone.set(false);
    this.threeRenderer.setFollowTarget(null);

    try {
      const buffer = await file.arrayBuffer();
      const view = new DataView(buffer);
      let fileContent: string;

      if (buffer.byteLength > 2 && view.getUint16(0) === 0x504B) {
        const zip = await JSZip.loadAsync(buffer);
        const acmiFileInZip = Object.values(zip.files).find(
          (f: any) => !f.dir && f.name.toLowerCase().endsWith('.acmi')
        );
        if (!acmiFileInZip) throw new Error('No .acmi file found inside the ZIP archive.');
        fileContent = await (acmiFileInZip as any).async('string');
      } else {
        fileContent = new TextDecoder('utf-8').decode(buffer);
      }

      const acmiData: AcmiData = await this.parserService.parse(fileContent);
      this.logParserDiagnostics(acmiData);
      this.simulationService.loadData(acmiData);

    } catch (error: any) {
      console.error('Failed to load or parse ACMI file:', error);
      this.errorMessage.set(`Error: ${error.message}`);
      this.fileName.set(null);
    } finally {
      this.isLoading.set(false);
      input.value = '';
    }
  }

  public onObjectSelected(id: string): void {
    this.threeRenderer.setFollowTarget(id);
  }
  
  private logParserDiagnostics(acmiData: AcmiData): void {
    console.log('--- ACMI PARSER DIAGNOSTICS ---');
    console.log(`Total objects parsed: ${acmiData.objects.size}`);
    const objectsWithStates = Array.from(acmiData.objects.values()).filter(o => o.states.length > 0);
    console.log(`Objects with states: ${objectsWithStates.length}`);
    console.log(`Time Range: ${acmiData.startTime.toFixed(2)}s to ${acmiData.endTime.toFixed(2)}s`);
    const top20Objects = objectsWithStates
      .sort((a, b) => b.states.length - a.states.length)
      .slice(0, 20)
      .map(o => ({
        ID: o.id,
        Name: o.properties.get('Name') || 'N/A',
        Type: o.properties.get('Type') || 'N/A',
        States: o.states.length,
      }));
    console.log('Top 20 objects by number of states:');
    console.table(top20Objects);
    console.log('---------------------------------');
  }
}
