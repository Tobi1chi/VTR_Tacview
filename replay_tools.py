"""
ReplayToolkit: PNGb Caesar decode + .vtr parsing + 2D map rendering.

Dependencies:
  pip install lz4 pillow numpy
Optional:
  pip install scipy
"""

from __future__ import annotations

import dataclasses
import io
import json
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import lz4.frame
from lz4.block import LZ4BlockError, decompress as lz4_block_decompress
from PIL import Image
import numpy as np

try:
    from scipy.ndimage import gaussian_filter
except Exception:
    gaussian_filter = None


LZ4FrameError = getattr(lz4.frame, "LZ4FrameError", RuntimeError)


class BufferReader:
    """Little-endian binary reader."""

    def __init__(self, data: bytes) -> None:
        self._buffer = memoryview(data)
        self._offset = 0

    @property
    def offset(self) -> int:
        return self._offset

    def read_bytes(self, length: int) -> bytes:
        end = self._offset + length
        if end > len(self._buffer):
            raise EOFError("Read past end of buffer")
        chunk = self._buffer[self._offset : end].tobytes()
        self._offset = end
        return chunk

    def read_struct(self, fmt: str) -> Tuple[Any, ...]:
        size = struct.calcsize(fmt)
        return struct.unpack(fmt, self.read_bytes(size))

    def read_int32(self) -> int:
        (value,) = self.read_struct("<i")
        return value

    def read_uint32(self) -> int:
        (value,) = self.read_struct("<I")
        return value

    def read_float32(self) -> float:
        (value,) = self.read_struct("<f")
        return value

    def read_byte(self) -> int:
        (value,) = self.read_struct("<B")
        return value

    def read_bool(self) -> bool:
        return self.read_byte() != 0

    def read_vector3(self) -> Tuple[float, float, float]:
        return (self.read_float32(), self.read_float32(), self.read_float32())

    def read_fixed_point(self) -> Tuple[float, float, float]:
        return self.read_vector3()

    def read_string(self) -> str:
        length = self.read_int32()
        if length < 0:
            raise ValueError(f"Invalid string length: {length}")
        data = self.read_bytes(length)
        return data.decode("utf-8")


@dataclass
class TrackMetadata:
    identity: int
    label: str

    @classmethod
    def from_reader(cls, reader: BufferReader) -> "TrackMetadata":
        identity = reader.read_int32()
        byte_len = reader.read_int32()
        raw = [reader.read_byte() for _ in range(byte_len)]
        label = bytes(raw).decode("utf-8")
        return cls(identity=identity, label=label)


@dataclass
class MotionKeyframe:
    t: float
    position: Tuple[float, float, float]
    velocity: Tuple[float, float, float]
    rotation_int: int

    @classmethod
    def full(cls, reader: BufferReader) -> "MotionKeyframe":
        t = reader.read_float32()
        position = reader.read_fixed_point()
        velocity = reader.read_vector3()
        rotation = reader.read_int32()
        return cls(t=t, position=position, velocity=velocity, rotation_int=rotation)

    @classmethod
    def delta(
        cls, reader: BufferReader, previous: "MotionKeyframe"
    ) -> "MotionKeyframe":
        t = previous.t + reader.read_float32()
        flags = reader.read_byte()

        pos = list(previous.position)
        vel = list(previous.velocity)
        rot = previous.rotation_int

        if flags & 0b001:
            delta_pos = reader.read_vector3()
            pos = [p + d for p, d in zip(pos, delta_pos)]
        if flags & 0b010:
            delta_vel = reader.read_vector3()
            vel = [v + d for v, d in zip(vel, delta_vel)]
        if flags & 0b100:
            rot += reader.read_int32()

        return cls(t=t, position=tuple(pos), velocity=tuple(vel), rotation_int=rot)


@dataclass
class EventKeyframe:
    t: float
    event_type: int

    @classmethod
    def from_reader(cls, reader: BufferReader) -> "EventKeyframe":
        t = reader.read_float32()
        event_type = reader.read_byte()
        return cls(t=t, event_type=event_type)


