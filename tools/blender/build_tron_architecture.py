"""Author the rounded, role-tagged panoramic theater shell.

Run inside the already-open Blender scene through BlenderMCP. The script is
intentionally idempotent at the scene level: a completed 1.5x scale bake is a
hard stop, because applying it twice would corrupt every authored dimension.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

import bpy


SCALE_FACTOR = 1.5
CORNER_RADIUS = 0.30
RAIL_RADIUS = 0.025
RAIL_FACE_OFFSET = 0.045
BASE_COLUMNS = 93
CORNER_COLUMNS = 18

SCREEN_NAMES = tuple(f"Wall_Screen_{index}" for index in range(1, 4))
FRAME_NAMES = tuple(f"Wall_Screen_{index}_Frame" for index in range(1, 4))


def circular_mean(values: list[float]) -> float:
    return math.atan2(
        sum(math.sin(value) for value in values),
        sum(math.cos(value) for value in values),
    )


def wrapped_offset(angle: float, middle: float) -> float:
    return math.atan2(math.sin(angle - middle), math.cos(angle - middle))


def cylindrical_measurements(obj: bpy.types.Object) -> dict[str, float]:
    vertices = [vertex.co for vertex in obj.data.vertices]
    angles = [math.atan2(vertex.y, vertex.x) for vertex in vertices]
    middle = circular_mean(angles)
    offsets = [wrapped_offset(angle, middle) for angle in angles]
    radii = [math.hypot(vertex.x, vertex.y) for vertex in vertices]
    heights = [vertex.z for vertex in vertices]
    return {
        "middle": middle,
        "half_angle": max(abs(min(offsets)), abs(max(offsets))),
        "front_radius": min(radii),
        "back_radius": max(radii),
        "z_min": min(heights),
        "z_max": max(heights),
    }


def rounded_x_samples(half_width: float, radius: float) -> list[float]:
    values = {
        -half_width + (2.0 * half_width * index / (BASE_COLUMNS - 1))
        for index in range(BASE_COLUMNS)
    }
    shoulder = half_width - radius
    for index in range(CORNER_COLUMNS + 1):
        theta = math.pi * 0.5 * index / CORNER_COLUMNS
        x = shoulder + radius * math.sin(theta)
        values.add(x)
        values.add(-x)
    return sorted(values)


def rounded_height_range(
    x: float,
    half_width: float,
    z_min: float,
    z_max: float,
    radius: float,
) -> tuple[float, float]:
    shoulder = half_width - radius
    q = max(0.0, abs(x) - shoulder)
    if q <= 0.0:
        return z_min, z_max
    vertical = math.sqrt(max(0.0, radius * radius - q * q))
    return z_min + radius - vertical, z_max - radius + vertical


def rounded_profile(measurements: dict[str, float]) -> tuple[list[float], float, float]:
    reference_radius = measurements["front_radius"]
    half_width = reference_radius * measurements["half_angle"]
    max_radius = min(
        CORNER_RADIUS,
        half_width * 0.25,
        (measurements["z_max"] - measurements["z_min"]) * 0.25,
    )
    return rounded_x_samples(half_width, max_radius), half_width, max_radius


def rebuild_rounded_slab(obj: bpy.types.Object, role: str, screen_index: int) -> dict[str, float]:
    measurements = cylindrical_measurements(obj)
    x_values, half_width, corner_radius = rounded_profile(measurements)
    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []

    for x in x_values:
        offset = x / measurements["front_radius"]
        angle = measurements["middle"] + offset
        z_low, z_high = rounded_height_range(
            x,
            half_width,
            measurements["z_min"],
            measurements["z_max"],
            corner_radius,
        )
        cosine, sine = math.cos(angle), math.sin(angle)
        for radius, height in (
            (measurements["front_radius"], z_low),
            (measurements["front_radius"], z_high),
            (measurements["back_radius"], z_low),
            (measurements["back_radius"], z_high),
        ):
            vertices.append((radius * cosine, radius * sine, height))

    for column in range(len(x_values) - 1):
        current = column * 4
        following = (column + 1) * 4
        # Front faces point toward the occupied interior; back faces outward.
        faces.append((current, current + 1, following + 1, following))
        faces.append((current + 2, following + 2, following + 3, current + 3))
        faces.append((current, following, following + 2, current + 2))
        faces.append((current + 1, current + 3, following + 3, following + 1))
    final = (len(x_values) - 1) * 4
    faces.append((0, 2, 3, 1))
    faces.append((final, final + 1, final + 3, final + 2))

    old_mesh = obj.data
    new_mesh = bpy.data.meshes.new(f"{obj.name}_Rounded_Mesh")
    new_mesh.from_pydata(vertices, [], faces)
    new_mesh.update(calc_edges=True)
    for polygon_index, polygon in enumerate(new_mesh.polygons):
        # The first two faces in each column are cylindrical front/back skins.
        polygon.use_smooth = polygon_index < (len(x_values) - 1) * 4 and polygon_index % 4 < 2
    for material in old_mesh.materials:
        new_mesh.materials.append(material)
    obj.data = new_mesh
    if old_mesh.users == 0:
        bpy.data.meshes.remove(old_mesh)
    obj["semantic_role"] = role
    obj["screen_index"] = screen_index
    obj["corner_radius"] = corner_radius
    return measurements


def rail_material() -> bpy.types.Material:
    material = bpy.data.materials.get("MAT_Tron_White_Rail")
    if material is None:
        material = bpy.data.materials.new("MAT_Tron_White_Rail")
    material.use_nodes = True
    material.diffuse_color = (0.92, 0.96, 1.0, 1.0)
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled is not None:
        principled.inputs["Base Color"].default_value = (0.92, 0.96, 1.0, 1.0)
        emission = principled.inputs.get("Emission Color") or principled.inputs.get("Emission")
        if emission is not None:
            emission.default_value = (0.92, 0.96, 1.0, 1.0)
        strength = principled.inputs.get("Emission Strength")
        if strength is not None:
            strength.default_value = 2.0
        roughness = principled.inputs.get("Roughness")
        if roughness is not None:
            roughness.default_value = 0.22
        metallic = principled.inputs.get("Metallic")
        if metallic is not None:
            metallic.default_value = 0.0
    return material


def create_light_rail(
    screen_obj: bpy.types.Object,
    measurements: dict[str, float],
    screen_index: int,
) -> bpy.types.Object:
    name = f"Wall_Screen_{screen_index}_Light_Rail"
    existing = bpy.data.objects.get(name)
    if existing is not None:
        bpy.data.objects.remove(existing, do_unlink=True)

    x_values, half_width, corner_radius = rounded_profile(measurements)
    radius = measurements["front_radius"] - RAIL_FACE_OFFSET
    points: list[tuple[float, float, float]] = []
    for x in x_values:
        z_low, _ = rounded_height_range(
            x,
            half_width,
            measurements["z_min"],
            measurements["z_max"],
            corner_radius,
        )
        angle = measurements["middle"] + x / measurements["front_radius"]
        points.append((radius * math.cos(angle), radius * math.sin(angle), z_low))
    for x in reversed(x_values):
        _, z_high = rounded_height_range(
            x,
            half_width,
            measurements["z_min"],
            measurements["z_max"],
            corner_radius,
        )
        angle = measurements["middle"] + x / measurements["front_radius"]
        points.append((radius * math.cos(angle), radius * math.sin(angle), z_high))

    curve = bpy.data.curves.new(f"{name}_Curve", type="CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 2
    curve.bevel_depth = RAIL_RADIUS
    curve.bevel_resolution = 3
    curve.resolution_u = 2
    spline = curve.splines.new(type="POLY")
    spline.points.add(len(points) - 1)
    for point, coordinate in zip(spline.points, points):
        point.co = (*coordinate, 1.0)
    spline.use_cyclic_u = True
    rail = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(rail)
    curve.materials.append(rail_material())
    rail["semantic_role"] = "screen.lightRail"
    rail["screen_index"] = screen_index
    rail["powered_state"] = "architectural"

    bpy.ops.object.select_all(action="DESELECT")
    rail.select_set(True)
    bpy.context.view_layer.objects.active = rail
    bpy.ops.object.convert(target="MESH")
    rail = bpy.context.view_layer.objects.active
    rail.name = name
    rail.data.name = f"{name}_Mesh"
    for polygon in rail.data.polygons:
        polygon.use_smooth = True
    return rail


def assign_role(name: str, role: str, **properties: object) -> None:
    obj = bpy.data.objects.get(name)
    if obj is None:
        raise RuntimeError(f"Required role object missing: {name}")
    obj["semantic_role"] = role
    for key, value in properties.items():
        obj[key] = value


def remove_retired_decor() -> None:
    for name in (
        "Dais_Navy_Seal",
        "Wall_Screen_1_Lower_Plinth",
        "Wall_Screen_2_Lower_Plinth",
        "Wall_Screen_3_Lower_Plinth",
    ):
        obj = bpy.data.objects.get(name)
        if obj is not None:
            bpy.data.objects.remove(obj, do_unlink=True)


def assign_scene_roles() -> None:
    assign_role("Room_Floor_Base", "floor.gridBase")
    assign_role("Ceiling_Main", "ceiling.main")
    assign_role("Room_Enclosed_Circular_Shell", "room.shell")
    assign_role("Pedestal_Lower", "pedestal.lower")
    assign_role("Pedestal_Middle", "pedestal.middle")
    assign_role("Pedestal_Top", "pedestal.top")
    assign_role("Pedestal_Light_Ring", "accent.pedestalRing")
    assign_role("Ceiling_Recess_Ring", "accent.ceilingRing")
    assign_role("Area_Cool_Fill", "light.anchor.coolFill")
    assign_role("Screen_Cyan_Spill", "light.anchor.screenCool")
    assign_role("Screen_Warm_Spill", "light.anchor.screenWarm")
    for obj in bpy.context.scene.objects:
        if obj.name.startswith("Floor_Tile_"):
            obj["semantic_role"] = "floor.tile"


def bake_room_scale() -> None:
    scene = bpy.context.scene
    if scene.get("ops_room_scale_baked"):
        raise RuntimeError("Room scale was already baked; refusing to apply 1.5x twice")
    scalable_types = {"MESH", "CURVE", "SURFACE", "FONT"}
    bpy.ops.object.select_all(action="DESELECT")
    selected: list[bpy.types.Object] = []
    for obj in scene.objects:
        if obj.parent is not None:
            raise RuntimeError(f"Unexpected parented object during scale bake: {obj.name}")
        obj.location *= SCALE_FACTOR
        if obj.type in scalable_types:
            obj.scale *= SCALE_FACTOR
            obj.select_set(True)
            selected.append(obj)
        elif obj.type == "CAMERA":
            obj.data.clip_start *= SCALE_FACTOR
            obj.data.clip_end *= SCALE_FACTOR
        elif obj.type == "LIGHT":
            if hasattr(obj.data, "size"):
                obj.data.size *= SCALE_FACTOR
            if hasattr(obj.data, "size_y"):
                obj.data.size_y *= SCALE_FACTOR
    if selected:
        bpy.context.view_layer.objects.active = selected[0]
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    scene["ops_room_scale_baked"] = SCALE_FACTOR
    scene["semantic_role"] = "room.panoramicTheater"
    scene["theme_hint"] = "tron-restrained"


def export_paths() -> tuple[Path, Path]:
    source = Path(bpy.data.filepath)
    workspace = next(p for p in source.parents if (p / "frontend").is_dir())
    return source, workspace / "frontend" / "public" / "assets" / "panoramic_command_theater_architecture.glb"


def main() -> None:
    source, glb_path = export_paths()
    if not source.name:
        raise RuntimeError("The authored Blender scene must be saved before running this build")
    backup = source.with_name("panoramic_command_theater_architecture.pre_tron_20260814.blend")
    if not backup.exists():
        raise RuntimeError(f"Required recovery copy is missing: {backup}")

    screen_measurements: dict[int, dict[str, float]] = {}
    for index, name in enumerate(SCREEN_NAMES, start=1):
        screen_measurements[index] = rebuild_rounded_slab(
            bpy.data.objects[name], "screen.surface", index
        )
    for index, name in enumerate(FRAME_NAMES, start=1):
        rebuild_rounded_slab(bpy.data.objects[name], "screen.frame", index)
    for index, name in enumerate(SCREEN_NAMES, start=1):
        create_light_rail(bpy.data.objects[name], screen_measurements[index], index)

    remove_retired_decor()
    assign_scene_roles()
    bake_room_scale()
    bpy.ops.wm.save_as_mainfile(filepath=str(source))
    glb_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        export_yup=True,
        export_extras=True,
        export_apply=False,
    )

    bounds = bpy.data.objects["Room_Enclosed_Circular_Shell"].dimensions
    result = {
        "blend": str(source),
        "glb": str(glb_path),
        "room_dimensions": list(bounds),
        "object_count": len(bpy.context.scene.objects),
        "rails": [f"Wall_Screen_{index}_Light_Rail" for index in range(1, 4)],
        "scale_baked": bpy.context.scene["ops_room_scale_baked"],
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
