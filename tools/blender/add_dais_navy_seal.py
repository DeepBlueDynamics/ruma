"""Author the Navy seal as a centered decal on the panoramic theater dais.

Run inside the already-open Panoramic_Command_Theater Blender scene. The pass is
idempotent: it replaces only Dais_Navy_Seal, then saves the BLEND and exports the
root and frontend GLBs from the same authored scene.
"""

from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

import bpy
from mathutils import Vector


OBJECT_NAME = "Dais_Navy_Seal"
MATERIAL_NAME = "Dais_Navy_Seal_Material"
IMAGE_NAME = "navyseal.png"
SEGMENTS = 128
TOP_INSET_RATIO = 0.11
SURFACE_OFFSET = 0.004
EMISSION_STRENGTH = 0.55
ROUGHNESS = 0.96
SPECULAR_LEVEL = 0.0


def remove_previous() -> None:
    previous = bpy.data.objects.get(OBJECT_NAME)
    if previous is not None:
        mesh = previous.data
        bpy.data.objects.remove(previous, do_unlink=True)
        if mesh and mesh.users == 0:
            bpy.data.meshes.remove(mesh)

    material = bpy.data.materials.get(MATERIAL_NAME)
    if material is not None and material.users == 0:
        bpy.data.materials.remove(material)


def world_bounds(obj: bpy.types.Object) -> tuple[Vector, Vector]:
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    low = Vector((
        min(corner.x for corner in corners),
        min(corner.y for corner in corners),
        min(corner.z for corner in corners),
    ))
    high = Vector((
        max(corner.x for corner in corners),
        max(corner.y for corner in corners),
        max(corner.z for corner in corners),
    ))
    return low, high


def build_material(image_path: Path) -> bpy.types.Material:
    material = bpy.data.materials.new(MATERIAL_NAME)
    material.use_nodes = True
    material.diffuse_color = (1.0, 1.0, 1.0, 1.0)
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = bpy.data.images.load(str(image_path), check_existing=True)
    texture.interpolation = "Linear"

    shader.inputs["Roughness"].default_value = ROUGHNESS
    shader.inputs["Metallic"].default_value = 0.0
    specular = shader.inputs.get("Specular IOR Level") or shader.inputs.get("Specular")
    if specular is not None:
        specular.default_value = SPECULAR_LEVEL
    links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    links.new(texture.outputs["Alpha"], shader.inputs["Alpha"])
    emission_color = shader.inputs.get("Emission Color") or shader.inputs.get("Emission")
    emission_strength = shader.inputs.get("Emission Strength")
    if emission_color is not None:
        links.new(texture.outputs["Color"], emission_color)
    if emission_strength is not None:
        emission_strength.default_value = EMISSION_STRENGTH
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])

    if hasattr(material, "surface_render_method"):
        material.surface_render_method = "DITHERED"
    elif hasattr(material, "blend_method"):
        material.blend_method = "BLEND"
    material.use_backface_culling = True
    return material


def build_seal(top: bpy.types.Object, image_path: Path) -> bpy.types.Object:
    low, high = world_bounds(top)
    center_x = (low.x + high.x) * 0.5
    center_y = (low.y + high.y) * 0.5
    radius = min(high.x - low.x, high.y - low.y) * (0.5 - TOP_INSET_RATIO)
    height = high.z + SURFACE_OFFSET

    vertices = [(center_x, center_y, height)]
    uvs = [(0.5, 0.5)]
    for index in range(SEGMENTS):
        angle = 2.0 * math.pi * index / SEGMENTS
        cosine, sine = math.cos(angle), math.sin(angle)
        vertices.append((center_x + radius * cosine, center_y + radius * sine, height))
        uvs.append((0.5 + 0.5 * cosine, 0.5 + 0.5 * sine))
    faces = [
        (0, index + 1, ((index + 1) % SEGMENTS) + 1)
        for index in range(SEGMENTS)
    ]

    mesh = bpy.data.meshes.new(f"{OBJECT_NAME}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for polygon in mesh.polygons:
        for loop_index in polygon.loop_indices:
            vertex_index = mesh.loops[loop_index].vertex_index
            uv_layer.data[loop_index].uv = uvs[vertex_index]

    seal = bpy.data.objects.new(OBJECT_NAME, mesh)
    bpy.context.scene.collection.objects.link(seal)
    seal.data.materials.append(build_material(image_path))
    seal["semantic_role"] = "decal.dais.navySeal"
    seal["source_asset"] = IMAGE_NAME
    seal["placement"] = "pedestal.top.center"
    seal["self_illumination"] = EMISSION_STRENGTH
    seal["highlight_response"] = "disabled"
    return seal


def export_scene(source: Path) -> tuple[Path, Path]:
    root_glb = source.with_suffix(".glb")
    workspace = next(p for p in source.parents if (p / "frontend").is_dir())
    frontend_glb = workspace / "frontend" / "public" / "assets" / root_glb.name
    bpy.ops.export_scene.gltf(
        filepath=str(root_glb),
        export_format="GLB",
        export_yup=True,
        export_extras=True,
        export_apply=False,
    )
    frontend_glb.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root_glb, frontend_glb)
    return root_glb, frontend_glb


def main() -> None:
    source = Path(bpy.data.filepath)
    if not source.name:
        raise RuntimeError("The authored Blender scene must be saved before adding the dais seal")
    image_path = source.parent / IMAGE_NAME
    if not image_path.exists():
        raise FileNotFoundError(image_path)
    top = bpy.data.objects.get("Pedestal_Top")
    if top is None:
        raise RuntimeError("Required authored object Pedestal_Top is missing")

    remove_previous()
    seal = build_seal(top, image_path)
    bpy.context.view_layer.update()
    bpy.ops.wm.save_as_mainfile(filepath=str(source))
    root_glb, frontend_glb = export_scene(source)

    low, high = world_bounds(seal)
    print(json.dumps({
        "object": seal.name,
        "semantic_role": seal["semantic_role"],
        "bounds": {"min": list(low), "max": list(high)},
        "blend": str(source),
        "root_glb": str(root_glb),
        "frontend_glb": str(frontend_glb),
    }))


if __name__ == "__main__":
    main()
