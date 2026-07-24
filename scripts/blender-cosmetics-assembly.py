import bpy
import json
import math
import os
import random
import sys
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MANIFEST_PATH = os.path.join(ROOT, 'public', 'assets', 'cosmetics-assembly.json')
BLENDER_DIR = os.path.join(ROOT, 'tools', 'blender', 'output')
PREVIEW_DIR = os.path.join(BLENDER_DIR, 'previews')
BLEND_DIR = os.path.join(BLENDER_DIR, 'blend')
GLB_DIR = os.path.join(BLENDER_DIR, 'glb')
SCENE_DIR = os.path.join(BLENDER_DIR, 'scenes')
for folder in (PREVIEW_DIR, BLEND_DIR, GLB_DIR, SCENE_DIR):
    os.makedirs(folder, exist_ok=True)

with open(MANIFEST_PATH, 'r', encoding='utf-8') as handle:
    MANIFEST = json.load(handle)
ITEMS = MANIFEST['items']

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
only_ids = set()
if '--ids' in args:
    only_ids = set(args[args.index('--ids') + 1].split(','))
selected_items = [item for item in ITEMS if not only_ids or item['id'] in only_ids]

PHYSICAL_IDS = {
    'orn_napkin', 'horn_sad', 'orn_cowboy', 'orn_cone', 'orn_monk', 'horn_air',
    'dangle_dice', 'dangle_beads', 'dangle_yinyang', 'dangle_fire',
    'dangle_censored', 'dangle_testing_coals', 'dangle_goop', 'roof_taxi',
}

ASSET_OBJECTS = []
MATERIALS = {}

def rgb(value):
    value = value.lstrip('#')
    return tuple(int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))

def reset_scene():
    global ASSET_OBJECTS, MATERIALS
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ASSET_OBJECTS = []
    MATERIALS = {}
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new('Preview World')
    scene.world.color = (0.018, 0.009, 0.026)
    scene.view_settings.look = 'AgX - Medium High Contrast'
    return scene

def mark(obj, asset=True):
    if asset:
        obj['cosmetic_asset'] = True
        ASSET_OBJECTS.append(obj)
    return obj

def mat(name, color, roughness=0.6, metallic=0.0, emission=None, asset_key=None):
    key = asset_key or name
    if key in MATERIALS:
        return MATERIALS[key]
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1.0)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if emission is not None:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1.0)
        bsdf.inputs['Emission Strength'].default_value = 1.8
    MATERIALS[key] = m
    return m

