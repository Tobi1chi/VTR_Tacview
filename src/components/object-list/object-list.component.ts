
import { Component, ChangeDetectionStrategy, computed, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AcmiObject } from '../../models/acmi.model';

interface DisplayObject {
  id: string;
  name: string;
  type: string;
  statesCount: number;
}

@Component({
  selector: 'app-object-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './object-list.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ObjectListComponent {
  objects = input.required<Map<string, AcmiObject>>();
  currentTime = input.required<number>();
  objectSelected = output<string>();

  objectList = computed(() => {
    const data = this.objects();
    const time = this.currentTime();
    if (!data) return [];

    return Array.from(data.values())
      .filter((obj: AcmiObject) => {
        // An object is active if its first state has occurred and it has not been removed yet.
        return obj.states.length > 0 && 
               obj.states[0].time <= time && 
               (obj.removedAtTime === null || obj.removedAtTime > time);
      })
      .map((obj: AcmiObject) => ({
        id: obj.id,
        name: obj.properties.get('Name') || obj.properties.get('CallSign') || 'Unknown',
        type: obj.properties.get('Type') || 'Object',
        statesCount: obj.states.length,
      }))
      // Sort alphabetically for a more stable list as objects appear/disappear
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  onObjectDoubleClick(id: string): void {
    this.objectSelected.emit(id);
  }
}
