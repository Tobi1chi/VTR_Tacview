
import { Component, ChangeDetectionStrategy, input, computed } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface AircraftDisplayData {
  callsign: string;
  altitude: number;      // meters
  speed: number;         // m/s
  verticalSpeed: number; // m/s
  heading: number;       // degrees
}

const METERS_TO_FEET = 3.28084;
const MS_TO_KNOTS = 1.94384;

@Component({
  selector: 'app-aircraft-info-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './aircraft-info-panel.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AircraftInfoPanelComponent {
  callsign = input.required<string>();
  altitude = input.required<number>();      // meters
  speed = input.required<number>();         // m/s
  verticalSpeed = input.required<number>(); // m/s
  heading = input.required<number>();       // degrees

  // Computed signals for display formatting
  altitudeFt = computed(() => (this.altitude() * METERS_TO_FEET).toFixed(0));
  speedKt = computed(() => (this.speed() * MS_TO_KNOTS).toFixed(0));
  verticalSpeedFpm = computed(() => (this.verticalSpeed() * METERS_TO_FEET * 60).toFixed(0));
  headingDeg = computed(() => this.heading().toFixed(0).padStart(3, '0'));
}
