
import { Injectable } from '@angular/core';
import { AcmiData, AcmiObject, TimeState } from '../models/acmi.model';

/**
 * Service to parse Tacview 2.x ACMI text files according to the official specification.
 * https://www.tacview.net/documentation/acmi/en/
 * 
 * System Architecture Note (Parser Module):
 * This service encapsulates all logic for reading the ACMI format. It processes the
 * file line-by-line in a single pass, handling file headers, frame updates, and 
 * object state changes. It is designed to be robust and spec-compliant. For very
 * large files, this should be run in a Web Worker to avoid blocking the main thread.
 */
@Injectable()
export class AcmiParserService {

  public async parse(fileContent: string): Promise<AcmiData> {
    const lines = fileContent.split(/\r?\n/);

    // File-level metadata
    let fileTypeValidated = false;
    let fileVersion = '';
    let referenceTime: Date | null = null;
    let referenceLongitude = 0;
    let referenceLatitude = 0;

    const objects = new Map<string, AcmiObject>();
    let currentTime = 0;
    let startTime: number | null = null;
    let endTime = 0;
    let inHeader = true;

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('//')) {
        continue; // Skip empty lines and comments
      }
      
      // The first non-comment line MUST be the FileType
      if (!fileTypeValidated) {
        if (trimmedLine === 'FileType=text/acmi/tacview') {
          fileTypeValidated = true;
          continue;
        } else {
          throw new Error('Invalid ACMI file: "FileType=text/acmi/tacview" header not found.');
        }
      }

      // Handle frame changes
      if (trimmedLine.startsWith('#')) {
        inHeader = false; // Once we see the first frame, we are out of the header
        currentTime = parseFloat(trimmedLine.substring(1));
        if (startTime === null) {
          startTime = currentTime;
        }
        endTime = Math.max(endTime, currentTime);
        continue;
      }
      
      // Process header data
      if (inHeader) {
          const [key, value] = this.splitKeyValue(trimmedLine);
          switch(key) {
              case 'FileVersion':
                  fileVersion = value;
                  break;
              case 'ReferenceTime':
                  // The 'Z' is crucial to interpret the time as UTC
                  referenceTime = new Date(value.trim() + 'Z');
                  break;
              case 'ReferenceLongitude':
                  referenceLongitude = parseFloat(value);
                  break;
              case 'ReferenceLatitude':
                  referenceLatitude = parseFloat(value);
                  break;
          }
          continue;
      }

      // Process object removal
      if (trimmedLine.startsWith('-')) {
        const id = trimmedLine.substring(1);
        const obj = objects.get(id);
        if (obj) {
          obj.removedAtTime = currentTime;
        }
        continue;
      }

      // Process object creation/update
      const parts = this.tokenizeLine(trimmedLine);
      if (parts.length === 0) continue;
      
      const id = parts[0];
      let obj = objects.get(id);
      if (!obj) {
        obj = { id, properties: new Map(), states: [], removedAtTime: null };
        objects.set(id, obj);
      }

      for (const part of parts.slice(1)) {
        const [key, value] = this.splitKeyValue(part);
        if (!key || value === undefined) continue;

        if (key === 'T') {
          const values = value.split('|').map(v => v ? parseFloat(v) : undefined);
          const [lon, lat, alt, roll, pitch, yaw] = values;

          if (lon !== undefined && lat !== undefined && alt !== undefined) {
             const state: TimeState = {
                  time: currentTime,
                  longitude: lon,
                  latitude: lat,
                  altitude: alt,
                  roll: roll,
                  pitch: pitch,
                  yaw: yaw
              };
              // ACMI files are chronological, so we can just push.
              obj.states.push(state);
          }
        } else {
          obj.properties.set(key, value);
        }
      }
    }

    if (!referenceTime) {
      referenceTime = new Date(0); // Default if not specified
    }
    if (startTime === null) {
      startTime = 0;
    }

    return {
      objects,
      startTime,
      endTime,
      referenceTime,
      referenceLongitude,
      referenceLatitude,
    };
  }

  /**
   * Splits a line into comma-separated parts, respecting double-quoted strings.
   * @param line The string line to tokenize.
   * @returns An array of tokens.
   */
  private tokenizeLine(line: string): string[] {
    const tokens: string[] = [];
    let currentToken = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      }
      if (char === ',' && !inQuotes) {
        tokens.push(currentToken);
        currentToken = '';
      } else {
        currentToken += char;
      }
    }
    tokens.push(currentToken); // Add the last token
    return tokens;
  }
  
  /**
   * Splits a "Key=Value" string into a [Key, Value] tuple.
   * It handles quoted values.
   */
  private splitKeyValue(pair: string): [string, string] {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) {
      return [pair, ''];
    }
    const key = pair.substring(0, separatorIndex);
    let value = pair.substring(separatorIndex + 1);
    
    // Remove quotes if present
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.substring(1, value.length - 1);
    }
    
    return [key, value];
  }
}
