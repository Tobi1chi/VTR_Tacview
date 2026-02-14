
import { Component, ChangeDetectionStrategy, input, output, computed } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-playback-controls',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './playback-controls.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaybackControlsComponent {
  isPlaying = input.required<boolean>();
  currentTime = input.required<number>();
  duration = input.required<number>();
  playbackSpeed = input.required<number>();

  play = output<void>();
  pause = output<void>();
  seek = output<number>();
  speedChange = output<number>();

  readonly availableSpeeds = [0.25, 0.5, 1, 2, 4, 8, 16];

  formattedTime = computed(() => this.formatTime(this.currentTime()));
  formattedDuration = computed(() => this.formatTime(this.duration()));

  onSliderChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.seek.emit(Number(target.value));
  }

  togglePlayPause(): void {
    if (this.isPlaying()) {
      this.pause.emit();
    } else {
      this.play.emit();
    }
  }

  setSpeed(speed: number): void {
    this.speedChange.emit(speed);
  }

  private formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  }
}
