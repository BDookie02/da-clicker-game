import bpy
import math
import os
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT_DIR = os.path.join(ROOT, 'tools', 'blender', 'prototype')
os.makedirs(OUT_DIR, exist_ok=True)
PNG = os.path.join(OUT_DIR, 'fuzzy_dice_blender_preview.png')
BLEND = os.path.join(OUT_DIR, 'fuzzy_dice_blender_prototype.blend')

# Clean scene.
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 720
scene.render.resolution_y = 720
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = PNG
scene.render.film_transparent = False
scene.render.image_settings.color_mode = 'RGBA'
scene.world = bpy.data.worlds.new('Prototype World')
scene.world.color = (0.025, 0.012, 0.03)

def material(name, color, roughness=0.6, metallic=0.0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1.0)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    return m

dice_mat = material('Plush magenta fabric', (0.68, 0.012, 0.30), 0.72)
nodes = dice_mat.node_tree.nodes
links = dice_mat.node_tree.links
bsdf = nodes.get('Principled BSDF')
noise = nodes.new('ShaderNodeTexNoise')
noise.inputs['Scale'].default_value = 34.0
noise.inputs['Detail'].default_value = 3.0
noise.inputs['Roughness'].default_value = 0.78
noise.inputs['Distortion'].default_value = 0.18
bump = nodes.new('ShaderNodeBump')
bump.inputs['Strength'].default_value = 0.25
bump.inputs['Distance'].default_value = 0.075
links.new(noise.outputs['Fac'], bump.inputs['Height'])
links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
dark = nodes.new('ShaderNodeValToRGB')
dark.color_ramp.elements[0].color = (0.10, 0.002, 0.035, 1)
dark.color_ramp.elements[1].color = (0.86, 0.02, 0.42, 1)
links.new(noise.outputs['Fac'], dark.inputs['Fac'])
links.new(dark.outputs['Color'], bsdf.inputs['Base Color'])

pip_mat = material('Warm white pip fabric', (1.0, 0.93, 0.98), 0.38)
cord_mat = material('Charcoal cord', (0.018, 0.012, 0.02), 0.82)
back_mat = material('Studio plum backdrop', (0.055, 0.018, 0.075), 0.9)

def look_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()

def rounded_cube(name, location, scale, mat):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = obj.modifiers.new('Soft plush corners', 'BEVEL')
    bevel.width = 0.16
    bevel.segments = 5
    bevel.limit_method = 'ANGLE'
    obj.data.materials.append(mat)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj

def ico(name, location, scale, mat, subdivisions=2):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1.0, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj

def pip(name, location, scale, rotation=(0, 0, 0)):
    obj = ico(name, location, scale, pip_mat, subdivisions=2)
    obj.rotation_euler = rotation
    return obj

def cylinder_between(name, a, b, radius, mat, vertices=16):
    a, b = Vector(a), Vector(b)
    delta = b - a
    mid = (a + b) * 0.5
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=delta.length, location=mid)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler = delta.to_track_quat('Z', 'Y').to_euler()
    obj.data.materials.append(mat)
    return obj

def add_die(label, center, front_pattern, top_pattern, right_pattern):
    x, y, z = center
    rounded_cube(label, center, (2.05, 2.05, 2.05), dice_mat)
    # Sparse plush tufts along the silhouette; these read as fabric, not spikes.
    tufts = [(-0.88, -0.90, -0.90), (0.0, -0.94, -0.88), (0.88, -0.90, -0.90),
             (-0.92, 0.0, -0.92), (0.92, 0.0, -0.92), (-0.88, 0.90, -0.88),
             (0.0, 0.94, -0.90), (0.88, 0.90, -0.88)]
    for i, (dx, dy, dz) in enumerate(tufts):
        ico(f'{label}_fuzz_{i}', (x + dx, y + dy, z + dz), (0.16, 0.12, 0.16), dice_mat, 1)

    def coords(pattern, face):
        pts = []
        for px, pz in pattern:
            if face == 'front': pts.append((x + px * 0.48, y - 1.06, z + pz * 0.48))
            elif face == 'top': pts.append((x + px * 0.48, y + pz * 0.48, z + 1.06))
            elif face == 'right': pts.append((x + 1.06, y + px * 0.48, z + pz * 0.48))
        return pts

    for i, p in enumerate(coords(front_pattern, 'front')):
        pip(f'{label}_front_pip_{i}', p, (0.16, 0.055, 0.16))
    for i, p in enumerate(coords(top_pattern, 'top')):
        pip(f'{label}_top_pip_{i}', p, (0.16, 0.16, 0.055))
    for i, p in enumerate(coords(right_pattern, 'right')):
        pip(f'{label}_right_pip_{i}', p, (0.055, 0.16, 0.16), (0, math.pi / 2, 0))

# Two dice, slightly offset like the supplied local reference.
add_die('Left fuzzy die', (-1.12, 0.0, 0.0), [(-1,-1),(1,1),(0,0)], [(-1,-1),(1,1)], [(-1,-1),(-1,1),(1,-1),(1,1)])
add_die('Right fuzzy die', (1.12, 0.06, -0.05), [(-1,-1),(-1,1),(1,-1),(1,1),(0,0)], [(0,0)], [(-1,0),(1,0)])

# Centered hanger and split cords.
ico('Cord knot', (0.0, 0.0, 2.55), (0.20, 0.20, 0.20), cord_mat, 2)
cylinder_between('Left split cord', (0.0, 0.0, 2.55), (-1.12, 0.0, 1.08), 0.045, cord_mat)
cylinder_between('Right split cord', (0.0, 0.0, 2.55), (1.12, 0.06, 1.08), 0.045, cord_mat)
cylinder_between('Mirror cord', (0.0, 0.0, 3.4), (0.0, 0.0, 2.55), 0.05, cord_mat)

# Studio backdrop and floor.
bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 3.5, 0.0), rotation=(math.pi / 2, 0, 0))
back = bpy.context.object
back.name = 'Backdrop'
back.data.materials.append(back_mat)
bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, -2.1))
floor = bpy.context.object
floor.name = 'Floor'
floor.data.materials.append(back_mat)

# Camera.
bpy.ops.object.camera_add(location=(5.4, -9.0, 4.1))
camera = bpy.context.object
camera.data.lens = 58
camera.data.sensor_width = 36
look_at(camera, (0, 0.0, 0.35))
scene.camera = camera

def area(name, location, energy, size, color):
    bpy.ops.object.light_add(type='AREA', location=location)
    lamp = bpy.context.object
    lamp.name = name
    lamp.data.energy = energy
    lamp.data.shape = 'DISK'
    lamp.data.size = size
    lamp.data.color = color
    look_at(lamp, (0, 0, 0.2))
    return lamp

area('Key softbox', (-4.5, -5.0, 7.5), 850, 5.0, (1.0, 0.62, 0.86))
area('Fill softbox', (4.5, -2.0, 4.0), 500, 4.0, (0.52, 0.65, 1.0))
area('Rim light', (0.0, 3.0, 6.5), 950, 3.0, (1.0, 0.18, 0.48))

scene.view_settings.look = 'AgX - Medium High Contrast'
scene.render.filepath = PNG
bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.render.render(write_still=True)
print(PNG)