@dataclass
class WorldEventKeyframe(EventKeyframe):
    position: Tuple[float, float, float]
    rotation_int: int

    @classmethod
    def from_reader(cls, reader: BufferReader) -> "WorldEventKeyframe":
        base = EventKeyframe.from_reader(reader)
        position = reader.read_fixed_point()
        rotation = reader.read_int32()
        return cls(
            t=base.t,
            event_type=base.event_type,
            position=position,
            rotation_int=rotation,
        )


@dataclass
class BulletEventKeyframe(EventKeyframe):
    position: Tuple[float, float, float]
    velocity: Tuple[float, float, float]
    mass: float
    bullet_id: int
    lifetime: float

    @classmethod
    def from_reader(cls, reader: BufferReader) -> "BulletEventKeyframe":
        base = EventKeyframe.from_reader(reader)
        position = reader.read_fixed_point()
        velocity = reader.read_vector3()
        mass = reader.read_float32()
        bullet_id = reader.read_int32()
        lifetime = float(reader.read_byte())
        return cls(
            t=base.t,
            event_type=base.event_type,
            position=position,
            velocity=velocity,
            mass=mass,
            bullet_id=bullet_id,
            lifetime=lifetime,
        )


@dataclass
class BulletEndKeyframe(EventKeyframe):
    bullet_id: int

    @classmethod
    def from_reader(cls, reader: BufferReader) -> "BulletEndKeyframe":
        base = EventKeyframe.from_reader(reader)
        bullet_id = reader.read_int32()
        return cls(t=base.t, event_type=base.event_type, bullet_id=bullet_id)


EVENT_TYPE_MAP = {
    0: EventKeyframe,
    1: EventKeyframe,
    2: WorldEventKeyframe,
    3: BulletEventKeyframe,
    4: BulletEndKeyframe,
}


@dataclass
class RadarLockKeyframe:
    t: float
    target_id: int

    @classmethod
    def from_reader(cls, reader: BufferReader) -> "RadarLockKeyframe":
        t = reader.read_float32()
        target_id = reader.read_int32()
        return cls(t=t, target_id=target_id)


@dataclass
class RadarLockMetadata:
    actor_id: int

    @classmethod
    def from_reader(cls, reader: BufferReader) -> "RadarLockMetadata":
        actor_id = reader.read_int32()
        return cls(actor_id=actor_id)


@dataclass
class RadarJammerKeyframe:
    t: float
    keyframe_type: int
    transmit_mode: int
    band: int
    direction: Tuple[float, float, float]

    @classmethod
    def from_reader(cls, reader: BufferReader) -> "RadarJammerKeyframe":
        t = reader.read_float32()
        keyframe_type = reader.read_byte()
        transmit_mode = reader.read_byte()
        band = reader.read_byte()
        direction = reader.read_vector3()
        return cls(
            t=t,
            keyframe_type=keyframe_type,
            transmit_mode=transmit_mode,
            band=band,
            direction=direction,
        )


@dataclass
class RadarJammerMetadata:
    actor_replay_id: int

    @classmethod
    def from_reader(cls, reader: BufferReader) -> "RadarJammerMetadata":
        actor_replay_id = reader.read_int32()
        return cls(actor_replay_id=actor_replay_id)


@dataclass
class PooledProjectileKeyframe:
    t: float
    active: bool
    position: Tuple[float, float, float]
    velocity: Tuple[float, float, float]

    @classmethod
    def from_reader(cls, reader: BufferReader) -> "PooledProjectileKeyframe":
        t = reader.read_float32()
        active = reader.read_bool()
        position = reader.read_vector3()
        velocity = reader.read_vector3()
        return cls(t=t, active=active, position=position, velocity=velocity)


CUSTOM_KEYFRAME_READERS = {
    "LockingRadar+RadarLockKeyframe": RadarLockKeyframe.from_reader,
    "RadarJammer+JammerKeyframe": RadarJammerKeyframe.from_reader,
    "VTOLVR.ReplaySystem.VTRPooledProjectile+PooledProjectileKeyframe": PooledProjectileKeyframe.from_reader,
}