def noisy_mat(name, dark_color, light_color, scale=28.0, roughness=0.72):
    if name in MATERIALS:
        return MATERIALS[name]
    m = mat(name, light_color, roughness, asset_key=name)
    nodes = m.node_tree.nodes
    links = m.node_tree.links
    bsdf = nodes.get('Principled BSDF')
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = scale
    noise.inputs['Detail'].default_value = 3.0
    noise.inputs['Roughness'].default_value = 0.75
    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (*dark_color, 1.0)
    ramp.color_ramp.elements[1].color = (*light_color, 1.0)
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.25
    bump.inputs['Distance'].default_value = 0.07
    links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    links.new(noise.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return m

def censor_filter_mat():
    name = 'Thin Pixel Censor Filter'
    if name in MATERIALS:
        return MATERIALS[name]
    m = mat(name, (.055, .055, .075), .78, asset_key=name)
    nodes = m.node_tree.nodes
    links = m.node_tree.links
    bsdf = nodes.get('Principled BSDF')
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 7.0
    noise.inputs['Detail'].default_value = 0.0
    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    ramp.color_ramp.elements[0].position = .42
    ramp.color_ramp.elements[0].color = (.025, .025, .035, 1)
    ramp.color_ramp.elements[1].position = .58
    ramp.color_ramp.elements[1].color = (.34, .30, .38, 1)
    links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Alpha'].default_value = .47
    m.surface_render_method = 'DITHERED'
    return m

def gradient_mat(name, bottom, top):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nodes = m.node_tree.nodes
    nodes.clear()
    out = nodes.new('ShaderNodeOutputMaterial')
    emission = nodes.new('ShaderNodeEmission')
    tex = nodes.new('ShaderNodeTexCoord')
    sep = nodes.new('ShaderNodeSeparateXYZ')
    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (*bottom, 1.0)
    ramp.color_ramp.elements[1].color = (*top, 1.0)
    links = m.node_tree.links
    links.new(tex.outputs['Generated'], sep.inputs[0])
    links.new(sep.outputs['Z'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], emission.inputs['Color'])
    emission.inputs['Strength'].default_value = 0.75
    links.new(emission.outputs['Emission'], out.inputs['Surface'])
    return m

def add_cube(name, location, dimensions, material, bevel=0.0, asset=True, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new('Rounded edges', 'BEVEL')
        mod.width = bevel
        mod.segments = 4
        mod.limit_method = 'ANGLE'
    obj.data.materials.append(material)
    return mark(obj, asset)

def add_uv(name, location, scale, material, asset=True, segments=24, rings=12):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return mark(obj, asset)

def add_ico(name, location, scale, material, asset=True, subdivisions=2):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1.0, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return mark(obj, asset)

def add_cylinder(name, location, radius, depth, material, asset=True, vertices=16, rotation=(0, 0, 0), radius_top=None):
    if radius_top is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius, radius2=radius_top, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return mark(obj, asset)

def cylinder_between(name, a, b, radius, material, asset=True, vertices=16):
    a, b = Vector(a), Vector(b)
    delta = b - a
    obj = add_cylinder(name, (a + b) * 0.5, radius, delta.length, material, asset, vertices)
    obj.rotation_euler = delta.to_track_quat('Z', 'Y').to_euler()
    return obj

def cone_between(name, base, tip, radius, material, asset=True, vertices=16):
    base, tip = Vector(base), Vector(tip)
    delta = tip - base
    obj = add_cylinder(name, (base + tip) * 0.5, radius, delta.length, material, asset, vertices, radius_top=0.0)
    obj.rotation_euler = delta.to_track_quat('Z', 'Y').to_euler()
    return obj

def add_torus(name, location, major_radius, minor_radius, material, asset=True, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major_radius, minor_radius=minor_radius, major_segments=24, minor_segments=8, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(material)
    return mark(obj, asset)

def extruded_shape(name, outline, depth, material, location=(0, 0, 0), asset=True):
    vertices = [(x, -depth / 2, z) for x, z in outline] + [(x, depth / 2, z) for x, z in outline]
    count = len(outline)
    faces = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    mesh = bpy.data.meshes.new(f'{name} mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.data.materials.append(material)
    bevel = obj.modifiers.new('Soft silhouette', 'BEVEL')
    bevel.width = min(0.08, depth * 0.2)
    bevel.segments = 3
    return mark(obj, asset)

def look_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()

def add_camera(location, target, lens=55):
    bpy.ops.object.camera_add(location=location)
    camera = bpy.context.object
    camera.data.lens = lens
    camera.data.sensor_width = 36
    look_at(camera, target)
    bpy.context.scene.camera = camera
    return camera

def add_area(name, location, energy, size, color, target=(0, 0, 0)):
    bpy.ops.object.light_add(type='AREA', location=location)
    lamp = bpy.context.object
    lamp.name = name
    lamp.data.energy = energy
    lamp.data.shape = 'DISK'
    lamp.data.size = size
    lamp.data.color = color
    look_at(lamp, target)
    return lamp

def studio(slot, target=(0, 0, 0.4), camera=(6.3, -10.0, 4.6)):
    plum = mat('Studio Plum', (0.045, 0.015, 0.065), 0.92)
    dash = mat('Dashboard Rubber', (0.035, 0.038, 0.050), 0.8)
    mirror = mat('Mirror Housing', (0.020, 0.025, 0.036), 0.38)
    glass = mat('Mirror Glass', (0.26, 0.36, 0.42), 0.18, metallic=0.15)
    add_cube('Studio backdrop', (0, 3.7, 1.1), (18, 0.25, 12), plum, asset=False)
    if slot == 'dangler':
        add_cube('Rear-view mirror housing', (0, 0.65, 4.0), (5.2, 0.55, 0.9), mirror, 0.18, asset=False)
        add_cube('Rear-view mirror glass', (0, 0.34, 4.0), (4.45, 0.08, 0.50), glass, 0.08, asset=False)
        target = (0, 0, 0.65)
    elif slot == 'roof':
        add_cube('Roof preview panel', (0, 0.3, -1.35), (8.2, 5.0, 0.55), dash, 0.35, asset=False)
        target = (0, 0, 0.3)
    else:
        add_cube('Dashboard preview surface', (0, 0.5, -1.55), (8.0, 5.0, 0.50), dash, 0.30, asset=False)
    add_camera(camera, target)
    add_area('Key', (-4.5, -5.0, 7.5), 900, 5.0, (1.0, 0.62, 0.84), target)
    add_area('Fill', (4.5, -2.0, 4.0), 520, 4.0, (0.50, 0.67, 1.0), target)
    add_area('Rim', (0.0, 3.0, 7.0), 1000, 3.0, (1.0, 0.18, 0.48), target)

def plush_material():
    return noisy_mat('Plush Magenta', (0.08, 0.001, 0.02), (0.92, 0.025, 0.43), 34.0, 0.74)

def add_pip(name, location, scale, material):
    return add_ico(name, location, scale, material, subdivisions=2)

def build_dice():
    plush = plush_material()
    white = mat('Warm White Pips', (1.0, 0.93, 0.98), 0.36)
    cord = mat('Charcoal Cord', (0.012, 0.008, 0.015), 0.82)
    def die(label, center, front, top, side):
        x, y, z = center
        add_cube(label, center, (2.05, 2.05, 2.05), plush, 0.16)
        for i, (dx, dy, dz) in enumerate([(-.9,-.95,-.9),(0,-.95,-.9),(.9,-.95,-.9),(-.92,0,-.92),(.92,0,-.92),(-.9,.92,-.9),(.9,.92,-.9)]):
            add_ico(f'{label} fuzz {i}', (x+dx, y+dy, z+dz), (.15,.11,.15), plush, subdivisions=1)
        for i, (px, pz) in enumerate(front):
            add_pip(f'{label} front pip {i}', (x+px*.48, y-1.055, z+pz*.48), (.16,.055,.16), white)
        for i, (px, py) in enumerate(top):
            add_pip(f'{label} top pip {i}', (x+px*.48, y+py*.48, z+1.055), (.16,.16,.055), white)
        for i, (py, pz) in enumerate(side):
            # Thin axis stays on X so side pips sit flush against the die face.
            add_pip(f'{label} side pip {i}', (x+1.055, y+py*.48, z+pz*.48), (.055,.16,.16), white)
    die('Left Fuzzy Die', (-1.12,0,0), [(-1,-1),(0,0),(1,1)], [(-1,-1),(1,1)], [(-1,-1),(-1,1),(1,-1),(1,1)])
    die('Right Fuzzy Die', (1.12,.06,-.05), [(-1,-1),(-1,1),(0,0),(1,-1),(1,1)], [(0,0)], [(-1,0),(1,0)])
    add_ico('Cord Knot', (0,0,2.55), (.20,.20,.20), cord)
    cylinder_between('Left Split Cord', (0,0,2.55), (-1.12,0,1.08), .045, cord)
    cylinder_between('Right Split Cord', (0,0,2.55), (1.12,.06,1.08), .045, cord)
    cylinder_between('Mirror Cord', (0,0,3.6), (0,0,2.55), .05, cord)

def build_napkin():
    cloth = noisy_mat('Ivory Napkin Cloth', (0.55,0.53,0.48), (0.96,0.94,0.87), 42, .88)
    stitch = mat('Napkin Stitch', (0.56,0.15,0.20), .65)
    for layer in range(4):
        add_cube(f'Napkin Fold {layer}', (0.06*layer, 0.02*layer, -1.18+layer*.075), (4.4-layer*.12, 2.8-layer*.08, .09), cloth, .06, rotation=(0,0,math.radians(2-layer)))
    fold = [(0,0),(1.6,0),(1.6,1.2)]
    extruded_shape('Folded Corner', fold, .10, cloth, (-.2,-1.38,-1.02))
    for i in range(11):
        add_uv(f'Red Stitch {i}', (-1.85+i*.36,-1.48,-1.04), (.035,.035,.035), stitch, segments=10, rings=6)

def build_violin():
    wood = noisy_mat('Violin Maple', (.18,.035,.018), (.68,.20,.10), 8, .42)
    dark = mat('Violin Ebony', (.025,.018,.020), .34)
    cream = mat('Bridge Maple', (.78,.57,.31), .52)
    metal = mat('Strings', (.75,.75,.70), .22, metallic=.65)
    outline = [(-.65,-1.35),(-1.25,-1.05),(-1.45,-.45),(-1.12,.05),(-.78,.18),(-.72,.55),(-1.16,.95),(-1.0,1.45),(-.55,1.72),(0,1.82),(.55,1.72),(1.0,1.45),(1.16,.95),(.72,.55),(.78,.18),(1.12,.05),(1.45,-.45),(1.25,-1.05),(.65,-1.35),(0,-1.5)]
    extruded_shape('Violin Body', outline, .48, wood, (0,0,-.05))
    add_cube('Tailpiece', (0,-.28,-.82), (.48,.18,.65), dark, .08)
    add_cube('Neck', (0,0,2.22), (.24,.28,2.2), wood, .05)
    add_cube('Fingerboard', (0,-.22,1.55), (.19,.08,2.4), dark, .03)
    add_ico('Scroll', (0,0,3.45), (.38,.27,.38), wood)
    add_cube('Bridge', (0,-.32,.05), (.95,.10,.22), cream, .03)
    for x in (-.055,.055):
        cylinder_between('String', (x,-.39,-.62), (x,-.39,3.35), .012, metal, vertices=8)
    for x in (-.62,.62):
        add_torus('F Hole', (x,-.27,.05), .20,.045,dark,rotation=(math.pi/2,0,0))
    for x in (-.48,.48):
        add_cylinder('Tuning Peg', (x,0,2.98), .07,.55,dark,rotation=(0,math.pi/2,0))

def build_hula():
    skin = mat('Warm Skin', (.66,.31,.15), .56)
    hair = mat('Dark Hair', (.035,.018,.015), .52)
    green = mat('Grass Skirt', (.12,.58,.22), .68)
    red = mat('Hula Top', (.72,.05,.16), .54)
    yellow = mat('Lei Yellow', (1.0,.55,.05), .48)
    base = mat('Hawaii Base', (.22,.12,.07), .64)
    add_cylinder('Dashboard Base',(0,0,-1.2),1.15,.32,base,vertices=28)
    add_cylinder('Spring Neck',(0,0,-.83),.13,.55,mat('Spring',(.22,.22,.20),.30,metallic=.7),vertices=12)
    for x in (-.32,.32):
        add_cylinder('Leg',(x,0,-.40),.18,.72,skin,rotation=(math.radians(-8 if x<0 else 8),0,0))
    add_cylinder('Skirt Core',(0,0,.10),.82,1.05,green,vertices=28,radius_top=.42)
    for i in range(18):
        angle=2*math.pi*i/18
        add_cube(f'Grass Strand {i}',(.62*math.cos(angle),.62*math.sin(angle),-.05),(.10,.06,1.15),green,.025,rotation=(0,math.radians(9*math.sin(angle)),angle))
    add_cylinder('Torso',(0,0,1.02),.43,1.05,red,vertices=20,radius_top=.34)
    add_uv('Head',(0,-.02,2.02),(.63,.56,.72),skin,segments=24,rings=14)
    add_uv('Hair Cap',(0,.08,2.38),(.66,.58,.38),hair,segments=20,rings=10)
    add_uv('Hair Bun',(.43,.18,2.55),(.32,.30,.34),hair)
    for x in (-.22,.22):
        add_uv('Eye',(x,-.54,2.12),(.055,.025,.075),hair,segments=10,rings=6)
    add_uv('Smile',(0,-.56,1.84),(.18,.025,.045),mat('Smile',(.25,.02,.02),.5),segments=12,rings=6)
    cylinder_between('Left Arm',(-.34,-.02,1.35),(-.96,-.25,.86),.13,skin)
    cylinder_between('Right Arm',(.34,-.02,1.35),(1.02,-.18,1.58),.13,skin)
    for i in range(10):
        angle=2*math.pi*i/10
        add_uv(f'Lei Bead {i}',(.38*math.cos(angle),-.43,1.34+.24*math.sin(angle)),(.075,.045,.075),yellow,segments=10,rings=6)
    for i in range(5):
        angle=2*math.pi*i/5
        add_uv(f'Hair Flower {i}',(.57+.13*math.cos(angle),-.30,2.43+.13*math.sin(angle)),(.10,.04,.075),mat('Flower Pink',(.95,.18,.45),.48),segments=10,rings=6)

def build_cone():
    orange = mat('Cone Orange', (.95,.23,.035), .58)
    white = mat('Reflective White', (.95,.95,.86), .28)
    black = mat('Rubber Base', (.045,.045,.05), .82)
    add_cube('Square Rubber Base',(0,0,-1.20),(2.75,2.75,.34),black,.12)
    add_cylinder('Cone Body',(0,0,.14),1.00,2.55,orange,vertices=16,radius_top=.18)
    add_cylinder('Reflective Band Lower',(0,0,.10),.73,.38,white,vertices=16,radius_top=.58)
    add_cylinder('Reflective Band Upper',(0,0,.62),.55,.32,white,vertices=16,radius_top=.43)

def build_monk():
    bronze = noisy_mat('Antique Buddha Bronze', (.18,.07,.018), (.86,.47,.08), 7, .46)
    gold = mat('Worn Gold Highlights', (.92,.49,.07), .42, metallic=.22)
    dark = mat('Buddha Recesses', (.055,.022,.012), .72)
    base = mat('Dark Lotus Base', (.10,.045,.018), .66, metallic=.12)
    add_cylinder('Lotus Plinth',(0,0,-1.18),1.24,.28,base,vertices=32)
    add_torus('Lower Lotus Ring',(0,0,-1.02),.91,.16,bronze)
    for i in range(12):
        angle=2*math.pi*i/12
        petal=add_uv(f'Lotus Petal {i}',(.78*math.cos(angle),.78*math.sin(angle),-.90),(.34,.18,.16),gold,segments=16,rings=8)
        petal.rotation_euler.z=angle
    # Crossed lotus legs, a tapered robed torso, and hands resting in the lap.
    left_leg=add_uv('Crossed Left Leg',(-.47,-.02,-.63),(.78,.58,.34),bronze)
    right_leg=add_uv('Crossed Right Leg',(.47,-.02,-.63),(.78,.58,.34),bronze)
    left_leg.rotation_euler.y=math.radians(-12); right_leg.rotation_euler.y=math.radians(12)
    add_cylinder('Robe Torso',(0,.02,.10),.72,1.42,bronze,vertices=28,radius_top=.43)
    cylinder_between('Left Resting Arm',(-.43,-.02,.48),(-.25,-.52,-.22),.15,bronze,vertices=18)
    cylinder_between('Right Resting Arm',(.43,-.02,.48),(.25,-.52,-.22),.15,bronze,vertices=18)
    add_uv('Meditation Hands',(0,-.58,-.25),(.42,.18,.17),gold,segments=18,rings=9)
    # Buddha-specific head silhouette: elongated ears, closed eyes, urna and ushnisha.
    add_uv('Buddha Head',(0,-.02,1.36),(.57,.50,.67),bronze,segments=28,rings=16)
    add_uv('Left Elongated Ear',(-.58,-.02,1.29),(.14,.12,.35),bronze,segments=16,rings=9)
    add_uv('Right Elongated Ear',(.58,-.02,1.29),(.14,.12,.35),bronze,segments=16,rings=9)
    add_uv('Ushnisha',(0,.01,1.98),(.31,.28,.28),bronze,segments=20,rings=10)
    add_uv('Top Finial',(0,.01,2.22),(.11,.10,.16),gold,segments=14,rings=8)
    add_uv('Nose',(0,-.50,1.34),(.08,.08,.17),gold,segments=14,rings=8)
    for x in (-.20,.20):
        add_cube('Closed Eye',(x,-.495,1.48),(.22,.025,.035),dark,.012,rotation=(0,0,math.radians(-5 if x<0 else 5)))
    add_uv('Urna',(0,-.51,1.61),(.045,.025,.045),gold,segments=10,rings=6)
    add_cube('Robe Sash',(-.18,-.43,.38),(.16,.08,1.18),gold,.035,rotation=(0,math.radians(-18),math.radians(-12)))

def build_airhorn():
    red = mat('Safety Horn Red', (.78,.012,.006), .32)
    blue = mat('Compressed Air Blue', (.015,.18,.56), .28, metallic=.18)
    white = mat('Can Label White', (.92,.93,.88), .42)
    metal = mat('Horn Hardware', (.62,.68,.72), .22, metallic=.75)
    black = mat('Horn Mouth and Valve', (.018,.020,.025), .58)
    # Upright compressed-air canister with proper rims and a front label.
    add_cylinder('Air Canister',(-.82,0,-.48),.56,1.95,blue,vertices=28)
    add_cylinder('Can Top Rim',(-.82,0,.51),.59,.12,metal,vertices=28)
    add_cylinder('Can Bottom Rim',(-.82,0,-1.47),.59,.10,metal,vertices=28)
    add_cube('Canister Label',(-.82,-.555,-.53),(.78,.035,.78),white,.06)
    pixel_text('AIR',(-.82,-.59,-.52),.57,red,True,.035)
    add_cube('Valve Body',(-.60,0,.72),(.62,.62,.42),black,.10)
    add_cube('Trigger Lever',(-.58,-.43,.56),(.16,.55,.12),metal,.04,rotation=(math.radians(-18),0,0))
    # Narrow throat at the canister, expanding toward the clearly open bell.
    add_cylinder('Horn Throat',(.02,0,.78),.22,1.15,red,vertices=28,rotation=(0,math.pi/2,0),radius_top=.30)
    add_cylinder('Horn Bell',(1.28,0,.78),.30,2.05,red,vertices=32,rotation=(0,math.pi/2,0),radius_top=1.08)
    add_cylinder('Dark Open Mouth',(2.32,0,.78),1.01,.055,black,vertices=32,rotation=(0,math.pi/2,0))
    add_torus('Polished Bell Rim',(2.34,0,.78),1.10,.10,metal,rotation=(0,math.pi/2,0))
    cylinder_between('Valve Pipe',(-.35,0,.78),(-.02,0,.78),.10,metal,vertices=16)

def build_beads():
    cord = mat('Bead Cord',(.02,.018,.025),.82)
    palette=[mat('Coral',(.95,.15,.30),.48),mat('Turquoise',(.04,.72,.78),.42),mat('Gold',(.98,.58,.04),.38,metallic=.2),mat('Purple',(.48,.12,.70),.48)]
    points=[]
    for i in range(17):
        t=i/16
        x=-1.55+3.10*t
        z=3.48-3.10*math.sin(math.pi*t)
        points.append((x,0,z))
    for i in range(len(points)-1):
        cylinder_between(f'Bead Cord {i}',points[i],points[i+1],.035,cord)
    for i,p in enumerate(points):
        add_uv(f'Bead {i}',p,(.18,.18,.18),palette[i%len(palette)],segments=14,rings=8)
    add_ico('Center Charm',(0,0,.10),(.42,.22,.52),palette[2],subdivisions=2)

def build_yinyang():
    white=mat('Yin White',(.95,.95,.91),.38)
    black=mat('Yang Black',(.018,.018,.024),.46)
    cord=mat('Yin Cord',(.025,.02,.03),.80)
    ball=add_uv('Yin Yang Ball',(0,0,.10),(1.25,1.10,1.25),white,segments=32,rings=18)
    ball.data.materials.append(black)
    for polygon in ball.data.polygons:
        center=sum((ball.data.vertices[index].co for index in polygon.vertices),Vector())/len(polygon.vertices)
        boundary=.34*math.sin(center.z*math.pi/1.25)
        polygon.material_index=1 if center.x<boundary else 0
    add_uv('White Yin Dot',(-.34,-1.08,.55),(.20,.055,.20),white,segments=16,rings=8)
    add_uv('Black Yang Dot',(.34,-1.08,-.34),(.20,.055,.20),black,segments=16,rings=8)
    cylinder_between('Mirror Cord',(0,0,3.65),(0,0,1.38),.05,cord)

def build_fireball():
    cord=mat('Fire Cord',(.03,.015,.01),.80)
    red=mat('Fire Outer Red',(.62,.008,.002),.42,emission=(.07,.001,.0))
    orange=mat('Fire Middle Orange',(1.0,.11,.003),.36,emission=(.10,.008,.0))
    yellow=mat('Fire Core Yellow',(1.0,.58,.018),.30,emission=(.13,.035,.001))
    outer=[(0,1.42),(-.22,.98),(-.48,1.20),(-.42,.58),(-.82,.18),(-.74,-.55),(-.42,-.98),(0,-1.18),(.46,-.98),(.78,-.54),(.84,.02),(.50,.55),(.38,1.12),(.14,.84)]
    middle=[(0,.92),(-.18,.55),(-.35,.72),(-.30,.18),(-.52,-.18),(-.42,-.68),(0,-.91),(.43,-.66),(.50,-.12),(.27,.30),(.18,.78)]
    core=[(0,.38),(-.20,.05),(-.26,-.34),(0,-.65),(.27,-.33),(.18,.10)]
    extruded_shape('Outer Flame Silhouette',outer,.62,red,location=(0,0,-.05))
    extruded_shape('Middle Flame',middle,.07,orange,location=(0,-.35,-.12))
    extruded_shape('Hot Core',core,.06,yellow,location=(0,-.40,-.22))
    add_torus('Fireball Hanging Ring',(0,0,1.43),.18,.055,cord,rotation=(math.pi/2,0,0))
    cylinder_between('Mirror Cord',(0,0,3.65),(0,0,1.60),.05,cord)

def build_censored():
    pink=mat('Novelty Pink',(.95,.18,.52),.48)
    filter_material=censor_filter_mat()
    cord=mat('Censor Cord',(.025,.018,.025),.82)
    add_uv('Left Rounded Form',(-.47,0,-.82),(.62,.56,.62),pink)
    add_uv('Right Rounded Form',(.47,0,-.82),(.62,.56,.62),pink)
    add_cylinder('Central Form',(0,0,.08),.43,1.65,pink,vertices=20,radius_top=.34)
    add_uv('Rounded Tip',(0,0,.92),(.46,.44,.48),pink)
    # A closely conforming translucent duplicate is the thin all-angle video
    # censor filter; it follows the silhouette rather than boxing it in.
    add_uv('Left Filter Skin',(-.47,0,-.82),(.66,.60,.66),filter_material)
    add_uv('Right Filter Skin',(.47,0,-.82),(.66,.60,.66),filter_material)
    add_cylinder('Central Filter Skin',(0,0,.08),.47,1.71,filter_material,vertices=20,radius_top=.38)
    add_uv('Tip Filter Skin',(0,0,.92),(.50,.48,.52),filter_material)
    cylinder_between('Mirror Cord',(0,0,3.65),(0,0,1.40),.05,cord)

def build_testing_coals():
    magenta=noisy_mat('Original Organic Magenta',(.12,.005,.03),(.74,.025,.31),18,.76)
    cord=mat('Testing Cord',(.025,.018,.025),.86)
    for name,location,scale,seed in [('Left Test Coal',(-.60,0,-.25),(.72,.62,.82),4),('Right Test Coal',(.60,.02,-.35),(.76,.64,.78),9)]:
        obj=add_ico(name,location,scale,magenta,subdivisions=3)
        texture=bpy.data.textures.new(f'{name} roughness',type='CLOUDS')
        texture.noise_scale=.34
        modifier=obj.modifiers.new('Organic first-pass lumpiness','DISPLACE')
        modifier.texture=texture
        modifier.strength=.16
        modifier.texture_coords='GLOBAL'
    cylinder_between('Short Central Join',(-.22,0,-.25),(.22,.02,-.32),.055,cord)
    cylinder_between('Mirror Cord',(0,0,3.65),(0,0,.72),.05,cord)
    add_torus('Loose Test Loop',(-1.18,0,-.08),.32,.045,cord,rotation=(math.pi/2,0,0))

def build_goop_dangler():
    cord=mat('Goop Cord',(.025,.018,.025),.84)
    light=mat('Explosion Goop Light',rgb('#5fd629'),.42)
    mid=mat('Explosion Goop Mid',rgb('#31a91f'),.48)
    dark=mat('Explosion Goop Dark',rgb('#176316'),.56)
    add_ico('Goop Main Splash',(-.10,0,.12),(1.02,.66,.78),light,subdivisions=3)
    add_ico('Goop Right Splash',(.73,.03,.03),(.68,.50,.57),mid,subdivisions=2)
    add_ico('Goop Left Splash',(-.82,.04,-.02),(.55,.45,.50),dark,subdivisions=2)
    # Uneven outward droplets and spikes give it the opponent-explosion burst silhouette.
    for i,(x,z,radius,material) in enumerate(((-1.18,.45,.22,dark),(1.20,.38,.20,mid),(-.72,.86,.18,light),(.62,.92,.16,light))):
        add_ico(f'Goop Burst Droplet {i}',(x,0,z),(radius,radius*.82,radius),material,subdivisions=2)
    for i,(base,tip,radius,material) in enumerate((
        ((-.78,0,.35),(-1.38,0,.78),.22,dark), ((-.25,0,.70),(-.42,0,1.30),.18,light),
        ((.42,0,.64),(.72,0,1.24),.18,light), ((.76,0,.30),(1.42,0,.58),.20,mid))):
        cone_between(f'Goop Splash Spike {i}',base,tip,radius,material,vertices=12)
    # Wide at the blob and pointed at the bottom: true hanging drips.
    add_cylinder('Goop Drip Left',(-.52,0,-.88),.055,1.28,dark,vertices=12,radius_top=.21)
    add_cylinder('Goop Drip Center',(.08,0,-1.10),.045,1.62,light,vertices=12,radius_top=.26)
    add_cylinder('Goop Drip Right',(.72,0,-.76),.04,1.02,mid,vertices=12,radius_top=.18)
    cylinder_between('Mirror Cord',(0,0,3.65),(0,0,1.05),.05,cord)

PIXEL_FONT={
 'A':['01110','10001','10001','11111','10001','10001','10001'], 'B':['11110','10001','10001','11110','10001','10001','11110'],
 'C':['01111','10000','10000','10000','10000','10000','01111'], 'D':['11110','10001','10001','10001','10001','10001','11110'],
 'E':['11111','10000','10000','11110','10000','10000','11111'], 'G':['01111','10000','10000','10111','10001','10001','01110'],
 'I':['11111','00100','00100','00100','00100','00100','11111'], 'L':['10000','10000','10000','10000','10000','10000','11111'],
 'M':['10001','11011','10101','10101','10001','10001','10001'], 'N':['10001','11001','10101','10011','10001','10001','10001'],
 'O':['01110','10001','10001','10001','10001','10001','01110'], 'P':['11110','10001','10001','11110','10000','10000','10000'],
 'R':['11110','10001','10001','11110','10100','10010','10001'], 'S':['01111','10000','10000','01110','00001','00001','11110'],
 'T':['11111','00100','00100','00100','00100','00100','00100'], 'U':['10001','10001','10001','10001','10001','10001','01110'],
 'X':['10001','10001','01010','00100','01010','10001','10001'], 'Y':['10001','10001','01010','00100','00100','00100','00100'], '0':['01110','10001','10011','10101','11001','10001','01110'],
 '1':['00100','01100','00100','00100','00100','00100','01110'], '+':['00000','00100','00100','11111','00100','00100','00000'],
}

def pixel_text(text, center=(0,0,0), max_width=7.0, material=None, asset=True, depth=.10):
    text=text.upper()
    cell=max_width/max(1,len(text)*6-1)
    width=(len(text)*6-1)*cell
    start=-width/2
    for char_index,char in enumerate(text):
        pattern=PIXEL_FONT.get(char)
        if not pattern:
            continue
        for row,line in enumerate(pattern):
            for col,bit in enumerate(line):
                if bit=='1':
                    x=center[0]+start+(char_index*6+col)*cell
                    z=center[2]+(3-row)*cell
                    add_cube(f'Letter {char_index} {row} {col}',(x,center[1],z),(cell*.86,depth,cell*.86),material,.01,asset)

def build_taxi():
    yellow=mat('Taxi Yellow',(1.0,.70,.03),.34,emission=(.55,.25,.01))
    black=mat('Taxi Black',(.025,.025,.025),.56)
    white=mat('Taxi Face',(.94,.91,.72),.30,emission=(.55,.48,.25))
    add_cube('Taxi Mounting Base',(0,0,-.70),(4.4,2.15,.42),black,.18)
    add_cube('Taxi Lamp Housing',(0,0,.15),(3.8,1.75,1.55),yellow,.35)
    add_cube('Taxi Front Face',(0,-.91,.18),(3.20,.08,1.05),white,.14)
    pixel_text('TAXI',(0,-.98,.18),2.50,black,True,.08)

def build_decal(item):
    scene=bpy.context.scene
    navy=mat('Windshield Glass',(.018,.035,.055),.20,metallic=.15)
    frame=mat('Windshield Frame',(.025,.025,.032),.48)
    color=mat('Decal Ink',(.98,.90,.70) if item['id']!='decal_ment' else (.95,.12,.10),.35,emission=(.32,.18,.10))
    add_cube('Windshield Frame',(0,.25,0),(8.7,.38,4.8),frame,.32,asset=False)
    add_cube('Windshield Glass',(0,0,0),(8.0,.16,4.1),navy,.22,asset=False)
    pixel_text(item['value'],(0,-.13,0),6.15,color,asset=True,depth=.10)
    add_camera((0,-11,0.3),(0,0,0),58)
    add_area('Decal Key',(-3,-4,5),700,4,(1,.45,.25),(0,0,0))
    add_area('Decal Fill',(4,-2,2),500,4,(.35,.65,1),(0,0,0))

def build_goop_finish(item):
    panel=mat('Car Panel',(.055,.065,.08),.28,metallic=.45)
    value=rgb(item['value'])
    goo=mat(f"{item['name']} Material",value,.38,metallic=.08)
    add_cube('Painted Car Panel',(0,.4,-.25),(7.5,4.0,1.0),panel,.55,asset=False)
    rng=random.Random(item['id'])
    for i in range(18):
        x=rng.uniform(-2.9,2.9); y=rng.uniform(-1.15,1.25); scale=rng.uniform(.38,.88)
        add_uv(f'Static Goop Pool {i}',(x,y,.34),(scale,scale*.68,.16+scale*.08),goo,asset=True,segments=16,rings=8)
    for i,x in enumerate((-2.6,-1.35,-.10,1.25,2.55)):
        depth=.72+rng.random()*.62
        add_uv(f'Edge Goop {i}',(x,-1.46,.30),(.50,.36,.18),goo,asset=True,segments=16,rings=8)
        add_cylinder(f'Static Drip {i}',(x,-1.66,.06-depth/2),.05,depth,goo,asset=True,vertices=12,radius_top=.18)
        add_uv(f'Drip Drop {i}',(x,-1.66,.06-depth),(.12,.12,.16),goo,asset=True,segments=14,rings=8)
    add_camera((7.8,-9.5,6.1),(0,0,-.05),58)
    add_area('Panel Key',(-4,-5,8),1100,5,(1,.65,.80),(0,0,0))
    add_area('Panel Fill',(5,-2,4),650,4,(.45,.68,1),(0,0,0))
    add_area('Panel Rim',(0,4,7),900,3,(1,.25,.45),(0,0,0))

SKY_COLORS={
 'sunset':((.75,.19,.14),(1.0,.64,.20)), 'vapor':((.04,.02,.18),(.78,.08,.65)),
 'storm':((.06,.08,.13),(.28,.34,.43)), 'noir':((.015,.018,.025),(.40,.42,.46)),
 'toxic':((.15,.22,.025),(.68,.82,.08)), 'mint':((.12,.48,.42),(.55,1.0,.78)),
}

def build_sky(item):
    key=item['value']; bottom,top=SKY_COLORS[key]
    sky=gradient_mat(f'{item["name"]} Gradient',bottom,top)
    road=mat('Sky Road',(.025,.03,.045),.82)
    building=mat('City Silhouette',(.025,.02,.04) if key!='noir' else (.055,.055,.06),.72)
    window=mat('City Windows',(.95,.68,.18) if key not in ('vapor','mint') else (.12,1.0,.82),.30,emission=(.55,.35,.08))
    add_cube('Environment Sky',(0,5.5,4.0),(20,.20,12),sky,asset=True)
    add_cube('Road',(0,0,-.85),(18,14,.30),road,asset=True)
    rng=random.Random(key)
    for i in range(13):
        x=-7.2+i*1.2; h=rng.uniform(2.0,5.5); z=-.55+h/2
        add_cube(f'Building {i}',(x,3.8,z),(1.0,1.8,h),building,.08,asset=True)
        for row in range(max(1,int(h//.8))):
            if (i+row)%3:
                add_cube(f'Window {i} {row}',(x,-0.0+2.86,z-h/2+.55+row*.72),(.16,.05,.20),window,.01,asset=True)
    if key in ('sunset','noir','toxic'):
        sun_color=(1.0,.44,.08) if key=='sunset' else ((.88,.90,.95) if key=='noir' else (.62,1.0,.08))
        add_uv('Environment Sun',(-3.5,5.25,5.7),(1.0,.10,1.0),mat('Sun',sun_color,.20,emission=sun_color),asset=True)
    if key=='storm':
        cloud_mat=mat('Storm Clouds',(.11,.13,.18),.92)
        for i in range(7): add_uv(f'Cloud {i}',(-4+i*1.25,4.9,5.4+(i%2)*.25),(1.2,.28,.55),cloud_mat,asset=True)
        bolt=[(0,.8),(-.35,.0),(.05,.0),(-.25,-.9),(.65,.25),(.20,.25)]
        extruded_shape('Lightning',bolt,.06,mat('Lightning',(.8,.9,1),.2,emission=(.8,.9,1)),(1.4,4.7,4.0),asset=True)
    if key=='vapor':
        grid=mat('Vapor Grid',(.02,.95,.88),.25,emission=(.02,.55,.48))
        for x in range(-7,8): add_cube('Grid Vertical',(x*.55,-1.2,-.62),(.025,8,.025),grid,asset=True)
        for y in range(-5,7): add_cube('Grid Horizontal',(0,y*.65,-.61),(8,.025,.025),grid,asset=True)
    if key in ('toxic','mint'):
        cloud_color=(.38,.55,.06) if key=='toxic' else (.32,.78,.65)
        cloud=mat('Atmosphere Clouds',cloud_color,.94)
        for i in range(6): add_uv(f'Haze {i}',(-4+i*1.6,4.9,5.2+(i%2)*.4),(1.4,.22,.48),cloud,asset=True)
    add_camera((0,-13,4.2),(0,2.4,2.3),47)

BUILDERS={
 'orn_napkin':build_napkin, 'horn_sad':build_violin, 'orn_cowboy':build_hula,
 'orn_cone':build_cone, 'orn_monk':build_monk, 'horn_air':build_airhorn,
 'dangle_dice':build_dice, 'dangle_beads':build_beads, 'dangle_yinyang':build_yinyang,
 'dangle_fire':build_fireball, 'dangle_censored':build_censored,
 'dangle_testing_coals':build_testing_coals, 'dangle_goop':build_goop_dangler,
 'roof_taxi':build_taxi,
}

def render_item(item):
    scene=reset_scene()
    item_id=item['id']
    if item_id in BUILDERS:
        BUILDERS[item_id]()
        studio(item['slot'])
    elif item['slot']=='decal':
        build_decal(item)
    elif item['slot']=='goop':
        build_goop_finish(item)
    elif item['slot']=='sky':
        build_sky(item)
    else:
        raise RuntimeError(f'No Blender builder for {item_id}')
    preview_path=os.path.join(PREVIEW_DIR,f'{item_id}.png')
    scene.render.filepath=preview_path
    # Save a render-scene source for every cosmetic. The review pipeline uses
    # this to pixelate the cosmetic layer without altering its background.
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SCENE_DIR,f'{item_id}.blend'))
    if item_id in PHYSICAL_IDS:
        blend_path=os.path.join(BLEND_DIR,f'{item_id}.blend')
        bpy.ops.wm.save_as_mainfile(filepath=blend_path)
        bpy.ops.object.select_all(action='DESELECT')
        for obj in ASSET_OBJECTS:
            obj.select_set(True)
        if ASSET_OBJECTS:
            bpy.context.view_layer.objects.active=ASSET_OBJECTS[0]
            glb_path=os.path.join(GLB_DIR,f'{item_id}.glb')
            bpy.ops.export_scene.gltf(filepath=glb_path,export_format='GLB',use_selection=True,export_apply=True)
    bpy.ops.render.render(write_still=True)
    return {'id':item_id,'name':item['name'],'slot':item['slot'],'preview':preview_path,'physical':item_id in PHYSICAL_IDS}

results=[]
failures=[]
for item in selected_items:
    try:
        result=render_item(item)
        results.append(result)
        print(f"OK {item['id']} -> {result['preview']}")
    except Exception as exc:
        failures.append({'id':item['id'],'error':repr(exc)})
        print(f"FAILED {item['id']}: {exc}")

index={'schema':1,'generatedBy':'Blender 5.2','total':len(selected_items),'completed':len(results),'failed':failures,'items':results}
with open(os.path.join(BLENDER_DIR,'preview-index.json'),'w',encoding='utf-8') as handle:
    json.dump(index,handle,indent=2)
if failures:
    raise RuntimeError(f'{len(failures)} Blender cosmetics failed')
print(f'COMPLETE {len(results)}/{len(selected_items)} Blender previews')