CUSTOM_METADATA_READERS = {
    "LockingRadar+RadarLockReplayMetadata": RadarLockMetadata.from_reader,
    "RadarJammer+ReplayMetadata": RadarJammerMetadata.from_reader,
    "VTOLVR.ReplaySystem.VTRPooledProjectile+PooledProjectileMetadata": lambda _reader: {},
}


@dataclass
class CustomTrackData:
    track_id: int
    keyframe_type: str
    metadata_type: str
    metadata: Any
    keyframes: List[Any]


@dataclass
class MotionTrackData:
    entity_id: int
    entity_type: int
    metadata: Optional[TrackMetadata]
    keyframes: List[MotionKeyframe]


@dataclass
class EventTrackData:
    keyframes: List[Any]


@dataclass
class ReplayEntity:
    entity_id: int
    entity_type: int
    metadata: Optional[TrackMetadata]


@dataclass
class ReplayData:
    motion_tracks: List[MotionTrackData]
    custom_tracks: List[CustomTrackData]
    event_track: EventTrackData
    entities: List[ReplayEntity]


class VTRDeserializer:
    def __init__(self, data: bytes) -> None:
        self.reader = BufferReader(data)

    def deserialize(self) -> ReplayData:
        version = self.reader.read_int32()
        if version != 1:
            raise ValueError(f"Unsupported replay version: {version}")
        motion_tracks = self._read_motion_tracks()
        custom_tracks = self._read_custom_tracks()
        event_track = self._read_event_track()
        entities = [
            ReplayEntity(mt.entity_id, mt.entity_type, mt.metadata)
            for mt in motion_tracks
        ]
        return ReplayData(
            motion_tracks=motion_tracks,
            custom_tracks=custom_tracks,
            event_track=event_track,
            entities=entities,
        )

    def _read_motion_tracks(self) -> List[MotionTrackData]:
        count = self.reader.read_int32()
        tracks: List[MotionTrackData] = []
        for _ in range(count):
            entity_id = self.reader.read_int32()
            entity_type = self.reader.read_int32()
            has_metadata = self.reader.read_byte()
            metadata = (
                TrackMetadata.from_reader(self.reader) if has_metadata > 0 else None
            )
            keyframe_count = self.reader.read_int32()
            keyframes: List[MotionKeyframe] = []
            prev: Optional[MotionKeyframe] = None
            for idx in range(keyframe_count):
                if idx == 0:
                    kf = MotionKeyframe.full(self.reader)
                else:
                    if prev is None:
                        raise RuntimeError("Missing previous keyframe")
                    kf = MotionKeyframe.delta(self.reader, prev)
                keyframes.append(kf)
                prev = kf
            tracks.append(
                MotionTrackData(
                    entity_id=entity_id,
                    entity_type=entity_type,
                    metadata=metadata,
                    keyframes=keyframes,
                )
            )
        return tracks

    def _read_custom_tracks(self) -> List[CustomTrackData]:
        count = self.reader.read_int32()
        tracks: List[CustomTrackData] = []
        for _ in range(count):
            track_id = self.reader.read_int32()
            keyframe_type = self.reader.read_string()
            metadata_type = self.reader.read_string()
            metadata_reader = CUSTOM_METADATA_READERS.get(metadata_type)
            if metadata_reader is None:
                raise NotImplementedError(
                    f"Unknown custom metadata type: {metadata_type}"
                )
            metadata = metadata_reader(self.reader)
            keyframe_reader = CUSTOM_KEYFRAME_READERS.get(keyframe_type)
            if keyframe_reader is None:
                raise NotImplementedError(
                    f"Unknown custom keyframe type: {keyframe_type}"
                )
            kf_count = self.reader.read_int32()
            keyframes = [keyframe_reader(self.reader) for _ in range(kf_count)]
            tracks.append(
                CustomTrackData(
                    track_id=track_id,
                    keyframe_type=keyframe_type,
                    metadata_type=metadata_type,
                    metadata=metadata,
                    keyframes=keyframes,
                )
            )
        return tracks

    def _read_event_track(self) -> EventTrackData:
        count = self.reader.read_int32()
        keyframes: List[Any] = []
        for _ in range(count):
            type_index = self.reader.read_byte()
            reader_fn = EVENT_TYPE_MAP.get(type_index)
            if reader_fn is None:
                raise NotImplementedError(f"Unknown event type index: {type_index}")
            keyframes.append(reader_fn.from_reader(self.reader))
        return EventTrackData(keyframes=keyframes)


class ReplayToolkit:
    """Utility class for PNGb Caesar decode and .vtr parsing."""

    PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

    def decode_pngb(
        self,
        input_path: str | Path,
        *,
        shift: Optional[int] = None,
        output_path: Optional[str | Path] = None,
        search_shift: bool = True,
    ) -> Tuple[Path, int]:
        """
        Decode a .pngb with Caesar shift. If shift is None, try 0..255 to find PNG header.
        Returns (output_path, shift).
        """
        input_path = Path(input_path)
        data = input_path.read_bytes()

        shifts = [shift] if shift is not None else list(range(256))
        found_shift = None
        png_bytes = None

        for s in shifts:
            decoded = bytes(((b - s) & 0xFF) for b in data)
            idx = decoded.find(self.PNG_MAGIC)
            if idx == -1:
                if shift is not None:
                    break
                continue
            if not search_shift and shift is None:
                continue
            png_bytes = decoded[idx:]
            found_shift = s
            break

        if png_bytes is None or found_shift is None:
            raise ValueError("Failed to locate PNG header. Check shift or input file.")

        if output_path is None:
            output_path = input_path.with_suffix(f".shift{found_shift}.png")
        output_path = Path(output_path)

        img = Image.open(io.BytesIO(png_bytes))
        img.load()
        img.save(output_path)

        return output_path, found_shift

    def decompress_vtr(self, payload: bytes) -> bytes:
        try:
            return lz4.frame.decompress(payload)
        except LZ4FrameError:
            target = max(len(payload) * 255, 4096)
            while True:
                try:
                    return lz4_block_decompress(payload, uncompressed_size=target)
                except LZ4BlockError as exc:
                    if "Output buffer is too small" in str(exc):
                        target *= 2
                        continue
                    raise

    def load_vtr(self, path: str | Path) -> ReplayData:
        path = Path(path)
        compressed = path.read_bytes()
        decompressed = self.decompress_vtr(compressed)
        parser = VTRDeserializer(decompressed)
        return parser.deserialize()

    def replay_to_json(self, replay: ReplayData) -> str:
        return json.dumps(
            dataclasses.asdict(replay), ensure_ascii=False, indent=2, default=str
        )

    def save_replay_json(self, replay: ReplayData, output_path: str | Path) -> Path:
        output_path = Path(output_path)
        output_path.write_text(self.replay_to_json(replay), encoding="utf-8")
        return output_path

    def load_heightmap(
        self, path: str | Path, *, smooth_sigma: float = 0.0
    ) -> np.ndarray:
        img = Image.open(path).convert("RGB")
        arr = np.array(img).astype(np.float32)
        height = arr[..., 0] / 255.0
        if smooth_sigma > 0 and gaussian_filter is not None:
            height = gaussian_filter(height, sigma=smooth_sigma)
        return height

    def detect_coast_side(
        self, height: np.ndarray, *, sea_level: float
    ) -> Tuple[str, Dict[str, float]]:
        water = height <= sea_level
        ratios = {
            "North": float(water[0, :].mean()),
            "South": float(water[-1, :].mean()),
            "West": float(water[:, 0].mean()),
            "East": float(water[:, -1].mean()),
        }
        side = max(ratios, key=ratios.get)
        return side, ratios

    def rotate_to_west(
        self, height: np.ndarray, *, sea_level: float
    ) -> Tuple[np.ndarray, int]:
        actual_side, _ratios = self.detect_coast_side(height, sea_level=sea_level)
        side_to_k = {
            "West": 0,
            "North": 1,
            "East": 2,
            "South": 3,
        }
        k = side_to_k.get(actual_side, 0)
        return np.rot90(height, k=k), k

    def compute_hillshade(
        self,
        height: np.ndarray,
        *,
        z_scale: float = 3.0,
        azimuth_deg: float = 315.0,
        altitude_deg: float = 45.0,
    ) -> np.ndarray:
        gy, gx = np.gradient(height * z_scale)
        slope = np.pi / 2.0 - np.arctan(np.sqrt(gx * gx + gy * gy))
        aspect = np.arctan2(-gx, gy)

        az = np.deg2rad(azimuth_deg)
        alt = np.deg2rad(altitude_deg)

        shaded = np.sin(alt) * np.sin(slope) + np.cos(alt) * np.cos(slope) * np.cos(
            az - aspect
        )
        shaded = (shaded - shaded.min()) / (shaded.max() - shaded.min() + 1e-6)
        return shaded

    def make_color_map(
        self,
        height: np.ndarray,
        hillshade: np.ndarray,
        *,
        sea_level: float,
    ) -> np.ndarray:
        h = height
        hs = hillshade
        rgb = np.zeros((h.shape[0], h.shape[1], 3), dtype=np.float32)

        water_color_deep = np.array([15, 30, 70], dtype=np.float32)
        water_color_shallow = np.array([30, 60, 110], dtype=np.float32)
        lowland_color = np.array([30, 80, 30], dtype=np.float32)
        midland_color = np.array([80, 120, 50], dtype=np.float32)
        highland_color = np.array([110, 90, 60], dtype=np.float32)
        peak_color = np.array([210, 210, 210], dtype=np.float32)

        water_mask = h <= sea_level
        land_mask = ~water_mask

        if water_mask.any():
            h_water = np.clip(h[water_mask] / max(sea_level, 1e-6), 0.0, 1.0)
            rgb[water_mask] = (
                water_color_deep[None, :] * (1 - h_water[:, None])
                + water_color_shallow[None, :] * h_water[:, None]
            )

        if land_mask.any():
            h_land = h[land_mask]
            h_norm = (h_land - sea_level) / (h_land.max() - sea_level + 1e-6)
            h_norm = np.clip(h_norm, 0.0, 1.0)

            c = np.zeros((h_land.shape[0], 3), dtype=np.float32)

            m1 = h_norm <= 0.3
            t1 = h_norm[m1] / 0.3
            c[m1] = lowland_color * (1 - t1[:, None]) + midland_color * t1[:, None]

            m2 = (h_norm > 0.3) & (h_norm <= 0.7)
            t2 = (h_norm[m2] - 0.3) / 0.4
            c[m2] = midland_color * (1 - t2[:, None]) + highland_color * t2[:, None]

            m3 = h_norm > 0.7
            t3 = (h_norm[m3] - 0.7) / 0.3
            c[m3] = highland_color * (1 - t3[:, None]) + peak_color * t3[:, None]

            rgb[land_mask] = c

        brightness = 0.5 + hs * 0.7
        rgb *= brightness[..., None]
        return np.clip(rgb, 0, 255).astype(np.uint8)

    def render_2d_map(
        self,
        heightmap_path: str | Path,
        *,
        output_path: str | Path,
        sea_level: float = 0.03,
        smooth_sigma: float = 1.0,
        edge_mode: str = "Coast",
        coast_side: str = "West",
        z_scale: float = 3.0,
        azimuth_deg: float = 315.0,
        altitude_deg: float = 45.0,
    ) -> Path:
        height = self.load_heightmap(heightmap_path, smooth_sigma=smooth_sigma)

        if edge_mode == "Coast" and coast_side == "West":
            height, _k = self.rotate_to_west(height, sea_level=sea_level)

        hillshade = self.compute_hillshade(
            height,
            z_scale=z_scale,
            azimuth_deg=azimuth_deg,
            altitude_deg=altitude_deg,
        )
        rgb = self.make_color_map(height, hillshade, sea_level=sea_level)

        output_path = Path(output_path)
        Image.fromarray(rgb, mode="RGB").save(output_path)
        return output_path
